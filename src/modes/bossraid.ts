import * as CANNON from 'cannon-es';
import type * as THREE from 'three';
import type { ModeCode, TeamId } from '../data/schema';
import {
  ALLY_BOSS_DAMAGE,
  BOSS_CLASS_LETHALITY,
  BOSS_LETHALITY,
  BREACH_COS,
  BREACH_MULTIPLIER,
  BOSS_SELF_DAMAGE,
  KILL_HEAL_FRACTION,
  PLAYER_BOSS_DAMAGE,
  POINTS_PER_DAMAGE,
  bossDamageScale,
  bossSpeedScale,
  phaseFor,
  RAID_PHASES,
  respawnDelayFor,
  type RaidPhase,
} from '../data/raid';
import type { BossController } from '../ai/boss';
import { SquadChannel, SQUAD_LINES } from '../ai/squad';
import type { NavGrid } from '../ai/navgrid';
import { Demolition } from '../game/demolition';
import type { Arena, DamageOptions } from '../game/types';
import type { PhysicsWorld } from '../physics/world';
import type { Tank } from '../entities/tank';
import { BaseMode, type BossStatus, type MinimapMarker, type ModeResult, type ObjectiveHint } from './base';

const TMP_FORWARD = new CANNON.Vec3();

/** Cover-loss marks at which somebody in the squad says something about it. */
const COVER_REMARKS = [0.2, 0.45, 0.7];

/**
 * Everything the raid needs that only exists once the battle has built a world:
 * the colliders and meshes behind the map's props, and the grid the squad
 * navigates. Handed over with the boss, since none of it is knowable when the
 * mode is constructed.
 */
export interface RaidWorld {
  arena: Arena;
  phys: PhysicsWorld;
  nav: NavGrid;
  propBodies: CANNON.Body[];
  propMeshes: THREE.Mesh[];
}

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
 * - Its shells are siege ordnance, sized against armour rather than against
 *   tanks. A light hull comes out of a direct hit on a sliver; a heavy one is
 *   the reason to bring a heavy one.
 * - Every gate it crosses makes it faster and makes its ordnance land harder,
 *   and inside the last phase both keep climbing as the bar empties. The fight
 *   is at its most dangerous in the seconds before it ends.
 * - Its Meteor Storm is not aimed around itself. Fighting inside one is the
 *   fastest damage in the mode and the fastest way to lose the squad.
 * - Nobody runs out of lives. What a death costs is time, and the price climbs
 *   with every death the raid has already taken — while the boss, left alone,
 *   repairs.
 */
export class BossRaidMode extends BaseMode {
  readonly code: ModeCode = 'RAID';
  readonly teams = true;

  private boss: Tank | null = null;
  private bossAi: BossController | null = null;
  private losses = 0;
  private bossDownAt: number | null = null;
  private readonly damageSeen = new Map<number, number>();

  /** The map coming apart, and the squad talking about it. */
  private demolition: Demolition | null = null;
  readonly squad = new SquadChannel(
    () => this.now,
    (text, kind) => this.arena?.notify(text, kind),
  );
  private arena: Arena | null = null;
  private now = 0;
  private markedSeen: Tank | null = null;
  private stillSeen = false;
  private coverRemarked = 0;

  /** Called by the battle once the Overseer and its squad exist. */
  bindBoss(boss: Tank, ai: BossController, world: RaidWorld): void {
    this.boss = boss;
    this.bossAi = ai;
    this.arena = world.arena;
    this.squad.boss = boss;
    this.demolition = new Demolition(this.def, world.propBodies, world.propMeshes, {
      arena: world.arena,
      scene: this.scene,
      phys: world.phys,
      nav: world.nav,
      warn: (x, z, radius, seconds, label) => this.squad.warn(x, z, radius, seconds, label),
    });
  }

  /** The Overseer's ordnance, against the map. Nothing else reshapes it. */
  onBlast(centre: CANNON.Vec3, radius: number, power: number, source: Tank | null): void {
    if (!this.demolition || !this.boss || source !== this.boss) return;
    this.demolition.blast(centre, radius, power);
  }

  /** Structural damage from the Overseer driving through something. */
  demolish(at: CANNON.Vec3, reach: number, power: number): void {
    this.demolition?.ram(at, reach, power);
  }

  get phase(): RaidPhase {
    return phaseFor(this.boss?.healthFraction ?? 1);
  }

  // ---- raid rules -------------------------------------------------------

  /**
   * The damage asymmetry, in one place — both directions. Every number here is
   * quoted in the garage's raid ledger: an advantage the player can read is an
   * advantage that feels earned, and so is a threat.
   */
  override damageScale(
    target: Tank,
    source: Tank | null,
    opts: DamageOptions,
    arena: Arena,
    _amount: number,
  ): number {
    if (!this.boss || !source) return 1;

    // Its own ordnance, landing on it: a rock out of its own storm, a barrage
    // shell, or the blast off a siege round it should not have fired that
    // close. The Overseer is armoured against weapons it designed and takes a
    // reduced share — but it takes one, which is what turns its own splash into
    // a rule it has to fight around rather than a detail. Nothing a raider does
    // reaches this branch, so it has to be caught ahead of the outbound scale.
    if (source === target) return target === this.boss ? BOSS_SELF_DAMAGE : 1;

    // Outbound: siege ordnance. The Overseer's gun was authored to fight tanks
    // and it is besieging them instead, so everything it does lands harder, and
    // hardest of all on the hulls that were never built to take a shell — and
    // harder still the angrier it is, which is the escalation you feel rather
    // than read.
    if (source === this.boss) {
      return (
        BOSS_LETHALITY *
        (BOSS_CLASS_LETHALITY[target.hull.class] ?? 1) *
        bossDamageScale(this.boss.healthFraction)
      );
    }

    if (target !== this.boss) return 1;

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

  /** The squad always comes back. Only the Overseer stays down. */
  override canRespawn(tank: Tank, _arena: Arena): boolean {
    return tank !== this.boss;
  }

  /**
   * What a death costs. The pool is gone — nobody is ever benched — so the
   * price is the walk back, and it lengthens with every loss the raid has taken.
   * A squad that is trading badly spends more and more of the fight in the
   * respawn queue, which is exactly the stretch the boss spends repairing.
   */
  override respawnDelay(tank: Tank, _arena: Arena): number | null {
    if (tank === this.boss) return null;
    return respawnDelayFor(this.losses);
  }

  override onDeath(victim: Tank, arena: Arena): void {
    if (victim === this.boss) {
      this.bossDownAt = arena.time;
      arena.notify(`${victim.name} is down — raid complete`, 'gold');
      return;
    }
    this.losses += 1;
    const wait = respawnDelayFor(this.losses).toFixed(1);
    arena.notify(
      `${victim.isPlayer ? 'You went' : `${victim.name} went`} down — the squad is back in ${wait}s`,
      victim.isPlayer ? 'warning' : 'info',
    );
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
      this.feed(victim, arena);
    }
  }

  /**
   * It feeds.
   *
   * Nobody runs out of lives, so a death used to cost tempo and nothing else —
   * and a death that costs only tempo is a death nobody dreads. So the Overseer
   * takes something for it, and it takes it on the one instrument the entire
   * raid is already staring at: the bar goes *up*.
   *
   * The heal is small. It is not meant to threaten the raid's progress, it is
   * meant to be *watched* — the number that made you flinch when it was your
   * squadmate is the same number that will be yours in four seconds. And like
   * every other heal the boss has it is clamped to the top of the phase it is
   * currently in, so a squad that is dying badly loses ground and morale but can
   * never be pushed back through a gate it has already bought.
   */
  private feed(victim: Tank, arena: Arena): void {
    const boss = this.boss;
    if (!boss || !boss.alive) return;
    const ceiling = boss.maxHealth * this.phase.from;
    const gain = Math.min(boss.maxHealth * KILL_HEAL_FRACTION, ceiling - boss.health);
    if (gain <= 0) return;

    arena.heal(boss, gain, boss);
    arena.fx.supplyBurst(boss.position, 0x86efac, 3.2);
    arena.notify(
      `${boss.name} fed on ${victim.isPlayer ? 'you' : victim.name} — +${Math.round(gain)}`,
      'warning',
    );
  }

  /**
   * Raiders are paid for damage rather than kills — there is only one thing to
   * kill — so a squadmate that holds the boss's attention for two minutes has
   * something to show for it on the scoreboard.
   */
  override update(dt: number, arena: Arena): void {
    if (!this.boss) return;
    this.arena = arena;
    this.now = arena.time;

    this.demolition?.update(dt);
    this.squad.update();
    this.updateSquad(arena);

    for (const t of arena.tanks) {
      if (t === this.boss) continue;
      const seen = this.damageSeen.get(t.id);
      this.damageSeen.set(t.id, t.damageDealt);
      if (seen === undefined || t.damageDealt <= seen) continue;
      t.addBattlePoints((t.damageDealt - seen) * POINTS_PER_DAMAGE);
    }
  }

  /**
   * What the squad knows and what it says about it.
   *
   * The bots own two calls themselves, because they are the two that are
   * actions the bot is taking — clearing a ring, and turning round to break a
   * hunt. Everything here is the other kind: an observation about the fight
   * that no single squadmate is in a position to make, spoken by whoever
   * happens to be closest to it. Keeping the split that way is what stops
   * bot.ts having to learn what a boss is.
   */
  private updateSquad(arena: Arena): void {
    const ai = this.bossAi;
    if (!ai) return;

    // The hunt. Published to the channel rather than inferred, because the
    // rescue is the one thing in this mode that has to be *chosen* — a squad
    // that only ever breaks a mark by accident is a squad the marked raider
    // cannot count on, and the HUD promises them they can.
    const marked = ai.marked;
    this.squad.rescue = marked ?? null;
    if (marked && marked !== this.markedSeen && !marked.isPlayer) {
      this.squad.say(marked, 'marked', SquadChannel.line([...SQUAD_LINES.marked], marked.id));
    }
    this.markedSeen = marked ?? null;

    // The stillness — the beat where the Overseer stops dead before an ability
    // lands. It is the fairest window in the fight and it was, until now,
    // something only a human noticed. A squadmate calling it is how a raid
    // learns the tell exists.
    const still = ai.stilled;
    if (still && !this.stillSeen) {
      const speaker = this.nearestAlly(arena, this.boss!.position);
      if (speaker) this.squad.say(speaker, 'push', SquadChannel.line([...SQUAD_LINES.push], speaker.id));
    }
    this.stillSeen = still;

    // And the map going away underneath everybody.
    const lost = this.demolition?.coverLost ?? 0;
    while (this.coverRemarked < COVER_REMARKS.length && lost >= COVER_REMARKS[this.coverRemarked]) {
      this.coverRemarked += 1;
      const speaker = this.nearestAlly(arena, this.boss!.position);
      if (speaker) this.squad.say(speaker, 'cover', SquadChannel.line([...SQUAD_LINES.cover], speaker.id));
    }
  }

  /** Whichever squadmate is closest to a point, for a line that needs a voice. */
  private nearestAlly(arena: Arena, to: CANNON.Vec3): Tank | null {
    let best: Tank | null = null;
    let bestDist = Infinity;
    for (const t of arena.tanks) {
      if (t === this.boss || t.isPlayer || !t.alive) continue;
      const d = t.position.distanceTo(to);
      if (d < bestDist) {
        bestDist = d;
        best = t;
      }
    }
    return best;
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
      losses: this.losses,
      respawnDelay: respawnDelayFor(this.losses),
      enraged: phase.enraged === true,
      speedScale: bossSpeedScale(this.boss.healthFraction),
      damageScale: bossDamageScale(this.boss.healthFraction),
      telegraph: this.bossAi?.telegraphName ?? null,
      telegraphProgress: this.bossAi?.telegraphProgress ?? 0,
      markedName: this.bossAi?.marked?.name ?? null,
      markedPlayer: !!player && this.bossAi?.marked === player,
      markRemaining: this.bossAi?.markRemaining ?? 0,
      markBreak: this.bossAi?.markBreakProgress ?? 0,
      dread: this.bossAi?.dreadLevel ?? 0,
      coverLost: this.demolition?.coverLost ?? 0,
      structuresDown: this.demolition?.structuresDown ?? 0,
    };
  }

  override dispose(): void {
    this.demolition?.dispose();
    this.demolition = null;
  }

  /** Short: the boss bar below the clock already carries the detail. */
  override hudLine(_playerTeam: TeamId, _arena: Arena): string {
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

    // A wipe is no longer a loss — the squad always comes back. The only way
    // the Overseer wins is by still being standing when the clock runs out,
    // which is what makes every second spent dead expensive.
    if (elapsed >= arena.settings.timeLimit) {
      return { over: true, winner: this.boss.name, reason: 'The Overseer held out' };
    }
    return { over: false };
  }
}
