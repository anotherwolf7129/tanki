import * as CANNON from 'cannon-es';
import type { ModeCode, TeamId } from '../data/schema';
import {
  ALLY_BOSS_DAMAGE,
  BREACH_COS,
  BREACH_MULTIPLIER,
  PLAYER_BOSS_DAMAGE,
  POINTS_PER_DAMAGE,
  phaseFor,
  RAID_PHASES,
  reinforcementsFor,
  type RaidPhase,
} from '../data/raid';
import type { BossController } from '../ai/boss';
import type { Arena, DamageOptions } from '../game/types';
import type { Tank } from '../entities/tank';
import { BaseMode, type BossStatus, type MinimapMarker, type ModeResult, type ObjectiveHint } from './base';

const TMP_FORWARD = new CANNON.Vec3();

/**
 * Boss Raid. One Overseer against you and a squad of allied bots.
 *
 * Everything that makes the mode work is an asymmetry, and all of them live
 * here so they can be read together:
 *
 * - You do double damage to the boss; your squadmates do rather less than
 *   theirs. You are the raid's damage.
 * - The boss picks its target by accumulated damage, so being the damage is
 *   what puts you under the gun. Trading that attention with the squad is the
 *   loop the mode is built on.
 * - Direct hits on the boss's engine deck — the rear arc — land for half again.
 *   It knows this, keeps its back to walls and turns to face whoever hurts it
 *   most, so a breach is a manoeuvre rather than an accident.
 * - Deaths come out of one shared reinforcement pool. Spend it and the dead
 *   stay dead; lose everyone and the raid is over.
 */
export class BossRaidMode extends BaseMode {
  readonly code: ModeCode = 'RAID';
  readonly teams = true;

  private boss: Tank | null = null;
  private bossAi: BossController | null = null;
  private reinforcements = 0;
  private readonly down = new Set<number>();
  private bossDownAt: number | null = null;
  private readonly damageSeen = new Map<number, number>();

  /** Called by the battle once the Overseer and its squad exist. */
  bindBoss(boss: Tank, ai: BossController, allyCount: number): void {
    this.boss = boss;
    this.bossAi = ai;
    this.reinforcements = reinforcementsFor(allyCount);
  }

  get phase(): RaidPhase {
    return phaseFor(this.boss?.healthFraction ?? 1);
  }

  // ---- raid rules -------------------------------------------------------

  /**
   * The damage asymmetry, in one place. Every number here is quoted in the
   * garage's raid ledger — an advantage the player can read is an advantage
   * that feels earned.
   */
  override damageScale(target: Tank, source: Tank | null, opts: DamageOptions, arena: Arena): number {
    if (!this.boss || target !== this.boss || !source || source === target) return 1;

    let scale = source.isPlayer ? PLAYER_BOSS_DAMAGE : ALLY_BOSS_DAMAGE;

    // Engine deck. Splash reports the victim's own centre as its impact point,
    // so only a direct hit can find the rear arc — you have to actually be there.
    if ((opts.kind ?? 'direct') === 'direct' && opts.at && this.inRearArc(this.boss, opts.at)) {
      scale *= BREACH_MULTIPLIER;
      if (source.isPlayer) arena.fx.impact(opts.at, new CANNON.Vec3(0, 1, 0), 0xfbbf24, 1.5);
    }
    return scale;
  }

  private inRearArc(boss: Tank, at: CANNON.Vec3): boolean {
    const forward = boss.vehicle.forwardVector(TMP_FORWARD);
    const dx = at.x - boss.position.x;
    const dz = at.z - boss.position.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) return false;
    return (dx * forward.x + dz * forward.z) / len < BREACH_COS;
  }

  override canRespawn(tank: Tank, _arena: Arena): boolean {
    if (tank === this.boss) return false;
    return !this.down.has(tank.id);
  }

  override onDeath(victim: Tank, arena: Arena): void {
    if (victim === this.boss) {
      this.bossDownAt = arena.time;
      arena.notify(`${victim.name} is down — raid complete`, 'gold');
      return;
    }
    if (this.reinforcements > 0) {
      this.reinforcements -= 1;
      arena.notify(
        `${victim.isPlayer ? 'You went' : `${victim.name} went`} down — ${this.reinforcements} reinforcements left`,
        this.reinforcements <= 2 ? 'warning' : 'info',
      );
      return;
    }
    this.down.add(victim.id);
    arena.notify(`${victim.isPlayer ? 'You are' : `${victim.name} is`} out of the fight`, 'warning');
  }

  override onKill(killer: Tank | null, victim: Tank, arena: Arena): void {
    if (victim === this.boss) {
      // The whole squad banks the kill; the killing blow is worth a little more.
      for (const t of arena.tanks) {
        if (t === victim) continue;
        t.addBattlePoints(t === killer ? 90 : 45);
        t.crystals += t === killer ? 60 : 30;
      }
      if (killer && killer !== victim) killer.kills += 1;
      return;
    }
    if (killer && killer === this.boss) {
      killer.kills += 1;
      killer.addBattlePoints(10);
      victim.score = Math.max(0, victim.score - 5);
    }
  }

  /**
   * Raiders are paid for damage rather than kills — there is only one thing to
   * kill — so a squadmate that holds the boss's attention for two minutes has
   * something to show for it on the scoreboard.
   */
  override update(_dt: number, arena: Arena): void {
    if (!this.boss) return;
    for (const t of arena.tanks) {
      if (t === this.boss) continue;
      const seen = this.damageSeen.get(t.id);
      this.damageSeen.set(t.id, t.damageDealt);
      if (seen === undefined || t.damageDealt <= seen) continue;
      t.addBattlePoints((t.damageDealt - seen) * POINTS_PER_DAMAGE);
    }
  }

  /**
   * Distance decides how hard this overrides persona. Far away it is weighted
   * past the behaviour tree's "critical objective" threshold, so a squadmate
   * that has lost the boss stops contesting supply boxes and goes to find it —
   * on a large map, a squad that never converges is a fight that never happens.
   *
   * In contact it drops back below that threshold and the bot fights the way its
   * persona wants to, at its own standoff. A squad ordered to charge a nine-metre
   * blast radius does not last long enough to be a squad.
   */
  override objectiveFor(bot: Tank, _arena: Arena): ObjectiveHint | null {
    if (!this.boss || !this.boss.alive || bot === this.boss) return null;
    const far = bot.position.distanceTo(this.boss.position) > 70;
    return { pos: this.boss.position.clone(), kind: 'attack', weight: far ? 0.95 : 0.5 };
  }

  /** No score race here — the boss's health bar is the score. */
  override teamScores(): Record<'red' | 'blue', number> | null {
    return null;
  }

  override markers(): MinimapMarker[] {
    if (!this.boss || !this.boss.alive) return [];
    // Always drawn, unlike a normal contact: losing a boss this size on the
    // minimap would be a UI failure rather than a stealth mechanic.
    return [
      {
        x: this.boss.position.x,
        z: this.boss.position.z,
        colour: 0xe0483c,
        shape: 'ring',
        label: 'BOSS',
        progress: this.boss.healthFraction,
      },
    ];
  }

  override bossStatus(arena: Arena): BossStatus | null {
    if (!this.boss) return null;
    const player = arena.tanks.find((t) => t.isPlayer) ?? null;
    const phase = this.phase;
    return {
      name: this.boss.name,
      health: Math.max(0, this.boss.health),
      maxHealth: this.boss.maxHealth,
      healthFraction: this.boss.alive ? this.boss.healthFraction : 0,
      phase: phase.index,
      phaseName: phase.name,
      phaseMarks: RAID_PHASES.filter((p) => p.from < 1).map((p) => p.from),
      targetingPlayer: !!player && this.bossAi?.target === player,
      playerThreat: player && this.bossAi ? this.bossAi.threatShare(player) : 0,
      reinforcements: this.reinforcements,
      telegraph: this.bossAi?.telegraphName ?? null,
      telegraphProgress: this.bossAi?.telegraphProgress ?? 0,
      playerOut: !!player && this.down.has(player.id),
    };
  }

  /** Short: the boss bar below the clock already carries the detail. */
  override hudLine(_playerTeam: TeamId): string {
    if (!this.boss) return 'Boss Raid';
    const phase = this.phase;
    return `Phase ${phase.index} · ${phase.name}`;
  }

  result(elapsed: number, arena: Arena): ModeResult {
    if (!this.boss) return { over: false };

    if (this.bossDownAt != null) {
      const mm = Math.floor(elapsed / 60);
      const ss = Math.floor(elapsed % 60);
      return {
        over: true,
        winner: 'The raid',
        reason: `${this.boss.name} destroyed in ${mm}:${ss.toString().padStart(2, '0')}`,
      };
    }

    const standing = arena.tanks.some((t) => t !== this.boss && t.alive);
    if (!standing && this.reinforcements <= 0) {
      return { over: true, winner: this.boss.name, reason: 'Raid wiped' };
    }

    if (elapsed >= arena.settings.timeLimit) {
      return { over: true, winner: this.boss.name, reason: 'The Overseer held out' };
    }
    return { over: false };
  }
}
