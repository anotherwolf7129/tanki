import * as CANNON from 'cannon-es';
import * as THREE from 'three';
import { hull as hullDef, turret as turretDef } from '../data';
import { augmentFor, randomAugmentFor, type AugmentDef } from '../data/augments';
import { droneFor } from '../data/drones';
import { DIFFICULTIES, DynamicDifficulty, LAST_HIT_COOLDOWN, LAST_HIT_FLOOR, type DifficultyProfile } from '../data/difficulty';
import { map as mapDef } from '../data/maps';
import type { BattleSettings } from '../data/modes';
import type { MapDef, TeamId, TurretDef } from '../data/schema';
import {
  ALLY_HULL_MULTIPLIER,
  BOSS_ARMOR_KITS,
  BOSS_DAMAGE_KITS,
  BOSS_HULL,
  BOSS_HULL_AUGMENT,
  BOSS_NAME,
  BOSS_REPAIR_KITS,
  BOSS_TURRET,
  BOSS_TURRET_AUGMENT,
  bossHealth,
  phaseFor,
} from '../data/raid';
import { PLAYER_SUPPLY_STOCK, SELF_DESTRUCT_TIME, SUPPLY_ORDER } from '../data/supplies';
import { BossController } from '../ai/boss';
import { BotController } from '../ai/bot';
import { NavGrid } from '../ai/navgrid';
import { PERSONAS, BOT_NAMES, raidRosterFor, rosterFor } from '../ai/personas';
import { TeamBoard } from '../ai/teamboard';
import { angleDelta, ballisticPitch, clamp, damp, DEG, predictIntercept, shuffled } from '../core/mathx';
import type { InputState } from '../core/input';
import { MineSystem, PickupSystem } from '../entities/pickup';
import { ProjectileSystem } from '../entities/projectile';
import { Tank } from '../entities/tank';
import { PhysicsWorld, WORLD_MASK, type MapBodies } from '../physics/world';
import { ChaseCamera } from '../render/camera';
import { Effects } from '../render/effects';
import { createScene, type SceneBundle } from '../render/scene';
import { pruneChassisCache } from '../render/tankmesh';
import { BossRaidMode } from '../modes/bossraid';
import { CaptureFlagMode } from '../modes/captureflag';
import { ControlPointsMode } from '../modes/controlpoints';
import { DeathmatchMode } from '../modes/deathmatch';
import { TeamDeathmatchMode } from '../modes/teamdeathmatch';
import type { BossStatus, ModeController } from '../modes/base';
import { OverdriveSystem } from './overdrive';
import type { Arena, DamageKind, DamageOptions, Notification, ProjectileSpawn } from './types';

export interface PlayerLoadout {
  hull: string;
  turret: string;
  name: string;
  /**
   * Fitted augment per item, keyed by hull or turret id. Keyed by item rather
   * than by slot so swapping hulls in the garage does not throw away the
   * augment you had picked for the one you are coming back to.
   */
  augments?: Record<string, string>;
  /**
   * Fitted drone, or null for none. Not keyed per item like the augments: a
   * drone modifies supplies, which are the same whatever you are driving.
   */
  drone?: string | null;
}

const RESPAWN_TIME = 3;

/** Seconds between one ram-augment shunt and the next. */
const RAM_COOLDOWN = 1.1;

/** Half-width, in metres, of the corridor auto-aim will lock a target inside. */
const LOCK_WIDTH = 5.5;

/** Everything the HUD needs, gathered once per frame. */
export interface BattleSnapshot {
  player: Tank;
  elapsed: number;
  timeLimit: number;
  modeCode: string;
  modeLine: string;
  notifications: Notification[];
  scoreboard: Tank[];
  teamScores: Record<'red' | 'blue', number> | null;
  selfDestruct: number | null;
  boss: BossStatus | null;
  /** Tank the camera is on, which is not the player once they are out. */
  viewing: Tank;
  over: boolean;
  winner?: string;
  reason?: string;
}

/**
 * Conditional damage from the attacker's turret augment. Every one of these is
 * a bonus for setting the shot up rather than for taking it, which is why they
 * are resolved against the target's state at the moment of impact.
 */
function augmentStrikeScale(source: Tank, target: Tank): number {
  const t = source.traits;
  let scale = 1;
  if (t.bonusVsBurning && target.status.has('burning')) scale *= 1 + t.bonusVsBurning;
  if (t.bonusVsFrozen && target.status.has('freezing')) scale *= 1 + t.bonusVsFrozen;
  if (t.execute && target.healthFraction <= t.execute.below) scale *= 1 + t.execute.bonus;
  return scale;
}

export class Battle implements Arena {
  readonly phys: PhysicsWorld;
  readonly tanks: Tank[] = [];
  readonly fx: Effects;
  readonly camera: ChaseCamera;
  readonly settings: BattleSettings;
  readonly def: MapDef;
  readonly profile: DifficultyProfile;

  private readonly bundle: SceneBundle;
  private readonly mapBodies: MapBodies;
  private readonly nav: NavGrid;
  private readonly projectiles: ProjectileSystem;
  private readonly pickups: PickupSystem;
  private readonly mines: MineSystem;
  private readonly overdrives: OverdriveSystem;
  private readonly mode: ModeController;
  private readonly boards: Record<'red' | 'blue' | 'free', TeamBoard>;
  private readonly dynamic: DynamicDifficulty;
  private readonly bodyIndex = new Map<CANNON.Body, Tank>();
  private readonly notifications: Notification[] = [];

  readonly player: Tank;
  /** The Overseer, in Boss Raid only. */
  readonly boss: Tank | null = null;
  time = 0;
  private elapsed = 0;
  private finished: { winner?: string; reason?: string } | null = null;
  private selfDestructTimer: number | null = null;
  private readonly spawnCursor: Record<TeamId, number> = { red: 0, blue: 0, free: 0 };

  constructor(settings: BattleSettings, loadout: PlayerLoadout, aspect: number) {
    this.settings = settings;
    this.def = mapDef(settings.mapId);
    this.profile = DIFFICULTIES[settings.difficulty] ?? DIFFICULTIES.standard;
    this.dynamic = new DynamicDifficulty(this.profile);

    this.phys = new PhysicsWorld(this.def.gravityScale);
    this.mapBodies = this.phys.buildMap(this.def);
    this.bundle = createScene(this.def);
    this.fx = new Effects(this.bundle.scene);
    this.camera = new ChaseCamera(aspect, this.phys);
    this.nav = new NavGrid(this.phys, this.def);
    this.projectiles = new ProjectileSystem(this.bundle.scene);
    this.mines = new MineSystem(this.bundle.scene);
    this.overdrives = new OverdriveSystem(this.bundle.scene);
    this.pickups = new PickupSystem(
      this.bundle.scene,
      this.def,
      settings.suppliesEnabled,
      settings.goldBoxEnabled,
      settings.mode === 'DM',
    );

    this.boards = {
      red: new TeamBoard('red'),
      blue: new TeamBoard('blue'),
      free: new TeamBoard('free'),
    };

    this.mode = this.createMode();

    const teamed = this.mode.teams;
    const playerTeam: TeamId = teamed ? 'blue' : 'free';
    this.player = this.spawnTank({
      name: loadout.name || 'You',
      team: playerTeam,
      isPlayer: true,
      hullId: loadout.hull,
      turretId: loadout.turret,
      hullAugmentId: loadout.augments?.[loadout.hull],
      turretAugmentId: loadout.augments?.[loadout.turret],
      droneId: loadout.drone,
    });

    if (this.mode instanceof BossRaidMode) {
      this.boss = this.spawnRaid(this.mode);
    } else {
      this.spawnBots(teamed, playerTeam);
    }

    // The player starts with a full field stock of every kind, so supplies are
    // a tactic for the whole battle rather than three of each spent in the
    // first engagement. Bots are stocked as before — this is the player's edge,
    // and it is listed with the rest of them in the setup screen.
    for (const kind of SUPPLY_ORDER) {
      this.player.giveSupply(kind, PLAYER_SUPPLY_STOCK);
      for (const bot of this.tanks) {
        if (bot.isPlayer || bot.isBoss) continue;
        // A raid squad is stocked properly: it is meant to survive a boss fight,
        // not trade evenly with the tank next to it.
        if (this.settings.mode === 'RAID') bot.giveSupply(kind, 2);
        else if (Math.random() < 0.5) bot.giveSupply(kind, 1);
      }
    }
  }

  get scene(): THREE.Scene {
    return this.bundle.scene;
  }

  get playerCount(): number {
    return this.tanks.length;
  }

  private createMode(): ModeController {
    switch (this.settings.mode) {
      case 'RAID':
        return new BossRaidMode(this.def, this.bundle.scene);
      case 'TDM':
        return new TeamDeathmatchMode(this.def, this.bundle.scene);
      case 'CTF':
        return new CaptureFlagMode(this.def, this.bundle.scene);
      case 'CP':
        return new ControlPointsMode(this.def, this.bundle.scene);
      default:
        return new DeathmatchMode(this.def, this.bundle.scene);
    }
  }

  // ---- spawning ---------------------------------------------------------

  private spawnBots(teamed: boolean, playerTeam: TeamId): void {
    const count = this.settings.botCount;
    const personas = shuffled(rosterFor(count));
    const names = shuffled(BOT_NAMES);

    for (let i = 0; i < count; i++) {
      const persona = PERSONAS[personas[i]];
      const team: TeamId = teamed ? (i % 2 === 0 ? 'red' : playerTeam === 'blue' ? 'blue' : 'red') : 'free';
      const bot = this.spawnTank({
        name: names[i % names.length],
        team,
        isPlayer: false,
        hullId: persona.hull,
        turretId: persona.turret,
        hullAugmentId: this.botAugment('hull', persona.hull, persona.hullAugment),
        turretAugmentId: this.botAugment('turret', persona.turret, persona.turretAugment),
      });
      bot.ai = new BotController(bot, persona, {
        arena: this,
        nav: this.nav,
        board: this.boards[team],
        profile: this.profile,
        slack: () => this.dynamic.slack,
        nearestPickup: (from) => this.pickups.nearest(from),
        objective: (self) => this.mode.objectiveFor(self, this),
      });
    }
  }

  /**
   * The raid: an allied squad on the player's team and one Overseer opposite.
   * Returns the boss.
   */
  private spawnRaid(mode: BossRaidMode): Tank {
    const allies = this.settings.botCount;
    const personas = raidRosterFor(allies);
    const names = shuffled(BOT_NAMES);

    for (let i = 0; i < allies; i++) {
      const persona = PERSONAS[personas[i]];
      const ally = this.spawnTank({
        name: names[i % names.length],
        team: this.player.team,
        isPlayer: false,
        hullMultiplier: ALLY_HULL_MULTIPLIER,
        hullId: persona.hull,
        turretId: persona.turret,
        hullAugmentId: this.botAugment('hull', persona.hull, persona.hullAugment),
        turretAugmentId: this.botAugment('turret', persona.turret, persona.turretAugment),
      });
      ally.ai = new BotController(ally, persona, {
        arena: this,
        nav: this.nav,
        board: this.boards[ally.team],
        profile: this.profile,
        slack: () => this.dynamic.slack,
        nearestPickup: (from) => this.pickups.nearest(from),
        objective: (self) => this.mode.objectiveFor(self, this),
        // The raid's shared channel. It is the only thing separating a squad
        // from four bots that happen to be shooting the same target.
        squad: mode.squad,
      });
    }

    const boss = this.spawnTank({
      name: BOSS_NAME,
      team: this.player.team === 'blue' ? 'red' : 'blue',
      isPlayer: false,
      isBoss: true,
      hullId: BOSS_HULL,
      turretId: BOSS_TURRET,
      // The Overseer's fittings are authored rather than rolled: the raid is
      // balanced against exactly this boss, and a random augment on top of the
      // raid's health pool is the difference between a hard fight and an
      // unwinnable one.
      hullAugmentId: BOSS_HULL_AUGMENT,
      turretAugmentId: BOSS_TURRET_AUGMENT,
    });
    // The boss sits outside the equipment gap entirely: its pool is authored for
    // the size of the squad, not derived from a tier multiplier.
    boss.maxHealth = bossHealth(allies, this.profile.bot.hullTierMultiplier);
    boss.health = boss.maxHealth;

    const ai = new BossController(boss, {
      arena: this,
      nav: this.nav,
      profile: this.profile,
      phase: () => phaseFor(boss.healthFraction),
      nearestSupply: (from, kinds) => this.pickups.nearest(from, kinds),
      warn: (x, z, radius, seconds, label) => mode.squad.warn(x, z, radius, seconds, label),
      demolish: (at, reach, power) => mode.demolish(at, reach, power),
    });
    boss.ai = ai;
    mode.bindBoss(boss, ai, {
      arena: this,
      phys: this.phys,
      nav: this.nav,
      propBodies: this.mapBodies.props,
      propMeshes: this.bundle.props,
    });

    // It fights with supplies like everyone else. A finite stock, so a raid that
    // keeps the pressure on eventually spends them for it — and once they are
    // gone the only kits left are the ones on the floor, which it will come out
    // of position to take.
    boss.giveSupply('repair', BOSS_REPAIR_KITS);
    boss.giveSupply('armor', BOSS_ARMOR_KITS);
    boss.giveSupply('damage', BOSS_DAMAGE_KITS);

    this.notify(`${BOSS_NAME} is on the field — bring it down`, 'warning');
    return boss;
  }

  private spawnTank(spec: {
    name: string;
    team: TeamId;
    isPlayer: boolean;
    isBoss?: boolean;
    /** Overrides the difficulty profile's hull tier, for raid squadmates. */
    hullMultiplier?: number;
    hullId: string;
    turretId: string;
    hullAugmentId?: string | null;
    turretAugmentId?: string | null;
    droneId?: string | null;
  }): Tank {
    const h = hullDef(spec.hullId);
    const t = turretDef(h.fixedTurret ?? spec.turretId);
    const p = spec.isPlayer ? this.profile.player : this.profile.bot;
    const spawn = this.pickSpawn(spec.team);

    const tank = new Tank(
      {
        id: this.tanks.length,
        name: spec.name,
        team: spec.team,
        isPlayer: spec.isPlayer,
        isBoss: spec.isBoss,
        hull: h,
        turret: t,
        hullAugment: augmentFor('hull', h.id, spec.hullAugmentId),
        turretAugment: augmentFor('turret', t.id, spec.turretAugmentId),
        drone: droneFor(spec.droneId),
        hullMultiplier: spec.isBoss ? 1 : (spec.hullMultiplier ?? p.hullTierMultiplier),
        turretMultiplier: spec.isBoss ? 1 : p.turretTierMultiplier,
        spawnProtection: p.spawnProtection,
        overdriveChargeRate: spec.isBoss ? 1 : p.overdriveChargeRate,
      },
      this.phys,
      this.bundle.scene,
      spawn,
    );
    this.tanks.push(tank);
    this.bodyIndex.set(tank.vehicle.body, tank);
    return tank;
  }

  /**
   * What a bot brings fitted. Personas name the augment that matches how they
   * fight — a Bruiser wants its Vulcan setting people on fire — but a minority
   * of them roll something else instead, so a persona reads as a build the enemy
   * usually runs rather than as a fixed serial number.
   *
   * Whether bots get augments at all is part of the equipment gap: on Recruit
   * they fight with the bare item, and the garage says so.
   */
  private botAugment(slot: 'hull' | 'turret', item: string, preferred?: string): string | null {
    if (!this.profile.bot.augments) return null;
    const signature = augmentFor(slot, item, preferred);
    const chosen: AugmentDef | null =
      signature && Math.random() < 0.7 ? signature : (randomAugmentFor(slot, item) ?? signature);
    return chosen?.id ?? null;
  }

  /** Round-robin through the team's spawn list, avoiding occupied points. */
  private pickSpawn(team: TeamId): { pos: CANNON.Vec3; yaw: number } {
    const list = this.def.spawns[team]?.length ? this.def.spawns[team] : this.def.spawns.free;
    let best = list[0];
    let bestScore = -Infinity;
    for (let i = 0; i < list.length; i++) {
      const s = list[(this.spawnCursor[team] + i) % list.length];
      const p = new CANNON.Vec3(s.pos[0], s.pos[1], s.pos[2]);
      let score = Math.random() * 4;
      for (const t of this.tanks) {
        if (!t.alive) continue;
        const d = t.position.distanceTo(p);
        // Never drop a player on top of an enemy; allies matter much less.
        score += this.areEnemiesTeam(team, t.team) ? Math.min(d, 90) : Math.min(d, 20) * 0.15;
      }
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    this.spawnCursor[team] = (this.spawnCursor[team] + 1) % list.length;
    const surface = this.nav.surfaceHeight(best.pos[0], best.pos[2]);
    return {
      pos: new CANNON.Vec3(best.pos[0], Math.max(best.pos[1], surface) + 2.2, best.pos[2]),
      yaw: best.yaw * DEG,
    };
  }

  // ---- Arena implementation --------------------------------------------

  tankForBody(body: CANNON.Body): Tank | null {
    return this.bodyIndex.get(body) ?? null;
  }

  teamOf(tank: Tank): TeamId {
    return tank.team;
  }

  private areEnemiesTeam(a: TeamId, b: TeamId): boolean {
    if (a === 'free' || b === 'free') return true;
    return a !== b;
  }

  areEnemies(a: Tank, b: Tank): boolean {
    if (a === b) return false;
    return this.areEnemiesTeam(a.team, b.team);
  }

  areAllies(a: Tank, b: Tank): boolean {
    if (a === b) return true;
    if (a.team === 'free' || b.team === 'free') return false;
    return a.team === b.team;
  }

  /**
   * The single damage funnel. Every player-advantage rule that touches numbers
   * lives here so the asymmetry is auditable in one place.
   */
  damage(target: Tank, amount: number, source: Tank | null, opts: DamageOptions = {}): number {
    if (!target.alive || amount <= 0 || this.finished) return 0;
    const kind = opts.kind ?? 'direct';
    const selfInflicted = source === target;

    if (target.spawnProtection > 0 && !selfInflicted) return 0;
    if (source && !selfInflicted && this.areAllies(source, target) && !this.settings.friendlyFire) return 0;

    let dmg = amount;
    if (!opts.ignoreArmor) dmg *= target.status.damageTakenScale * (target.traits.damageTaken ?? 1);
    // Conditional turret bonuses ride on shots, not on the burn a shot left
    // behind — otherwise a finisher augment would quietly boost its own fire.
    if (source && !selfInflicted && (kind === 'direct' || kind === 'splash')) {
      dmg *= augmentStrikeScale(source, target);
    }
    dmg *= 1 - target.damageReduction;
    // Mode-specific reshaping — in Boss Raid this is the player's damage edge
    // over the squad, the engine-deck breach bonus, and the boss's siege
    // ordnance on the way back.
    dmg *= this.mode.damageScale(target, source, opts, this, amount);
    if (source?.isPlayer && !selfInflicted) dmg *= this.profile.player.damageDealtMultiplier;
    if (target.isPlayer) dmg *= this.profile.player.damageTakenMultiplier;

    // Rounding in the player's favour, both directions.
    if (source?.isPlayer && !target.isPlayer) dmg = Math.ceil(dmg);
    else if (target.isPlayer) dmg = Math.floor(dmg);

    if (dmg <= 0) return 0;

    // Last-hit protection: never surfaced in the UI, on a long cooldown.
    if (
      target.isPlayer &&
      this.profile.player.lastHitProtection &&
      target.health - dmg <= 0 &&
      target.healthFraction > LAST_HIT_FLOOR * 1.5 &&
      this.time - target.lastHitProtectionAt > LAST_HIT_COOLDOWN
    ) {
      target.lastHitProtectionAt = this.time;
      dmg = target.health - target.maxHealth * LAST_HIT_FLOOR;
    }

    target.health -= dmg;
    target.interruptHeal();
    if (selfInflicted) target.selfDamageTaken += dmg;
    if (source && !selfInflicted) {
      target.lastAttacker = source;
      target.lastAttackedAt = this.time;
      source.damageDealt += dmg;
    }

    const at = opts.at ?? target.centre();
    if (source?.isPlayer && !selfInflicted) {
      this.fx.damageNumber(at, dmg, opts.critical ? '#fbbf24' : '#ffffff');
    } else if (target.isPlayer) {
      this.fx.shake = Math.min(1.4, this.fx.shake + clamp(dmg / target.maxHealth, 0, 0.5) * 2.2);
    }
    if (kind !== 'burn') this.fx.impact(at, new CANNON.Vec3(0, 1, 0), opts.critical ? 0xfbbf24 : 0xff5555, 0.6);

    if (source && !selfInflicted) this.resolveAugmentHit(target, source, dmg, kind);

    if (target.health <= 0) this.destroy(target, source);
    return dmg;
  }

  /**
   * Everything an augment does *because* a hit landed: the effects a gun leaves
   * behind it, the health a vampiric beam takes back, and the fragments a lined
   * hull sheds into whoever shot it.
   *
   * It lives at the bottom of the damage funnel rather than in each firing mode
   * so a burn rides on whatever put the damage through — a shell, a blast, a
   * beam tick — instead of on the one archetype somebody remembered to wire.
   */
  private resolveAugmentHit(target: Tank, source: Tank, dmg: number, kind: DamageKind): void {
    // Only weapons ignite, not burns ticking or the ram they set up.
    const struck = kind === 'direct' || kind === 'splash';
    if (!struck || !this.areEnemies(source, target)) return;

    if (target.health > 0) {
      const t = source.traits;
      const ignite = t.ignite;
      // Vulcan's Ignition: nothing at all until the barrel is in the red, and
      // then a burn heavy enough to finish the job on its own.
      if (ignite && (!ignite.whenOverheated || source.weapon.overheated)) {
        target.status.apply('burning', ignite.dps, ignite.duration, source.id);
        target.status.remove('freezing');
      }
      if (t.chill) {
        target.status.apply('freezing', t.chill.magnitude, t.chill.duration, source.id);
        target.status.remove('burning');
      }
      if (t.disrupt && Math.random() < t.disrupt.chance) {
        target.status.apply('emp', 1, t.disrupt.duration, source.id);
      }
      if (t.lifesteal) this.heal(source, dmg * t.lifesteal, source);
    }

    // Spall goes back down the line of fire as contact damage, which is what
    // keeps it from reflecting off itself for ever.
    const thorns = target.traits.thorns;
    if (thorns && source.alive) this.damage(source, dmg * thorns, target, { kind: 'contact' });
  }

  /**
   * Ram augments. A shunt is a real attack for the hulls built around it, so it
   * scales with how fast the impact actually was and is rate-limited — otherwise
   * "touching an enemy" would deal damage sixty times a second.
   */
  private updateRamAugments(): void {
    for (const tank of this.tanks) {
      const ram = tank.traits.ram;
      if (!ram || !tank.alive) continue;
      if (tank.ramCooldown > 0) continue;
      const speed = Math.hypot(tank.velocity.x, tank.velocity.z);
      if (speed < ram.minSpeed) continue;

      for (const other of this.tanks) {
        if (other === tank || !other.alive || !this.areEnemies(tank, other)) continue;
        const reach = (tank.hull.size[2] + other.hull.size[2]) * 0.6;
        if (tank.position.distanceTo(other.position) > reach) continue;

        const force = clamp(speed / Math.max(1, tank.hull.topSpeed), 0.4, 1.4);
        this.damage(other, ram.damage * force, tank, { kind: 'contact' });
        const push = other.position.vsub(tank.position);
        push.y = 0.4;
        push.normalize();
        other.vehicle.applyImpulse(push, 1.2 * force);
        tank.ramCooldown = RAM_COOLDOWN;
        break;
      }
    }
  }

  /**
   * One healing funnel, for the same reason damage has one.
   *
   * The raid boss is clamped to the top of the phase it is currently in, and
   * that clamp lives here rather than at each call site so that *every* way it
   * can gain health — regeneration, its own repair kits, a box off the floor,
   * Purge — obeys it. A gate the raid has pushed the Overseer through is
   * permanent, so a long fight is always progress even when it is going badly.
   */
  heal(target: Tank, amount: number, _source: Tank | null): number {
    if (!target.alive || amount <= 0) return 0;
    const before = target.health;
    const ceiling = target.isBoss
      ? target.maxHealth * phaseFor(target.healthFraction).from
      : target.maxHealth;
    target.health = Math.min(Math.max(before, ceiling), target.health + amount);
    return target.health - before;
  }

  splash(
    centre: CANNON.Vec3,
    radius: number,
    damageMax: number,
    damageMin: number,
    source: Tank | null,
    opts: { selfDamage: boolean; impactForce: number; turret?: TurretDef },
  ): void {
    // Every blast in the game already comes through here, which makes this the
    // one place a mode can be told the world was hit as well as the tanks in
    // it. Boss Raid is the only taker: the Overseer's ordnance takes the map
    // apart, and nothing a raider fires does.
    this.mode.onBlast?.(centre, radius, damageMax, source);

    for (const tank of this.tanks) {
      if (!tank.alive) continue;
      if (tank === source && !opts.selfDamage) continue;
      const to = tank.centre();
      const dist = to.distanceTo(centre);
      if (dist > radius) continue;
      // Falls off linearly from centre damage to the edge value.
      const k = clamp(dist / radius, 0, 1);
      const dmg = damageMax + (damageMin - damageMax) * k;
      // Walls block blast, open ground does not. The probe starts a little way
      // off the impact point: a shell that lands on the floor detonates exactly
      // on a collider surface, and a ray from there hits that surface at
      // distance zero and reports the whole blast as occluded.
      if (dist > 1.5) {
        const probe = to.vsub(centre);
        probe.normalize();
        probe.scale(0.9, probe);
        probe.vadd(centre, probe);
        probe.y += 0.35;
        if (!this.phys.lineOfSight(probe, to, tank.vehicle.body)) continue;
      }
      this.damage(tank, dmg, source, { kind: 'splash', at: to });
      if (opts.impactForce > 0 && dist > 0.01) {
        const push = to.vsub(centre);
        push.scale(1 / dist, push);
        push.y = Math.max(push.y, 0.35);
        tank.vehicle.applyImpulse(push, opts.impactForce * (1 - k * 0.6));
      }
    }
  }

  spawnProjectile(spec: ProjectileSpawn): void {
    this.projectiles.spawn(spec);
  }

  spawnMine(owner: Tank, position: CANNON.Vec3, power = 1): void {
    this.mines.spawn(owner, position, power);
  }

  awardBattlePoints(tank: Tank, points: number): void {
    tank.addBattlePoints(points);
  }

  notify(text: string, kind: Notification['kind'] = 'info'): void {
    if (!text) return;
    this.notifications.push({ text, kind, at: this.time });
    if (this.notifications.length > 30) this.notifications.shift();
  }

  // ---- destruction and respawn -----------------------------------------

  private destroy(victim: Tank, source: Tank | null): void {
    const killer = source && source !== victim ? source : victim.lastAttacker;
    this.fx.explosion(victim.position, victim.hull.size[0] * 3.2, 0xff8844);
    this.overdrives.clearFor(victim);
    this.mode.onDeath(victim, this);
    victim.ai?.onDeath();
    victim.kill();
    // Most modes take the flat wait; Boss Raid charges for deaths in seconds
    // that grow as the raid takes more of them.
    victim.respawnTimer = this.mode.respawnDelay(victim, this) ?? RESPAWN_TIME;

    this.mode.onKill(killer ?? null, victim, this);

    if (killer && killer !== victim && killer.traits.overdriveOnKill) {
      killer.overdriveCharge = Math.min(100, killer.overdriveCharge + killer.traits.overdriveOnKill * 100);
    }

    if (killer && killer !== victim) {
      if (killer.isPlayer) {
        this.dynamic.recordKill();
        this.notify(`You destroyed ${victim.name}`, 'kill');
      } else if (victim.isPlayer) {
        this.dynamic.recordDeath();
        this.notify(`${killer.name} destroyed you`, 'kill');
      } else {
        this.notify(`${killer.name} destroyed ${victim.name}`, 'kill');
      }
    } else if (victim.isPlayer) {
      this.dynamic.recordDeath();
      this.notify('You were destroyed', 'kill');
    }
  }

  private respawn(tank: Tank): void {
    tank.respawn(this.pickSpawn(tank.team));
  }

  // ---- frame ------------------------------------------------------------

  update(dt: number, input: InputState): void {
    if (this.finished) {
      this.fx.update(dt);
      this.camera.update(dt, this.viewTarget(), this.fx.shake, null);
      return;
    }

    this.time += dt;
    this.elapsed += dt;
    this.dynamic.update(dt);
    for (const board of Object.values(this.boards)) board.beginTick();

    this.controlPlayer(dt, input);

    for (const tank of this.tanks) {
      if (!tank.alive) {
        tank.respawnTimer -= dt;
        if (tank.respawnTimer <= 0 && this.mode.canRespawn(tank, this)) this.respawn(tank);
        continue;
      }
      if (tank.ai) {
        tank.ai.update(dt, this.time);
        if (tank.ai.pendingOverdrive) {
          tank.ai.pendingOverdrive = false;
          this.overdrives.activate(tank, this);
        }
      }
      tank.update(dt, this);
    }

    this.phys.step(dt);
    this.updateRamAugments();
    this.projectiles.update(dt, this);
    this.overdrives.update(dt, this);
    for (const r of this.overdrives.activeRampages()) this.mines.clearNear(r.pos, r.radius);
    this.mines.update(dt, this);
    this.pickups.update(dt, this);
    this.mode.update(dt, this);

    for (const tank of this.tanks) if (tank.alive) tank.syncMesh();

    const view = this.viewTarget();
    this.fx.update(dt);
    this.camera.update(dt, view, this.fx.shake, view === this.player ? this.player.weapon.scopeFov : null);
    this.bundle.sun.position.set(view.position.x + 90, 150, view.position.z + 60);
    this.bundle.sun.target.position.set(view.position.x, 0, view.position.z);
    this.bundle.sun.target.updateMatrixWorld();

    const result = this.mode.result(this.elapsed, this);
    if (result.over) this.finished = { winner: result.winner, reason: result.reason };
  }

  private controlPlayer(dt: number, input: InputState): void {
    const p = this.player;
    if (!p.alive) {
      this.selfDestructTimer = null;
      this.lockedTarget = null;
      return;
    }

    // Z/X slew the turret at the speed it can physically manage, so the barrel
    // tracks the key rather than chasing a runaway target angle.
    const slew = p.turretDef.rotationSpeed * DEG * p.weapon.rotationMultiplier * p.status.turretScale;
    p.desiredYaw += input.turretTurn * slew * dt;
    if (input.centreTurret) p.desiredYaw = p.vehicle.yaw;
    this.updateAutoAim(dt);
    if (input.zoom) this.camera.zoom(input.zoom * dt * 9);

    p.weapon.intent.fire = input.fire;
    p.weapon.intent.alt = false;
    // Holding the trigger on a scoped turret is what scopes it in; releasing
    // both un-scopes and fires the charged shot.
    p.weapon.intent.scope = input.fire && p.turretDef.scoped != null;

    if (input.supply != null) {
      const kind = SUPPLY_ORDER[input.supply - 1];
      if (kind) p.useSupply(kind, this);
    }
    if (input.overdrive) this.overdrives.activate(p, this);
    if (input.flip) p.vehicle.requestFlip();

    // Hold K for five seconds to scuttle. Costs a kill and five points, per
    // the reference — it is an escape hatch from a bad position, not a free reset.
    if (this.keyHeldSelfDestruct) {
      this.selfDestructTimer = (this.selfDestructTimer ?? SELF_DESTRUCT_TIME) - dt;
      if (this.selfDestructTimer <= 0) {
        this.selfDestructTimer = null;
        p.kills = Math.max(0, p.kills - 1);
        p.score = Math.max(0, p.score - 5);
        this.damage(p, p.health, p, { kind: 'self', ignoreArmor: true });
      }
    } else {
      this.selfDestructTimer = null;
    }

    p.vehicle.update(dt, {
      forward: input.forward,
      turn: input.turn,
      speedScale: p.movementScale,
      locked: p.weapon.movementLocked,
    });
  }

  keyHeldSelfDestruct = false;

  /** Enemy the player's turret has locked, or null. Drawn by the HUD. */
  lockedTarget: Tank | null = null;

  /**
   * The player only aims left and right. Once the barrel is lined up on an
   * enemy horizontally, this picks the elevation that actually connects —
   * a straight line for flat-shooting guns, a solved arc for Magnum — and
   * hands the HUD the target so the lock is visible rather than mysterious.
   *
   * A turret can only lock what it can physically point at: the solved angle
   * has to fall inside the turret's elevation envelope, so a Railgun cannot
   * lock the tank on the roof above it and a Magnum can lob over the wall.
   */
  private updateAutoAim(dt: number): void {
    const p = this.player;
    const def = p.turretDef;
    const [minPitch, maxPitch] = p.pitchLimits;
    const from = p.muzzle(new CANNON.Vec3());
    const maxRange = def.hardCap ?? Math.max(120, def.rangeMinDamage * 1.3);

    let best: Tank | null = null;
    let bestScore = Infinity;
    let bestYaw = 0;
    let bestPitch = 0;

    for (const t of this.tanks) {
      if (!t.alive || !this.areEnemies(p, t)) continue;

      // Lead the shot so the elevation is right for where the target will be,
      // not where it was — it matters most for slow shells at long range.
      let aim = t.centre();
      if (def.projectileSpeed) {
        const q = predictIntercept(from, aim, t.velocity, def.projectileSpeed);
        aim = new CANNON.Vec3(q.x, q.y, q.z);
      }

      const delta = aim.vsub(from);
      const horizontal = Math.hypot(delta.x, delta.z);
      const dist = delta.length();
      if (dist > maxRange || dist < 0.5) continue;

      // The lock cone is a fixed miss distance rather than a fixed angle, so
      // "lined up" means the same thing whether the target is near or far.
      const yaw = Math.atan2(delta.x, delta.z);
      const yawError = Math.abs(angleDelta(p.turretYaw, yaw));
      const cone = clamp(Math.atan2(LOCK_WIDTH, Math.max(8, horizontal)), 2.5 * DEG, 16 * DEG);
      if (yawError > cone) continue;

      let pitch = Math.atan2(delta.y, horizontal);
      if (def.gravity && def.projectileSpeed) {
        const solved = ballisticPitch(horizontal, delta.y, def.projectileSpeed, def.gravity);
        if (solved == null) continue;
        pitch = solved;
      }
      if (pitch < minPitch || pitch > maxPitch) continue;
      if (!this.phys.lineOfSight(from, t.centre(), p.vehicle.body)) continue;

      // Centred beats close: whichever target the barrel is nearest to pointing
      // at wins, with distance only breaking ties.
      const score = yawError * 60 + dist * 0.01;
      if (score < bestScore) {
        bestScore = score;
        best = t;
        bestYaw = yaw;
        bestPitch = pitch;
      }
    }

    this.lockedTarget = best;
    if (!best) {
      // Nothing to elevate for — settle back to level so the next lock is a
      // short trip rather than a swing from wherever the last one left it.
      p.desiredPitch += (0 - p.desiredPitch) * damp(4, dt);
      return;
    }

    p.desiredPitch = clamp(bestPitch, minPitch, maxPitch);

    // Horizontal magnetism, unchanged in spirit from the mouse build: enough to
    // forgive a key press a fraction late, never enough to aim for you.
    const strength = this.profile.player.aimAssistStrength;
    if (strength > 0) {
      const k = clamp(strength * dt * 4, 0, 0.4);
      p.desiredYaw += angleDelta(p.desiredYaw, bestYaw) * k;
    }
  }

  // ---- presentation -----------------------------------------------------

  /**
   * Whose eyes the camera is behind. Normally the player's — the fallback to a
   * living ally covers any mode that benches a destroyed tank for good, so that
   * it is never a stare at an empty respawn timer.
   */
  private viewTarget(): Tank {
    if (this.player.alive || this.mode.canRespawn(this.player, this)) return this.player;
    const survivor = this.tanks.find((t) => t.alive && t !== this.player && this.areAllies(this.player, t));
    return survivor ?? this.player;
  }

  snapshot(): BattleSnapshot {
    const scoreboard = [...this.tanks].sort((a, b) => b.score - a.score || b.kills - a.kills);
    return {
      player: this.player,
      elapsed: this.elapsed,
      timeLimit: this.settings.timeLimit,
      modeCode: this.settings.mode,
      modeLine: this.mode.hudLine(this.player.team, this),
      notifications: this.notifications,
      scoreboard,
      teamScores: this.mode.teamScores(),
      selfDestruct: this.selfDestructTimer,
      boss: this.mode.bossStatus(this),
      viewing: this.viewTarget(),
      over: this.finished !== null,
      winner: this.finished?.winner,
      reason: this.finished?.reason,
    };
  }

  minimapMarkers(): {
    tanks: { x: number; z: number; colour: number; you: boolean; yaw: number }[];
    objectives: ReturnType<ModeController['markers']>;
    pickups: ReturnType<PickupSystem['markers']>;
    mines: { x: number; z: number }[];
  } {
    const eyes = this.viewTarget();
    const tanks = this.tanks
      .filter((t) => t.alive)
      .filter((t) => t.isPlayer || this.areAllies(this.player, t) || this.isVisibleFrom(eyes, t))
      .map((t) => ({
        x: t.position.x,
        z: t.position.z,
        colour: t.isPlayer ? 0x2ee6a8 : this.areAllies(this.player, t) ? 0x3c7ce0 : 0xe0483c,
        you: t.isPlayer,
        yaw: t.vehicle.yaw,
      }));
    return {
      tanks,
      objectives: this.mode.markers(),
      pickups: this.pickups.markers(),
      mines: this.mines.visibleTo(eyes, this),
    };
  }

  private isVisibleFrom(eyes: Tank, t: Tank): boolean {
    if (t.status.has('reveal')) return true;
    const from = eyes.turretOrigin(new CANNON.Vec3());
    if (from.distanceTo(t.position) > 130) return false;
    return this.phys.lineOfSight(from, t.centre(), eyes.vehicle.body);
  }

  /** Screen-space aim point for the reticle and the ballistic indicator. */
  aimPoint(): CANNON.Vec3 {
    return this.camera.aimPoint(this.player);
  }

  /** Predicted landing point for ballistic turrets, or null. */
  ballisticLanding(): CANNON.Vec3 | null {
    const t = this.player.turretDef;
    if (!t.gravity || !t.projectileSpeed) return null;
    const pos = this.player.muzzle(new CANNON.Vec3());
    const vel = this.player.aimDirection(new CANNON.Vec3()).scale(t.projectileSpeed);
    const step = 0.05;
    for (let i = 0; i < 200; i++) {
      const next = pos.vadd(vel.scale(step));
      vel.y -= t.gravity * step;
      const hit = this.phys.raycast(pos, next, WORLD_MASK, this.player.vehicle.body);
      if (hit) return hit.point;
      pos.copy(next);
    }
    return null;
  }

  /**
   * Radio calls the raid squad has made. Harness-facing, and zero in every
   * other mode: a raid where nobody ever speaks means the squad branches never
   * fired, which is invisible from any other number the harness reports.
   */
  squadCalls(): number {
    return this.mode instanceof BossRaidMode ? this.mode.squad.calls : 0;
  }

  resize(aspect: number): void {
    this.camera.setAspect(aspect);
  }

  dispose(): void {
    for (const tank of this.tanks) tank.dispose(this.bundle.scene);
    this.tanks.length = 0;
    this.projectiles.dispose();
    this.pickups.dispose();
    this.mines.dispose();
    this.overdrives.dispose();
    this.mode.dispose();
    this.fx.dispose();
    this.bundle.dispose();
    // Every tank mesh is gone, so it is safe to drop shared silhouettes if the
    // garage has been cycled enough times to make the cache worth reclaiming.
    pruneChassisCache();
  }
}

