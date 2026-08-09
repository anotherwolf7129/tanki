import * as CANNON from 'cannon-es';
import { preferredRange } from '../data';
import type { DifficultyProfile } from '../data/difficulty';
import {
  BARRAGE_DAMAGE,
  BARRAGE_GRAVITY,
  BARRAGE_INTERVAL,
  BARRAGE_SPEED,
  BARRAGE_SPLASH_RADIUS,
  BARRAGE_SPREAD,
  BLAST_CLEARANCE,
  BLAST_CLEARANCE_MAX,
  BLAST_HOLD,
  BLAST_LESSON_STEP,
  BOSS_ABILITIES,
  BOSS_BOX_AT,
  BOSS_BOX_REACH,
  BOSS_REPAIR_AT,
  BOSS_REPAIR_DESPERATE,
  BOSS_REPAIR_QUIET,
  BOSS_SPEED_CAP,
  DREAD_RADIUS,
  DREAD_SHAKE,
  MARK_BREAK_DAMAGE,
  MARK_DURATION,
  MARK_FROM_PHASE,
  MARK_SPEED_BONUS,
  TELEGRAPH_STILLNESS,
  markCooldownFor,
  METEOR_ALTITUDE,
  METEOR_DIRECT,
  METEOR_ENTRY_DEG,
  METEOR_IMPULSE,
  METEOR_INTERVAL,
  METEOR_SHELL_RADIUS,
  METEOR_SPEED,
  METEOR_SPLASH_MAX,
  METEOR_SPLASH_MIN,
  METEOR_SPLASH_RADIUS,
  METEOR_SPREAD,
  OVERCHARGE_DURATION,
  PHASE_PULSE_DAMAGE,
  PHASE_PULSE_IMPULSE,
  PHASE_PULSE_RADIUS,
  PURGE_HEAL_AT,
  QUAKE_DAMAGE_CENTRE,
  QUAKE_DAMAGE_EDGE,
  QUAKE_IMPULSE,
  QUAKE_RADIUS,
  RAM_COOLDOWN,
  RAM_DAMAGE,
  RAM_DEMOLITION_POWER,
  RAM_DEMOLITION_REACH,
  RAM_FROM_PHASE,
  RAM_IMPULSE,
  RAM_MIN_SPEED,
  RAM_REACH,
  RAM_SPEED_BONUS,
  RAM_SPEED_WINDOW,
  REGEN_DELAY,
  REGEN_PER_SECOND,
  WIPE_REGEN_MULTIPLIER,
  bossFireRate,
  bossSpeedScale,
  frenzyFor,
  type BossAbilityDef,
  type RaidPhase,
} from '../data/raid';
import type { SupplyKind } from '../data/schema';
import { angleDelta, ballisticPitch, clamp, DEG, predictIntercept, randRange } from '../core/mathx';
import { SHOT_MASK, WORLD_MASK } from '../physics/world';
import type { Arena } from '../game/types';
import type { Tank } from '../entities/tank';
import type { AiController } from './controller';
import type { NavGrid } from './navgrid';
import { Perception, type Track } from './perception';

const TICK = 0.1;

/** Seconds for a raider's accumulated threat to halve once they stop shooting. */
const THREAT_HALF_LIFE = 14;
/** How much better a challenger must score before the boss turns its gun. */
const SWITCH_MARGIN = 700;
/** Threat kept by a raider the boss has just destroyed. */
const THREAT_AFTER_KILL = 0.4;
/** How far behind a candidate position a wall counts as covering its back. */
const REAR_COVER_REACH = 13;

export interface BossDeps {
  arena: Arena;
  nav: NavGrid;
  profile: DifficultyProfile;
  /** Live phase, owned by the raid mode and driven by the boss's health. */
  phase: () => RaidPhase;
  /** Nearest live supply box of the given kinds, so the boss can contest them. */
  nearestSupply: (from: CANNON.Vec3, kinds: SupplyKind[]) => { pos: CANNON.Vec3 } | null;
  /**
   * Ground the Overseer has committed to hitting, published to the squad
   * channel as it commits to it.
   *
   * This gives the squad nothing the raid was not already shown — every zone
   * pushed through here has a ring drawn on the floor or a warning in the feed
   * at the same instant. What it buys is squadmates that can *read* their own
   * HUD, which up to now they could not: the bots stood in Quake rings and
   * drove through storms, and a raid whose only casualty-avoidance was the
   * human's made the boss's telegraphs a solo mechanic in a squad fight.
   */
  warn?: (x: number, z: number, radius: number, seconds: number, label: string) => void;
  /** Structural damage the Overseer does by driving through the map. */
  demolish?: (at: CANNON.Vec3, reach: number, power: number) => void;
}

interface Telegraph {
  def: BossAbilityDef;
  remaining: number;
  total: number;
  /** Ground it has ranged, marked through the wind-up. Meteor Storm only. */
  points: CANNON.Vec3[];
}

interface Barrage {
  remaining: number;
  timer: number;
  aim: CANNON.Vec3;
}

interface Storm {
  /** Rocks still to drop. */
  remaining: number;
  timer: number;
  /** Set once the first rock is aimed at ground the boss is standing on. */
  warnedSelf: boolean;
}

/**
 * The raid boss.
 *
 * A line bot is deliberately *slow* and *imprecise* — that is the whole
 * player-advantage design, and nothing here undoes it for the other twelve
 * tanks on the field. The Overseer is the one exception the mode is built
 * around, and it is a different kind of opponent rather than a bot with the
 * handicaps switched off:
 *
 * - **It remembers who hurt it.** A decaying threat table, fed by damage taken,
 *   decides where the gun points. Out-damaging the squad is what drags its
 *   attention onto you, which is the tension the whole mode runs on.
 * - **It cannot be flanked by surprise.** All-round sensors, so peripheral
 *   blindness — the thing that makes flanking a line bot work — is off the
 *   table. You flank it by taking its attention elsewhere first.
 * - **It aims at groups, not tanks.** With a nine-metre blast it puts the shell
 *   between two raiders rather than on one.
 * - **It is inside its own blast radius, and it knows it.** Everything it fires
 *   can hurt it, so before every trigger pull it traces the barrel line it is
 *   actually pointing down — plus every shell in the fan behind it — and holds
 *   fire if any of it would detonate close enough to come back. It will not
 *   shoot the wall it has backed against, or the raider hugging its glacis; it
 *   backs off and reaches for a Quake instead. Whenever it does catch itself
 *   anyway, it widens that ring: it shoots once and works the rest out.
 * - **It protects its own weak point.** It prefers ground with a wall behind it
 *   and refuses to be surrounded, because its engine deck is where the damage
 *   is. Reaching that deck is a manoeuvre you have to earn.
 * - **It spends abilities on reasons.** Quake when raiders stack on it, Barrage
 *   when they hide, a Meteor Storm when hiding is all they are doing,
 *   Overcharge when someone is isolated — each with a visible wind-up, so every
 *   one of them is something you could have avoided.
 * - **It brings the sky down.** The Meteor Storm walks a line of impacts across
 *   wherever it last saw anybody, each rock marked on the ground for its whole
 *   flight and each one lethal to a light hull. It does not aim them around
 *   itself, so fighting *inside* a storm is the fastest damage in the mode and
 *   very nearly suicide.
 * - **It heals like a player.** Repair kits, its own Purge, and the map's
 *   supply boxes, which it will break off and drive to when it is hurt. None of
 *   it can take the boss back through a phase gate.
 * - **It chooses somebody.** From Siege on it periodically stops arbitrating
 *   between threat scores and marks one raider by name. While a mark is running
 *   the threat table is not consulted: it drives at its quarry and nothing that
 *   raider does moves the gun. The only way out is the rest of the squad doing
 *   enough damage to drag its head round — the one thing in this fight nobody
 *   can solve alone.
 * - **It goes quiet before it strikes.** The last stretch of every wind-up is
 *   silent and motionless. The pulsing stops, the tracks stop, and the ground
 *   marks stay lit: the raid keeps all of the information and loses all of the
 *   noise, which is the moment the ability actually lands in the stomach.
 * - **It is felt before it is seen.** A rumble that rises with how close it is
 *   and how fast it is closing, so the gap between abilities is never quiet.
 * - **It gets angry, and it keeps getting angrier.** Each gate shortens its
 *   cooldowns, adds a round to every trigger pull, and makes it faster and
 *   harder-hitting; from Siege on it will simply drive through you. Below 15%
 *   it goes berserk — and inside berserk it *still* accelerates, worst in the
 *   last seconds before it dies.
 * - **It will not be waited out.** Break contact entirely and it repairs, six
 *   times faster while the whole raid is dead at once.
 */
export class BossController implements AiController {
  readonly persona = { displayName: 'Overseer' };
  readonly perception: Perception;

  pendingOverdrive = false;
  target: Tank | null = null;

  /** Accumulated, decaying damage per raider. */
  private readonly threat = new Map<number, number>();
  private readonly damageSeen = new Map<number, number>();
  private readonly wasAlive = new Map<number, boolean>();

  private telegraph: Telegraph | null = null;
  private barrage: Barrage | null = null;
  private storm: Storm | null = null;
  private readonly readyAt: Record<BossAbilityDef['id'], number> = {
    quake: 12,
    meteor: 18,
    barrage: 8,
    overcharge: 30,
  };
  private chargeUntil = -1;
  private pulseTimer = 0;
  private markerTimer = 0;
  /** When each raider may next be run over, keyed by tank id. */
  private readonly ramReadyAt = new Map<number, number>();
  /** And when it may next put a shoulder through a building. */
  private structureRamAt = 0;

  private lastPhase = 1;
  private boxGoal: CANNON.Vec3 | null = null;

  /** The raider it has fixated on, and until when. */
  private quarry: Tank | null = null;
  private markUntil = -1;
  private markReadyAt = 25;
  /** Damage dealt by everyone *except* the quarry since the mark was called. */
  private readonly markBreak = new Map<number, number>();
  /** Set once the wind-up has gone quiet, so the cue only plays on the edge. */
  private stillAnnounced = false;
  /** 0..1 proximity pressure on the player, for the HUD's dread vignette. */
  private dread = 0;

  /** Multiple of its own blast radius it refuses to put a shell inside. */
  private blastClearance = BLAST_CLEARANCE;
  /** True while the shot it wants would land close enough to catch it. */
  private blastUnsafe = false;
  private blastHoldUntil = -1;
  /** Self-damage already accounted for, so each new blast is only learned once. */
  private selfHarmSeen = 0;
  private learnedBlast = false;
  /** When the last rock of the current storm can no longer be in the air. */
  private stormSettlesAt = -1;

  private path: CANNON.Vec3[] = [];
  private pathIndex = 0;
  private goal: CANNON.Vec3 | null = null;
  private goalTimer = 0;
  private repathTimer = 0;
  private stuckTimer = 0;
  private unstickTimer = 0;
  private strafeSign = Math.random() < 0.5 ? -1 : 1;

  private decisionAccum = 0;
  private jitterYaw = 0;
  private jitterPitch = 0;
  private jitterTimer = 0;
  private unseenFor = 0;
  private repairing = false;

  constructor(
    readonly self: Tank,
    private readonly deps: BossDeps,
  ) {
    this.perception = new Perception(self, {
      // All-round, long-ranged and quick. Difficulty still scales the boss —
      // it is sharper than a line bot on every preset, never absolute.
      fovDegrees: 360,
      viewDistance: Math.max(180, deps.profile.bot.viewDistance * 1.4),
      reactionDelayMs: Math.max(90, deps.profile.bot.reactionDelayMs[0] * 0.45),
      memoryDurationMs: 9000,
      losCheck: true,
      hearsGunfireRadius: 90,
    });
  }

  // ---- HUD / mode-facing state -----------------------------------------

  get telegraphName(): string | null {
    if (this.storm) return BOSS_ABILITIES.meteor.displayName;
    if (this.barrage) return BOSS_ABILITIES.barrage.displayName;
    return this.telegraph?.def.displayName ?? null;
  }

  /** 0..1 through the current wind-up, for the HUD's warning bar. */
  get telegraphProgress(): number {
    if (!this.telegraph) return this.barrage || this.storm ? 1 : 0;
    return clamp(1 - this.telegraph.remaining / this.telegraph.total, 0, 1);
  }

  /** The raider it has fixated on, or null when it is arbitrating normally. */
  get marked(): Tank | null {
    return this.quarry;
  }

  /** Seconds left on the hunt, for the marked raider's countdown. */
  get markRemaining(): number {
    return this.quarry ? Math.max(0, this.markUntil - this.deps.arena.time) : 0;
  }

  /**
   * How close the squad is to pulling it off its quarry, 0..1. Shown to the
   * whole raid, because a rescue nobody can see the progress of is a rescue
   * nobody commits to.
   */
  get markBreakProgress(): number {
    if (!this.quarry) return 0;
    let total = 0;
    for (const v of this.markBreak.values()) total += v;
    return clamp(total / MARK_BREAK_DAMAGE, 0, 1);
  }

  /** Proximity pressure on the player, 0..1. Atmosphere only — no mechanic. */
  get dreadLevel(): number {
    return this.dread;
  }

  /** True while a called ability has gone quiet and the boss has stopped. */
  get stilled(): boolean {
    return !!this.telegraph && this.telegraphProgress >= TELEGRAPH_STILLNESS;
  }

  threatOf(tank: Tank): number {
    return this.threat.get(tank.id) ?? 0;
  }

  /**
   * How close a raider is to being top of the boss's list, 0..1. Measured
   * against the current leader rather than the whole pool, so the meter answers
   * the only question worth asking — am I about to be the one it shoots?
   */
  threatShare(tank: Tank): number {
    let leader = 0;
    for (const v of this.threat.values()) leader = Math.max(leader, v);
    if (leader <= 0) return 0;
    return clamp(this.threatOf(tank) / leader, 0, 1);
  }

  // ---- frame ------------------------------------------------------------

  update(dt: number, now: number): void {
    if (!this.self.alive) return;

    this.decisionAccum += dt;
    if (this.decisionAccum >= TICK) {
      this.decisionAccum -= TICK;
      this.perception.update(this.deps.arena, now);
      this.accrueThreat();
      this.decayThreat(TICK);
      // The mark is resolved before the target is picked, because while one is
      // running it *is* the target: the threat table is not consulted at all.
      this.considerMark(now);
      this.target = this.pickTarget();
      this.checkPhase();
      this.learnFromSelfHarm();
      this.updateBlastGuard();
      this.considerAbility(now);
      this.considerSupplies();
      this.considerOverdrive();
      this.updateGoal();
    }

    this.updatePresence(dt);
    this.updateEnrage(dt);
    this.updateTelegraph(dt);
    this.updateBarrage(dt);
    this.updateStorm(dt);
    this.updateAim(dt);
    this.updateFiring();
    this.updateMovement(dt);
    this.updateRam();
    this.updateRepair(dt);
  }

  onDeath(): void {
    this.target = null;
    this.telegraph = null;
    this.barrage = null;
    this.storm = null;
    this.path = [];
    this.goal = null;
    this.boxGoal = null;
    this.blastUnsafe = false;
    this.quarry = null;
    this.markBreak.clear();
    this.dread = 0;
    this.stillAnnounced = false;
  }

  /**
   * Salvo fire, driven by the phase. The weapon fires one shell and calls this;
   * the rest of the pull is fanned out either side of it here rather than by
   * teaching every turret in the game about salvos.
   *
   * The fan is what makes an angry boss dangerous without touching a single
   * damage number: four shells at four degrees means the gap you were dodging
   * into is now also where a shell is going.
   *
   * Every shell in it carries the gun's own `selfDamage`, so the outside rounds
   * are as capable of coming back as the middle one — which is exactly why the
   * blast guard clears the whole fan before the trigger is pulled rather than
   * only the line to the target.
   */
  onFired(): void {
    const phase = this.deps.phase();
    if (phase.salvo <= 1 || !this.self.alive) return;

    const arena = this.deps.arena;
    const turret = this.self.turretDef;
    const speed = turret.projectileSpeed ?? 150;
    const scale = this.self.status.damageDealtScale;
    const base = this.self.aimDirection(new CANNON.Vec3());

    for (let i = 1; i < phase.salvo; i++) {
      // Alternate sides so the fan stays centred on the aim point whether the
      // salvo is two rounds or five.
      const side = i % 2 === 0 ? 1 : -1;
      const step = Math.ceil(i / 2) * phase.salvoSpreadDeg * DEG * side;
      const cos = Math.cos(step);
      const sin = Math.sin(step);
      const dir = new CANNON.Vec3(base.x * cos + base.z * sin, base.y, base.z * cos - base.x * sin);
      const muzzle = this.self.muzzle(new CANNON.Vec3());

      arena.spawnProjectile({
        owner: this.self,
        turret,
        position: muzzle,
        direction: dir,
        speed,
        damage: turret.damage * scale,
        weakDamage: turret.weakDamage * scale,
        impactForce: turret.impactForce,
        selfDamage: turret.selfDamage,
        colour: 0xff8844,
        radius: 0.34,
        splash: turret.splash
          ? {
              radius: turret.splash.radius,
              damageMax: (turret.splash.damageMax ?? turret.damage) * scale,
              damageMin: turret.splash.damageMin * scale,
            }
          : undefined,
        maxLife: 5,
        trail: true,
      });
      arena.fx.muzzleFlash(muzzle, dir, 0xff8844);
    }
  }

  // ---- threat -----------------------------------------------------------

  /**
   * With friendly fire off, the only thing a raider can damage is the boss — so
   * a raider's running damage total *is* the damage it has done here. That makes
   * the threat table something the boss feels being done to it rather than
   * something it reads out of the world.
   */
  private accrueThreat(): void {
    const arena = this.deps.arena;
    for (const t of arena.tanks) {
      if (t === this.self || !arena.areEnemies(this.self, t)) continue;

      const seen = this.damageSeen.get(t.id);
      this.damageSeen.set(t.id, t.damageDealt);
      if (seen !== undefined && t.damageDealt > seen) {
        const fresh = t.damageDealt - seen;
        this.threat.set(t.id, (this.threat.get(t.id) ?? 0) + fresh);
        // The rescue, measured on the same tick as the threat it is ignoring.
        // Only damage from somebody *other* than the quarry counts: a marked
        // raider shooting their way out of a hunt is exactly the solo answer
        // this mechanic exists to not have.
        if (this.quarry && t !== this.quarry) {
          this.markBreak.set(t.id, (this.markBreak.get(t.id) ?? 0) + fresh);
        }
      }

      // A raider it has just put down stops being the priority. Without this the
      // boss re-targets the corpse's respawn and the squad can never trade aggro.
      if (this.wasAlive.get(t.id) && !t.alive) {
        this.threat.set(t.id, (this.threat.get(t.id) ?? 0) * THREAT_AFTER_KILL);
      }
      this.wasAlive.set(t.id, t.alive);
    }
  }

  private decayThreat(dt: number): void {
    const k = Math.pow(0.5, dt / THREAT_HALF_LIFE);
    for (const [id, value] of this.threat) {
      const next = value * k;
      if (next < 1) this.threat.delete(id);
      else this.threat.set(id, next);
    }
  }

  // ---- targeting --------------------------------------------------------

  private currentTrack(): Track | null {
    return this.target ? (this.perception.get(this.target.id) ?? null) : null;
  }

  private visibleRaiders(): Tank[] {
    return this.perception
      .remembered()
      .filter((t) => t.visible && t.tank.alive)
      .map((t) => t.tank);
  }

  private scoreOf(track: Track): number {
    const dist = track.lastKnown.distanceTo(this.self.centre());
    let score = this.threat.get(track.tank.id) ?? 0;
    score += track.visible ? 1200 : -900;
    score -= dist * 10;
    // Finish what it started: a raider it can reach and nearly has down is worth
    // more than the one chipping it from a rooftop.
    if (track.visible && track.tank.healthFraction < 0.3 && dist < 55) score += 2600;
    return score;
  }

  // ---- the mark ---------------------------------------------------------

  /**
   * The hunt. Once the Overseer is angry enough to stop arbitrating, it picks
   * the raider at the top of its list and stops caring about the list.
   *
   * Everything about this is written to be *legible from the outside*, because
   * a fixation nobody can see is just a bot behaving oddly. It is announced by
   * name, it runs on a clock the whole raid can read, and the one thing that
   * ends it early is the one thing the raid can choose to do — which is why the
   * break is measured in damage from everybody else rather than in anything the
   * quarry can influence.
   */
  private considerMark(now: number): void {
    const arena = this.deps.arena;

    if (this.quarry) {
      if (!this.quarry.alive) {
        // It caught them. Nothing to announce — the kill feed has just said it
        // far better than a second line would.
        this.clearMark(now);
        return;
      }
      // Every raider's contribution counts toward the break; the credit goes to
      // whoever did the most of it and is still standing to be named.
      let broken = 0;
      let breaker: Tank | null = null;
      let bestShare = 0;
      for (const [id, amount] of this.markBreak) {
        broken += amount;
        if (amount <= bestShare) continue;
        const who = arena.tanks.find((t) => t.id === id && t.alive);
        if (!who) continue;
        bestShare = amount;
        breaker = who;
      }
      if (broken >= MARK_BREAK_DAMAGE) {
        const saved = this.quarry;
        this.clearMark(now);
        // Threat takes over again from here, and the raider who did the pulling
        // is almost certainly top of it — the rescue is not a special case, it
        // is the ordinary rule switched back on.
        arena.notify(
          breaker
            ? `${breaker.name} pulled ${this.self.name} off ${saved.name}`
            : `${this.self.name} lost interest in ${saved.name}`,
          'info',
        );
        return;
      }
      if (arena.time >= this.markUntil) {
        const survived = this.quarry;
        this.clearMark(now);
        arena.notify(`${survived.name} outlasted the hunt`, 'info');
      }
      return;
    }

    if (this.deps.phase().index < MARK_FROM_PHASE || now < this.markReadyAt) return;

    // Whoever it is angriest at, provided it can actually account for them —
    // marking somebody it has never seen would read as the boss cheating.
    let pick: Tank | null = null;
    let best = 0;
    for (const track of this.perception.remembered()) {
      if (!track.tank.alive) continue;
      const score = this.threat.get(track.tank.id) ?? 0;
      if (score > best) {
        best = score;
        pick = track.tank;
      }
    }
    if (!pick) return;

    this.quarry = pick;
    this.markUntil = arena.time + MARK_DURATION;
    this.markBreak.clear();
    arena.notify(`${this.self.name} HAS MARKED ${pick.name.toUpperCase()} — GET IT OFF THEM`, 'warning');
    arena.fx.supplyBurst(this.self.position, 0xf87171, 5);
    arena.fx.supplyBurst(pick.position, 0xf87171, 4);
  }

  private clearMark(now: number): void {
    this.quarry = null;
    this.markBreak.clear();
    this.markReadyAt = now + markCooldownFor(this.deps.phase().cooldownScale);
    // A hunt that just ended leaves it standing somewhere it did not choose, so
    // the next tick picks fresh ground rather than finishing a stale goal.
    this.goalTimer = 0;
  }

  private pickTarget(): Tank | null {
    // A marked raider is the target, full stop. No score, no hysteresis, and no
    // amount of damage from anyone else moves the gun — that is what the break
    // threshold is for, and short-circuiting here is what makes the fixation
    // something a raider can feel rather than infer.
    if (this.quarry?.alive) return this.quarry;

    let best: Tank | null = null;
    let bestScore = -Infinity;
    for (const track of this.perception.remembered()) {
      if (!track.tank.alive) continue;
      const score = this.scoreOf(track);
      if (score > bestScore) {
        bestScore = score;
        best = track.tank;
      }
    }
    if (!best) return null;

    // Decisiveness. A boss with four raiders on it and no hysteresis spends the
    // whole fight slewing its turret and never lands anything.
    const currentTrack = this.target?.alive ? this.perception.get(this.target.id) : undefined;
    if (currentTrack && best !== this.target && bestScore < this.scoreOf(currentTrack) + SWITCH_MARGIN) {
      return this.target;
    }
    return best;
  }

  // ---- aiming -----------------------------------------------------------

  /**
   * Where the shell should land. With a blast this wide, two raiders standing
   * near each other are one target, and putting the round between them is both
   * more damaging and — watching it happen — obviously deliberate.
   */
  private aimPoint(track: Track): CANNON.Vec3 {
    const primary = track.visible ? track.tank.centre() : track.lastKnown.clone();
    const splash = this.self.turretDef.splash;
    if (!splash || !track.visible) return primary;

    let n = 0;
    const sum = new CANNON.Vec3();
    for (const other of this.visibleRaiders()) {
      const c = other.centre();
      if (c.distanceTo(primary) > splash.radius * 0.8) continue;
      sum.vadd(c, sum);
      n += 1;
    }
    if (n >= 2) return sum.scale(1 / n);

    const speed = this.self.turretDef.projectileSpeed;
    if (!speed) return primary;
    const muzzle = this.self.muzzle(new CANNON.Vec3());
    const p = predictIntercept(muzzle, primary, track.tank.velocity, speed);
    return new CANNON.Vec3(p.x, p.y, p.z);
  }

  private updateAim(dt: number): void {
    const track = this.currentTrack();
    if (!track) {
      const v = this.self.velocity;
      if (v.lengthSquared() > 1) this.self.desiredYaw = Math.atan2(v.x, v.z);
      this.self.desiredPitch *= 0.9;
      return;
    }

    const muzzle = this.self.muzzle(new CANNON.Vec3());
    const point = this.aimPoint(track);
    const delta = point.vsub(muzzle);
    const horizontal = Math.hypot(delta.x, delta.z);
    let yaw = Math.atan2(delta.x, delta.z);
    let pitch = Math.atan2(delta.y, horizontal);

    const turret = this.self.turretDef;
    if (turret.gravity && turret.projectileSpeed) {
      const solved = ballisticPitch(horizontal, delta.y, turret.projectileSpeed, turret.gravity);
      if (solved != null) pitch = solved;
    }

    // Same converging-error model as the bots, tuned so it is always the sharpest
    // gun on the field without ever being pixel-perfect.
    const p = this.deps.profile.bot;
    const floor = Math.max(0.35, p.minAimErrorDeg * 0.6);
    const error = Math.max(floor, p.aimErrorDeg * 0.5 * (1 - clamp(track.timeOnTarget * 0.9, 0, 0.92)));

    this.jitterTimer -= dt;
    if (this.jitterTimer <= 0) {
      this.jitterTimer = randRange(0.3, 0.5);
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * error * DEG;
      this.jitterYaw = Math.cos(a) * r;
      this.jitterPitch = Math.sin(a) * r * 0.6;
    }
    yaw += this.jitterYaw;
    pitch += this.jitterPitch;

    const [minPitch, maxPitch] = this.self.pitchLimits;
    this.self.desiredYaw = yaw;
    this.self.desiredPitch = clamp(pitch, minPitch, maxPitch);
  }

  // ---- trigger ----------------------------------------------------------

  private updateFiring(): void {
    const weapon = this.self.weapon;
    weapon.intent.alt = false;
    weapon.intent.scope = false;

    // Committed to an ability: the main gun waits. That pause is the tell.
    //
    // Berserk is where that stops being true for the storm: rocks falling *and*
    // the gun still working is the difference between an ability the raid waits
    // out and an ability the raid has to survive.
    if (this.telegraph || this.barrage || (this.storm && !this.deps.phase().enraged)) {
      weapon.intent.fire = false;
      return;
    }

    const track = this.currentTrack();
    if (!track || !track.visible) {
      weapon.intent.fire = false;
      return;
    }

    const turret = this.self.turretDef;
    const muzzle = this.self.muzzle(new CANNON.Vec3());
    const target = track.tank.centre();
    const dist = muzzle.distanceTo(target);
    if (dist > (turret.hardCap ?? turret.rangeMinDamage * 1.4)) {
      weapon.intent.fire = false;
      return;
    }

    // It waits for the traverse rather than walking rounds toward you — a slow
    // turret that fires early is a slow turret that never hits anything.
    const aimError = Math.abs(angleDelta(this.self.turretYaw, this.self.desiredYaw));
    const gate = clamp(Math.atan2(2.6, Math.max(6, dist)), 0.8 * DEG, 9 * DEG);
    if (aimError > gate) {
      weapon.intent.fire = false;
      return;
    }
    if (!this.deps.arena.phys.lineOfSight(muzzle, target, this.self.vehicle.body)) {
      weapon.intent.fire = false;
      return;
    }

    // Last gate, and the only one that is about the boss rather than the shot:
    // a siege round that detonates on its own hull is damage the raid did not
    // have to do. The ray work behind this runs on the decision tick; the range
    // check is re-read here because a raider closing the last few metres is
    // exactly the case that must not wait a tenth of a second.
    const safe = this.safeBlastDistance();
    if (safe > 0 && (this.blastUnsafe || this.self.centre().distanceTo(target) < safe)) {
      this.blastHoldUntil = this.deps.arena.time + BLAST_HOLD;
      weapon.intent.fire = false;
      return;
    }

    weapon.intent.fire = true;
  }

  // ---- blast discipline -------------------------------------------------

  /** Radius its own gun can reach it at, or 0 for a gun that cannot. */
  private get selfBlastRadius(): number {
    const turret = this.self.turretDef;
    return turret.selfDamage && turret.splash ? turret.splash.radius : 0;
  }

  /**
   * How far away a detonation has to be before it is somebody else's problem.
   * Measured from the hull centre, because that is the point `Battle.splash`
   * measures to — no hull half-span here, or the two would double-count.
   */
  private safeBlastDistance(): number {
    return this.selfBlastRadius * this.blastClearance;
  }

  /**
   * Whether the pull it is lined up on would come back at it. Traced from the
   * barrel it is *actually* pointing down rather than from the line to the
   * target, so the wall it has backed against, the lip of ground in front of
   * its tracks and the raider hugging its glacis are all things it can see
   * coming — and traced once per shell in the phase's fan, since it is the
   * outside rounds that find the wall the middle one clears.
   *
   * Cheap enough to run at 10 Hz on a turret this slow, and cached for the
   * frames in between.
   */
  private updateBlastGuard(): void {
    const safe = this.safeBlastDistance();
    const track = this.currentTrack();
    const unsafe = safe > 0 && !!track && track.visible && this.shotCatchesSelf(track.tank.centre(), safe);

    // A gun it cannot use is a position it should not be in: repositioning is
    // the answer to being crowded, so the next tick picks new ground instead of
    // sitting out the rest of the current goal's timer.
    if (unsafe && !this.blastUnsafe) this.goalTimer = 0;
    if (unsafe) this.blastHoldUntil = this.deps.arena.time + BLAST_HOLD;
    this.blastUnsafe = unsafe;
  }

  /** True while it has recently refused a shot for being too close to it. */
  private get blastLocked(): boolean {
    return this.deps.arena.time < this.blastHoldUntil;
  }

  private shotCatchesSelf(target: CANNON.Vec3, safe: number): boolean {
    const centre = this.self.centre();
    // The target itself first, and without a ray: a raider inside the blast is
    // a raider the gun has no answer to, wall or no wall.
    if (centre.distanceTo(target) < safe) return true;

    const phys = this.deps.arena.phys;
    const body = this.self.vehicle.body;
    const phase = this.deps.phase();
    const muzzle = this.self.muzzle(new CANNON.Vec3());
    const base = this.self.aimDirection(new CANNON.Vec3());
    // No further than the shot is going: geometry behind the target is not
    // something this pull is ever going to detonate on.
    const reach = Math.min(
      muzzle.distanceTo(target) + this.selfBlastRadius,
      this.self.turretDef.hardCap ?? this.self.turretDef.rangeMinDamage,
    );

    for (let i = 0; i < phase.salvo; i++) {
      // Same fan the salvo is actually spawned with, i = 0 being the round the
      // weapon itself fires down the middle.
      const side = i % 2 === 0 ? 1 : -1;
      const step = Math.ceil(i / 2) * phase.salvoSpreadDeg * DEG * side;
      const cos = Math.cos(step);
      const sin = Math.sin(step);
      const dir = new CANNON.Vec3(base.x * cos + base.z * sin, base.y, base.z * cos - base.x * sin);
      // Tanks included: another raider standing between it and its target is a
      // detonation point too, and one it did not choose.
      const hit = phys.raycast(muzzle, muzzle.vadd(dir.scale(reach)), SHOT_MASK, body);
      if (hit && hit.point.distanceTo(centre) < safe) return true;
    }
    return false;
  }

  /**
   * The half of this the geometry cannot do. A raider that reverses into the
   * shell, a rock landing where the boss was about to fire, a blast round a
   * corner the ray never saw — whatever the reason, ordnance that has actually
   * come back is proof the ring it is keeping is too small, so it widens it.
   *
   * Storm rocks are excluded by the window below, and deliberately: the
   * Overseer eating its own bombardment is the ability working as designed, not
   * a mistake for it to learn from.
   */
  private learnFromSelfHarm(): void {
    const taken = this.self.selfDamageTaken;
    const fresh = taken - this.selfHarmSeen;
    this.selfHarmSeen = taken;
    if (fresh <= 0 || this.deps.arena.time < this.stormSettlesAt) return;
    if (this.blastClearance >= BLAST_CLEARANCE_MAX) return;

    this.blastClearance = Math.min(BLAST_CLEARANCE_MAX, this.blastClearance + BLAST_LESSON_STEP);
    if (this.learnedBlast) return;
    this.learnedBlast = true;
    this.deps.arena.notify(`${this.self.name} caught its own blast — it will not stand that close again`, 'info');
  }

  // ---- abilities --------------------------------------------------------

  /**
   * Each ability answers a specific problem the raid is causing it, so the one
   * it picks is readable from the outside: stack on it and it quakes, hide and
   * it lobs, keep hiding and the sky comes down, spread out and it picks the
   * loner off.
   */
  private considerAbility(now: number): void {
    if (this.telegraph || this.barrage || this.storm) return;

    const arena = this.deps.arena;
    const phase = this.deps.phase();
    const raiders = this.visibleRaiders();
    const here = this.self.position;
    const track = this.currentTrack();

    const close = raiders.filter((t) => t.position.distanceTo(here) <= QUAKE_RADIUS * 0.85);
    const accounted = this.perception.remembered().filter((t) => t.tank.alive);
    const hiding = accounted.some((t) => !t.visible);
    const wants: BossAbilityDef['id'][] = [];

    // Quake is what it has instead of a gun at knife range. Holding fire because
    // a raider is inside its own blast is precisely the moment to spend it —
    // otherwise "get inside the Overseer's minimum range" would be free, and the
    // discipline the gun just gained would be a discount for the raid.
    if (
      close.length >= 2 ||
      (close.length >= 1 && (this.blastLocked || this.self.healthFraction < 0.5))
    ) {
      wants.push('quake');
    }
    // The storm is what it does when shooting is not working: somebody is behind
    // something, or there are simply too many of them to shoot one at a time. It
    // stops needing a reason at all once it is angry.
    if (accounted.length && (hiding || accounted.length >= 2 || phase.index >= 2)) wants.push('meteor');
    // Only worth wanting if there is ground it can safely drop it on: a barrage
    // is its own ordnance too, and lobbing one onto its own tracks is the same
    // mistake as shooting the wall behind it, with six shells in it.
    if (((track && !track.visible) || this.densestCluster(raiders) >= 2) && this.barrageAim()) {
      wants.push('barrage');
    }
    if (
      phase.index >= 2 &&
      track &&
      (raiders.length <= 1 || track.lastKnown.distanceTo(here) > 55) &&
      !this.self.status.has('nitro')
    ) {
      wants.push('overcharge');
    }

    for (const id of wants) {
      if (now < this.readyAt[id]) continue;
      const def = BOSS_ABILITIES[id];
      this.telegraph = {
        def,
        remaining: def.windup,
        total: def.windup,
        points: id === 'meteor' ? this.stormSites() : [],
      };
      this.readyAt[id] = now + def.windup + def.cooldown * phase.cooldownScale;
      arena.notify(def.warning, 'warning');
      this.publishTelegraph(id, def);
      return;
    }
  }

  /**
   * The ground an ability has just committed to, handed to the squad channel.
   * Exactly what the wind-up is already drawing on the floor, and nothing else:
   * the Quake ring is at the hull, the storm's marks are where the first rocks
   * will fall, the barrage's is the knot of raiders it ranged.
   */
  private publishTelegraph(id: BossAbilityDef['id'], def: BossAbilityDef): void {
    const warn = this.deps.warn;
    if (!warn) return;
    switch (id) {
      case 'quake':
        warn(this.self.position.x, this.self.position.z, QUAKE_RADIUS, def.windup, 'quake');
        break;
      case 'meteor':
        for (const p of this.telegraph?.points ?? []) {
          warn(p.x, p.z, METEOR_SPLASH_RADIUS, def.windup, 'storm');
        }
        break;
      case 'barrage': {
        const aim = this.barrageAim();
        if (aim) warn(aim.x, aim.z, BARRAGE_SPLASH_RADIUS + BARRAGE_SPREAD, def.windup + 1.4, 'barrage');
        break;
      }
      default:
        break;
    }
  }

  /**
   * The ground it is ranging for a storm: everyone it can currently account
   * for, remembered contacts included. A raider that has just ducked out of
   * sight is exactly who the storm is for, and these are the marks the wind-up
   * paints — where the first rocks will land, published before they fall.
   */
  private stormSites(): CANNON.Vec3[] {
    const out: CANNON.Vec3[] = [];
    for (const track of this.perception.remembered()) {
      if (!track.tank.alive) continue;
      out.push((track.visible ? track.tank.position : track.lastKnown).clone());
    }
    // Nobody left to range: it shells its own ground rather than not shelling.
    if (!out.length) out.push(this.self.position.clone());
    return out;
  }

  /** Largest number of raiders that one blast could catch. */
  private densestCluster(raiders: Tank[]): number {
    let best = 0;
    for (const a of raiders) {
      let n = 0;
      for (const b of raiders) if (a.position.distanceTo(b.position) <= BARRAGE_SPLASH_RADIUS) n += 1;
      best = Math.max(best, n);
    }
    return best;
  }

  private updateTelegraph(dt: number): void {
    const t = this.telegraph;
    if (!t) return;

    // The stillness. Past the threshold everything the boss was doing to
    // announce itself stops at once — one hard cut rather than a fade, because
    // a fade is just the noise getting quieter and the whole point is that the
    // noise *stops*.
    //
    // What is left running is the ground marks: the stillness is meant to be
    // frightening, not to take back the warning the raid was given. You still
    // know exactly where the rocks are going. You just cannot hear it any more.
    if (this.stilled) {
      if (!this.stillAnnounced) {
        this.stillAnnounced = true;
        // One last ring, bright and wide, and then nothing. This is the edge a
        // raid learns to flinch at.
        this.deps.arena.fx.supplyBurst(this.self.position, 0xffffff, 6);
      }
    } else {
      // A pulsing ring at the hull, so the wind-up is something you can see from
      // across the map rather than only something the kill feed mentioned.
      this.pulseTimer -= dt;
      if (this.pulseTimer <= 0) {
        this.pulseTimer = 0.16;
        this.deps.arena.fx.supplyBurst(this.self.position, 0xff4d4d, 1.6 + this.telegraphProgress * 2.4);
      }
    }

    // Ranged ground is marked where it is, not only at the hull. A storm you
    // cannot see coming is a storm you were not given the chance to leave.
    if (t.points.length) {
      this.markerTimer -= dt;
      if (this.markerTimer <= 0) {
        this.markerTimer = 0.22;
        for (const p of t.points) {
          this.deps.arena.fx.supplyBurst(p, 0xff5a1f, 2.2 + this.telegraphProgress * 3);
        }
      }
    }

    t.remaining -= dt;
    if (t.remaining > 0) return;
    this.telegraph = null;
    this.stillAnnounced = false;
    this.execute(t.def, t.points);
  }

  private execute(def: BossAbilityDef, points: CANNON.Vec3[]): void {
    const arena = this.deps.arena;
    switch (def.id) {
      case 'meteor': {
        this.storm = { remaining: this.deps.phase().meteors, timer: 0, warnedSelf: false };
        for (const p of points) arena.fx.explosion(p, 3, 0xff5a1f);
        arena.notify('The sky is coming down — keep moving', 'warning');
        break;
      }
      case 'quake': {
        const centre = this.self.position.clone();
        arena.splash(centre, QUAKE_RADIUS, QUAKE_DAMAGE_CENTRE, QUAKE_DAMAGE_EDGE, this.self, {
          selfDamage: false,
          impactForce: QUAKE_IMPULSE,
        });
        for (const t of arena.tanks) {
          if (t === this.self || !t.alive || !arena.areEnemies(this.self, t)) continue;
          if (t.position.distanceTo(centre) <= QUAKE_RADIUS * 0.5) t.status.apply('stun', 1, 0.6, this.self.id);
        }
        arena.fx.explosion(centre, QUAKE_RADIUS, 0xff7a2f);
        break;
      }
      case 'barrage': {
        const aim = this.barrageAim();
        if (!aim) break;
        this.barrage = { remaining: this.deps.phase().shells, timer: 0, aim };
        break;
      }
      case 'overcharge': {
        // Nitro and Double Damage are the two effects a status-immune hull still
        // accepts, which is exactly the enrage this wants: faster and hitting
        // twice as hard, with no new rules to learn.
        this.self.status.apply('nitro', 1, OVERCHARGE_DURATION, this.self.id);
        this.self.status.apply('doubleDamage', 1, OVERCHARGE_DURATION, this.self.id);
        this.chargeUntil = arena.time + OVERCHARGE_DURATION;
        arena.fx.supplyBurst(this.self.position, 0xf87171, 3.4);
        break;
      }
    }
  }

  /**
   * Centre of the densest knot of raiders, or the last place it saw its target
   * — as long as that ground is far enough away to shell. The standoff counts
   * the shells' own scatter, so a barrage walking six metres wide still lands
   * outside its own blast.
   */
  private barrageAim(): CANNON.Vec3 | null {
    const here = this.self.position;
    const standoff = BARRAGE_SPLASH_RADIUS * this.blastClearance + BARRAGE_SPREAD;
    const raiders = this.visibleRaiders().filter((t) => t.position.distanceTo(here) > standoff);
    let best: Tank | null = null;
    let bestCount = 0;
    for (const a of raiders) {
      let n = 0;
      for (const b of raiders) if (a.position.distanceTo(b.position) <= BARRAGE_SPLASH_RADIUS) n += 1;
      if (n > bestCount) {
        bestCount = n;
        best = a;
      }
    }
    if (best) return best.position.clone();
    const track = this.currentTrack();
    if (track && track.lastKnown.distanceTo(here) > standoff) return track.lastKnown.clone();
    return null;
  }

  private updateBarrage(dt: number): void {
    const b = this.barrage;
    if (!b) return;
    b.timer -= dt;
    if (b.timer > 0) return;
    b.timer = BARRAGE_INTERVAL;
    b.remaining -= 1;
    this.fireBarrageShell(b.aim);
    if (b.remaining <= 0) this.barrage = null;
  }

  private fireBarrageShell(aim: CANNON.Vec3): void {
    const arena = this.deps.arena;
    const muzzle = this.self.muzzle(new CANNON.Vec3());
    const target = new CANNON.Vec3(
      aim.x + randRange(-BARRAGE_SPREAD, BARRAGE_SPREAD),
      aim.y,
      aim.z + randRange(-BARRAGE_SPREAD, BARRAGE_SPREAD),
    );
    const delta = target.vsub(muzzle);
    const horizontal = Math.hypot(delta.x, delta.z);
    const pitch = ballisticPitch(horizontal, delta.y, BARRAGE_SPEED, BARRAGE_GRAVITY);
    if (pitch == null) return;

    const yaw = Math.atan2(delta.x, delta.z);
    const cp = Math.cos(pitch);
    // Time of flight straight off the horizontal component, which is what the
    // squad's zone deadline has to match: a lobbed shell is the one thing in
    // the mode where the warning and the impact are seconds apart.
    this.deps.warn?.(
      target.x,
      target.z,
      BARRAGE_SPLASH_RADIUS,
      Math.max(0.6, horizontal / Math.max(1, BARRAGE_SPEED * cp)),
      'barrage',
    );
    arena.spawnProjectile({
      owner: this.self,
      turret: this.self.turretDef,
      position: muzzle,
      direction: new CANNON.Vec3(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp),
      speed: BARRAGE_SPEED,
      damage: BARRAGE_DAMAGE,
      weakDamage: BARRAGE_DAMAGE,
      impactForce: 2.4,
      // Its own ordnance, like everything else it throws. The standoff in
      // `barrageAim` is what keeps that theoretical.
      selfDamage: true,
      colour: 0xff8844,
      radius: 0.5,
      gravity: BARRAGE_GRAVITY,
      splash: {
        radius: BARRAGE_SPLASH_RADIUS,
        damageMax: BARRAGE_DAMAGE,
        damageMin: BARRAGE_DAMAGE * 0.35,
      },
      maxLife: 9,
      trail: true,
    });
    arena.fx.muzzleFlash(muzzle, new CANNON.Vec3(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp), 0xff8844);
  }

  // ---- meteor storm -----------------------------------------------------

  private updateStorm(dt: number): void {
    const s = this.storm;
    if (!s) return;
    s.timer -= dt;
    if (s.timer > 0) return;
    s.timer = METEOR_INTERVAL;
    s.remaining -= 1;
    this.dropMeteor(s);
    if (s.remaining <= 0) this.storm = null;
  }

  /**
   * One rock. It comes in off the top of the sky on a steep line from a random
   * bearing — a real projectile, flown and swept like any other shell, so it can
   * be caught on a roof and can hit somebody on the way down.
   *
   * `selfDamage` is what puts the Overseer inside its own bombardment. The sweep
   * skips the firing hull, as it does for every shell in the game, so a rock
   * aimed at the boss's feet passes through it and detonates on the deck under
   * it — the blast is what catches it, at point-blank range, which lands in the
   * same place.
   *
   * The ground ring is spawned with exactly the flight time and closes over it,
   * so the marker is not an approximation of when it lands: it *is* when it
   * lands, and a raider who reads it is a raider who is somewhere else.
   */
  private dropMeteor(storm: Storm): void {
    const arena = this.deps.arena;
    const aim = this.meteorAim();
    const impact = new CANNON.Vec3(
      aim.x + randRange(-METEOR_SPREAD, METEOR_SPREAD),
      aim.y,
      aim.z + randRange(-METEOR_SPREAD, METEOR_SPREAD),
    );

    const bearing = Math.random() * Math.PI * 2;
    const lateral = METEOR_ALTITUDE / Math.tan(METEOR_ENTRY_DEG * DEG);
    const from = new CANNON.Vec3(
      impact.x + Math.sin(bearing) * lateral,
      impact.y + METEOR_ALTITUDE,
      impact.z + Math.cos(bearing) * lateral,
    );
    const delta = impact.vsub(from);
    const flight = delta.length() / METEOR_SPEED;

    // The storm is the one thing it is *meant* to take on the chin, so the
    // blast lesson is muted for as long as this rock could still be falling.
    this.stormSettlesAt = Math.max(this.stormSettlesAt, arena.time + flight + 0.6);

    arena.fx.incoming(impact, 0xff5a1f, METEOR_SPLASH_RADIUS, flight);
    // The same ring, in a form a squadmate can read. The ground marker and this
    // are one piece of information published to two kinds of raider.
    this.deps.warn?.(impact.x, impact.z, METEOR_SPLASH_RADIUS, flight, 'storm');
    arena.spawnProjectile({
      owner: this.self,
      turret: this.self.turretDef,
      position: from,
      direction: delta,
      speed: METEOR_SPEED,
      // Flat with range: this is a rock arriving, not a shot being taken.
      damage: METEOR_DIRECT,
      weakDamage: METEOR_DIRECT,
      impactForce: METEOR_IMPULSE,
      // The whole point. It is shelling coordinates, and it is standing in them.
      selfDamage: true,
      colour: 0xff6a24,
      radius: METEOR_SHELL_RADIUS,
      splash: {
        radius: METEOR_SPLASH_RADIUS,
        damageMax: METEOR_SPLASH_MAX,
        damageMin: METEOR_SPLASH_MIN,
      },
      maxLife: flight + 1.5,
      trail: true,
      smokeTrail: true,
    });

    if (
      !storm.warnedSelf &&
      Math.hypot(impact.x - this.self.position.x, impact.z - this.self.position.z) <= METEOR_SPLASH_RADIUS
    ) {
      storm.warnedSelf = true;
      arena.notify(`${this.self.name} is walking the storm over its own position`, 'warning');
    }
  }

  /**
   * Where the next rock goes: somebody it can account for, the one it is
   * hunting counted twice. Nothing here checks whether the boss is standing in
   * the blast — deliberately, and it is the one place that is true. The gun
   * will not fire a shell that can reach the Overseer; the storm is called down
   * on coordinates whether it is standing in them or not. A raid that fights it
   * inside its own storm is trading its hulls for the Overseer's health bar,
   * and that trade is the ability.
   */
  private meteorAim(): CANNON.Vec3 {
    const pool: CANNON.Vec3[] = [];
    for (const track of this.perception.remembered()) {
      if (!track.tank.alive) continue;
      const at = track.visible ? track.tank.position : track.lastKnown;
      pool.push(at.clone());
      if (track.tank === this.target) pool.push(at.clone());
    }
    if (!pool.length) return this.self.position.clone();
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /**
   * Purge throws the raid off the hull *and* patches the boss on the way out,
   * so it is worth spending for either half. It waits for bodies to throw while
   * it is healthy, and stops waiting once the heal alone is worth having.
   */
  private considerOverdrive(): void {
    if (this.self.overdriveCharge < 100) return;
    const arena = this.deps.arena;
    const radius = this.self.hull.overdrive.radius ?? 24;
    let near = 0;
    for (const t of arena.tanks) {
      if (t === this.self || !t.alive || !arena.areEnemies(this.self, t)) continue;
      if (t.position.distanceTo(this.self.position) <= radius) near += 1;
    }
    const hurt = this.self.healthFraction;
    if (near >= 2 || (near >= 1 && hurt < 0.35) || hurt < PURGE_HEAL_AT) this.pendingOverdrive = true;
  }

  // ---- supplies ---------------------------------------------------------

  /**
   * The Overseer carries field supplies and spends them the way you do. The
   * repair kit is the one that matters: its over-time half is interrupted by
   * damage exactly as yours is, so a boss that has just used one is a boss the
   * raid can punish for it. It knows that too, and prefers a quiet moment —
   * unless it is hurt enough that waiting is worse.
   */
  private considerSupplies(): void {
    const self = this.self;
    const arena = this.deps.arena;
    const hp = self.healthFraction;
    const quiet = arena.time - self.lastAttackedAt > BOSS_REPAIR_QUIET;

    if (hp < BOSS_REPAIR_AT && (quiet || hp < BOSS_REPAIR_DESPERATE) && self.canUseSupply('repair')) {
      self.useSupply('repair', arena);
      arena.notify(`${self.name} is running a repair kit — break it off`, 'warning');
      return;
    }
    const pressed = this.visibleRaiders().length >= 2;
    if (pressed && hp < 0.6 && self.canUseSupply('armor')) {
      self.useSupply('armor', arena);
      arena.notify(`${self.name} plated up`, 'warning');
      return;
    }
    if (pressed && this.deps.phase().index >= 3 && self.canUseSupply('damage')) {
      self.useSupply('damage', arena);
      arena.notify(`${self.name} is loading heavy shells`, 'warning');
    }
  }

  /**
   * A repair box on the floor is health the boss can have for the price of a
   * drive, so a hurt Overseer will break off a fight to go and take one. That
   * makes box control matter in a mode that otherwise ignores it, and it is the
   * one reliable way to pull the boss off a position it likes.
   */
  private supplyRun(): CANNON.Vec3 | null {
    if (this.self.healthFraction > BOSS_BOX_AT) {
      this.boxGoal = null;
      return null;
    }
    const want: SupplyKind[] = this.self.supplies.repair.count > 0 ? ['armor', 'damage'] : ['repair', 'armor'];
    const box = this.deps.nearestSupply(this.self.position, want);
    if (!box || box.pos.distanceTo(this.self.position) > BOSS_BOX_REACH) {
      this.boxGoal = null;
      return null;
    }
    if (!this.boxGoal || this.boxGoal.distanceTo(box.pos) > 2) {
      this.boxGoal = box.pos.clone();
      this.deps.arena.notify(`${this.self.name} is going for a supply box`, 'warning');
    }
    return box.pos.clone();
  }

  // ---- phases -----------------------------------------------------------

  /**
   * Crossing a gate is an event. It announces itself, throws whoever is on the
   * hull off it, and from Wrath onward leaves the boss permanently supercharged
   * — the raid should be able to hear the fight change without reading the bar.
   */
  private checkPhase(): void {
    const phase = this.deps.phase();
    if (phase.index <= this.lastPhase) return;
    this.lastPhase = phase.index;

    const arena = this.deps.arena;
    const centre = this.self.position.clone();
    arena.notify(`${this.self.name} — PHASE ${phase.index}: ${phase.name.toUpperCase()}`, 'warning');
    arena.splash(centre, PHASE_PULSE_RADIUS, PHASE_PULSE_DAMAGE, PHASE_PULSE_DAMAGE * 0.4, this.self, {
      selfDamage: false,
      impactForce: PHASE_PULSE_IMPULSE,
    });
    arena.fx.explosion(centre, PHASE_PULSE_RADIUS, 0xf87171);
    // A gate always resets the rotation: the phase you just bought is spent
    // immediately rather than after whatever cooldown was still running.
    for (const id of Object.keys(this.readyAt) as BossAbilityDef['id'][]) {
      this.readyAt[id] = Math.min(this.readyAt[id], arena.time + 2);
    }
    // And it comes out of the gate looking for somebody. The pressure wave that
    // has just thrown the raid off its hull, and then — while everyone is still
    // scattered and picking themselves up — it says a name. That ordering is
    // the most frightening three seconds the mode has, and it is free: both
    // halves already existed, they were simply never adjacent.
    this.markReadyAt = Math.min(this.markReadyAt, arena.time + 3);
    if (phase.enraged) arena.notify(`${this.self.name} IS BERSERK`, 'warning');
  }

  /**
   * Berserk is a standing effect, so it is topped up rather than applied once —
   * and it is re-read from the health bar every tick rather than latched, which
   * is what lets the frenzy ramp keep tightening the reload all the way down to
   * zero. Speed and damage are not applied here: they are multipliers the hull
   * and the damage funnel read directly, so there is one place each.
   *
   * The hull pulse quickens with the frenzy, so the last stretch of the fight
   * looks like what it is before anyone has read a number.
   */
  private updateEnrage(dt: number): void {
    if (!this.deps.phase().enraged) return;
    const frenzy = frenzyFor(this.self.healthFraction);
    this.self.status.apply('supercharge', bossFireRate(this.self.healthFraction), 2, this.self.id);
    this.pulseTimer -= dt * (0.5 + frenzy * 1.6);
    if (this.pulseTimer <= 0 && !this.telegraph) {
      this.pulseTimer = 0.5;
      this.deps.arena.fx.supplyBurst(this.self.position, 0xf87171, 2.2 + frenzy * 2);
    }
  }

  // ---- presence ---------------------------------------------------------

  /**
   * The dread floor: a rumble through the player's hull that rises as the
   * Overseer closes and falls away as it leaves.
   *
   * This does nothing. It deals no damage, it cannot be countered, and there is
   * no correct response to it — which is the only reason it works. Every other
   * cue the boss gives is information the raid is expected to act on, and a
   * fight made entirely of actionable cues has no atmosphere between them: for
   * twenty seconds at a time the most frightening thing on the map was a tank
   * driving around normally.
   *
   * Scaled by how fast it is actually moving as well as by range, so the floor
   * tells you the thing raiders most want to know and are least able to look
   * up: not just that it is near, but that it is *coming*.
   */
  private updatePresence(dt: number): void {
    const arena = this.deps.arena;
    const player = arena.tanks.find((t) => t.isPlayer && t.alive);
    if (!player) {
      this.dread = 0;
      return;
    }

    const gap = this.self.position.distanceTo(player.position);
    const closeness = clamp(1 - gap / DREAD_RADIUS, 0, 1);
    // Squared, so the rumble is nothing across the map and unmistakable in the
    // last few metres rather than a flat hum everywhere inside the radius.
    const motion = clamp(this.self.vehicle.speed / 12, 0.3, 1);
    this.dread = closeness * closeness * motion;
    if (this.dread <= 0.001) return;

    // Fed into the same shake the camera already consumes, and left to that
    // channel's own decay to reach equilibrium — so it is a sustained floor
    // under the fight rather than an event competing with the explosions.
    arena.fx.shake = Math.min(1.6, arena.fx.shake + this.dread * DREAD_SHAKE * dt);
  }

  /**
   * Running raiders over. A six-tonne hull moving at siege speed is a weapon in
   * its own right, and without this the answer to a boss that has doubled its
   * speed is to stand where it cannot depress its gun — which would make the
   * whole escalation something you solve by hugging it.
   *
   * Per-raider cooldown, so being scraped along a wall is one hit rather than
   * sixty, and the damage scales with how fast it was actually going.
   */
  private updateRam(): void {
    if (this.deps.phase().index < RAM_FROM_PHASE) return;
    const arena = this.deps.arena;
    const speed = this.self.vehicle.speed;
    if (speed < RAM_MIN_SPEED) return;

    const size = this.self.hull.size;
    const half = Math.max(size[0], size[2]) / 2;
    const over = Math.min(speed - RAM_MIN_SPEED, RAM_SPEED_WINDOW);

    // It stops going round raiders at siege speed; this is what stops it going
    // round *buildings* at the same time. On the same cooldown as running a
    // raider over, because a Juggernaut grinding along a wall for four seconds
    // should knock it down once, not sixty times.
    if (arena.time >= this.structureRamAt) {
      this.structureRamAt = arena.time + RAM_COOLDOWN;
      this.deps.demolish?.(
        this.self.position,
        half + RAM_DEMOLITION_REACH,
        RAM_DEMOLITION_POWER * (1 + over / RAM_SPEED_WINDOW),
      );
    }

    for (const t of arena.tanks) {
      if (t === this.self || !t.alive || !arena.areEnemies(this.self, t)) continue;
      const reach = half + Math.max(t.hull.size[0], t.hull.size[2]) / 2 + RAM_REACH;
      if (this.self.position.distanceTo(t.position) > reach) continue;
      if (arena.time < (this.ramReadyAt.get(t.id) ?? 0)) continue;
      this.ramReadyAt.set(t.id, arena.time + RAM_COOLDOWN);

      const at = t.centre();
      arena.damage(t, RAM_DAMAGE + RAM_SPEED_BONUS * over, this.self, { kind: 'contact', at });
      const push = t.position.vsub(this.self.position);
      push.y = 0;
      if (push.lengthSquared() < 1e-4) push.set(0, 0, 1);
      push.normalize();
      push.y = 0.45;
      t.vehicle.applyImpulse(push, RAM_IMPULSE);
      arena.fx.impact(at, new CANNON.Vec3(0, 1, 0), 0xff7a2f, 1.6);
    }
  }

  // ---- positioning ------------------------------------------------------

  private updateGoal(): void {
    // A hunt outranks everything, supply boxes included. The box detour is the
    // squad's reliable lever for pulling the Overseer off ground it likes, and
    // while it is fixated that lever is *switched off* — a boss that breaks off
    // a hunt to go and pick up a repair kit is a boss nobody was afraid of.
    if (this.quarry?.alive) {
      const track = this.perception.get(this.quarry.id);
      this.setGoal(track ? (track.visible ? this.quarry.position.clone() : track.lastKnown.clone()) : this.searchPoint());
      return;
    }

    // A box it wants outranks everything else it might be doing, including the
    // raider currently shooting it. Breaking the boss's position is what a
    // squad gets out of contesting one.
    const box = this.supplyRun();
    if (box) {
      this.setGoal(box);
      return;
    }

    const track = this.currentTrack();
    if (!track) {
      if (!this.hasPath()) this.setGoal(this.searchPoint());
      return;
    }

    // Overcharged — or berserk, which is the same thing permanently — it stops
    // managing range, stops looking for a wall to put its back against, and
    // simply drives at whoever it wants. At Wrath speed that is not a worse
    // position for it, it is the shortest line to a ram.
    //
    // The gun goes quiet as it arrives, because the blast guard is still on: a
    // charging Overseer trades its shells for its hull and its Quake, which is
    // the fight it wanted anyway.
    if (this.deps.arena.time < this.chargeUntil || this.deps.phase().enraged) {
      this.setGoal(track.lastKnown.clone());
      return;
    }

    this.goalTimer -= TICK;
    if (this.goalTimer > 0 && this.hasPath()) return;
    this.goalTimer = randRange(1.8, 2.8);
    this.setGoal(this.choosePosition(track) ?? track.lastKnown.clone());
  }

  /**
   * Ground it wants to be standing on: inside its own damage band, able to see
   * the target, with a wall behind its engine deck and the raid in front of it
   * rather than around it.
   */
  private choosePosition(track: Track): CANNON.Vec3 | null {
    const arena = this.deps.arena;
    const nav = this.deps.nav;
    const primary = track.visible ? track.tank.centre() : track.lastKnown;
    const [near, far] = preferredRange(this.self.turretDef);
    // Its own blast is a floor under the band as well as a gate on the trigger:
    // ground it cannot shoot from is not ground worth driving to.
    const safe = this.safeBlastDistance();
    const band = Math.max(near + (far - near) * 0.4, safe * 1.3);
    const here = this.self.position;
    const raiders = this.visibleRaiders();

    let best: CANNON.Vec3 | null = null;
    let bestScore = -Infinity;
    for (let i = 0; i < 14; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = randRange(6, 30);
      const idx = nav.nearestWalkable(here.x + Math.cos(angle) * radius, here.z + Math.sin(angle) * radius, 2);
      if (idx < 0) continue;
      const cell = nav.cellCentre(idx);
      const eye = new CANNON.Vec3(cell.x, cell.y + 1.6, cell.z);

      let score = -Math.abs(cell.distanceTo(primary) - band) * 2.2;
      score += arena.phys.lineOfSight(eye, primary, this.self.vehicle.body) ? 34 : -70;
      score += this.rearCovered(eye, primary) ? 30 : 0;
      score -= this.envelopment(cell, raiders) * 26;
      score -= cell.distanceTo(here) * 0.55;
      // Standing inside its own blast radius of a raider is standing somewhere
      // its gun is switched off, however good the cover behind it looks.
      if (safe > 0 && raiders.some((t) => t.position.distanceTo(cell) < safe)) score -= 90;
      if (score > bestScore) {
        bestScore = score;
        best = cell;
      }
    }
    return best;
  }

  /** True when something solid sits close behind, measured away from the threat. */
  private rearCovered(eye: CANNON.Vec3, threat: CANNON.Vec3): boolean {
    const away = eye.vsub(threat);
    away.y = 0;
    const len = Math.hypot(away.x, away.z);
    if (len < 0.01) return false;
    away.scale(1 / len, away);
    const behind = eye.vadd(away.scale(REAR_COVER_REACH));
    return this.deps.arena.phys.raycast(eye, behind, WORLD_MASK, this.self.vehicle.body) !== null;
  }

  /** 0 when the raid is all in one arc ahead, 1 when it has the boss ringed. */
  private envelopment(at: CANNON.Vec3, raiders: Tank[]): number {
    if (raiders.length < 2) return 0;
    const bearings = raiders
      .map((t) => Math.atan2(t.position.x - at.x, t.position.z - at.z))
      .sort((a, b) => a - b);
    let widestGap = 0;
    for (let i = 0; i < bearings.length; i++) {
      const next = i + 1 < bearings.length ? bearings[i + 1] : bearings[0] + Math.PI * 2;
      widestGap = Math.max(widestGap, next - bearings[i]);
    }
    return clamp((Math.PI * 2 - widestGap) / (Math.PI * 1.5), 0, 1);
  }

  /**
   * Where to go when it has lost everyone. It heads for its last contact, and
   * failing that for the middle of the map rather than wandering — a boss and a
   * raid that never find each other on a large map is the one outcome the mode
   * cannot survive.
   */
  private searchPoint(): CANNON.Vec3 {
    const remembered = this.perception.remembered();
    if (remembered.length) return remembered[0].lastKnown.clone();
    const nav = this.deps.nav;
    const cx = nav.originX + (nav.cols * 3) / 2;
    const cz = nav.originZ + (nav.rows * 3) / 2;
    for (let i = 0; i < 8; i++) {
      const spread = i * 6;
      const idx = nav.nearestWalkable(cx + randRange(-spread, spread), cz + randRange(-spread, spread), 3);
      if (idx >= 0) return nav.cellCentre(idx);
    }
    return this.self.position.clone();
  }

  // ---- movement ---------------------------------------------------------

  private setGoal(pos: CANNON.Vec3 | null): void {
    if (!pos) {
      this.goal = null;
      this.path = [];
      return;
    }
    const moved = !this.goal || this.goal.distanceTo(pos) > 5;
    this.goal = pos.clone();
    if (moved || !this.path.length) this.repath();
  }

  private repath(): void {
    if (!this.goal) return;
    this.repathTimer = randRange(0.8, 1.4);
    this.path = this.deps.nav.findPath(this.self.position.x, this.self.position.z, this.goal.x, this.goal.z);
    this.pathIndex = 0;
  }

  private hasPath(): boolean {
    return this.pathIndex < this.path.length;
  }

  private currentWaypoint(): CANNON.Vec3 | null {
    while (this.pathIndex < this.path.length) {
      const wp = this.path[this.pathIndex];
      if (Math.hypot(wp.x - this.self.position.x, wp.z - this.self.position.z) > 3) return wp;
      this.pathIndex += 1;
    }
    return null;
  }

  private updateMovement(dt: number): void {
    this.repathTimer -= dt;
    if (this.repathTimer <= 0 && this.goal) this.repath();

    const vehicle = this.self.vehicle;
    let forward = 0;
    let turn = 0;

    if (this.stilled) {
      // Dead stop. This is the beat the raid gets for free — a stationary
      // six-tonne target with its gun already committed — and it is the price
      // the boss pays for the silence being worth anything.
      forward = 0;
      turn = 0;
    } else if (this.unstickTimer > 0) {
      this.unstickTimer -= dt;
      forward = -1;
      turn = this.strafeSign;
    } else {
      const waypoint = this.currentWaypoint();
      const steer = waypoint ? this.avoid(this.driveTo(waypoint)) : { forward: 0, turn: this.faceThreat() };
      forward = steer.forward;
      turn = steer.turn;

      if (Math.abs(forward) > 0.1 && vehicle.speed < 0.8 && vehicle.isGrounded) {
        this.stuckTimer += dt;
        if (this.stuckTimer > 1.1) {
          this.unstickTimer = randRange(0.5, 0.9);
          this.stuckTimer = 0;
          this.strafeSign = -this.strafeSign;
          this.repathTimer = 0;
        }
      } else {
        this.stuckTimer = Math.max(0, this.stuckTimer - dt);
      }
    }

    if (vehicle.isInverted) vehicle.requestFlip();
    vehicle.update(dt, {
      forward,
      turn,
      // The phase multiplier is the escalation the raid feels first: by Wrath
      // this hull is quicker than every medium in the garage, and it is still
      // accelerating as the bar empties. Capped so it stays a tank.
      speedScale: Math.min(
        BOSS_SPEED_CAP,
        this.self.movementScale *
          (bossSpeedScale(this.self.healthFraction) + (this.quarry ? MARK_SPEED_BONUS : 0)),
      ),
      locked: this.self.weapon.movementLocked,
    });
  }

  private driveTo(waypoint: CANNON.Vec3): { forward: number; turn: number } {
    const delta = angleDelta(
      this.self.vehicle.yaw,
      Math.atan2(waypoint.x - this.self.position.x, waypoint.z - this.self.position.z),
    );
    return {
      // A six-tonne hull that keeps full power through a hard turn just plows
      // into the wall it was trying to round.
      forward: Math.abs(delta) > 1.9 ? -0.5 : Math.abs(delta) > 1 ? 0.35 : 1,
      turn: clamp(delta * 2.2, -1, 1),
    };
  }

  /**
   * Standing still, it keeps its glacis toward whoever it is fighting. That is
   * not decoration: the engine deck at the back is where raiders do extra
   * damage, so facing the threat is the boss protecting its weak point.
   */
  private faceThreat(): number {
    const track = this.currentTrack();
    if (!track) return 0;
    const to = track.visible ? track.tank.position : track.lastKnown;
    const delta = angleDelta(this.self.vehicle.yaw, Math.atan2(to.x - this.self.position.x, to.z - this.self.position.z));
    return clamp(delta * 2.2, -1, 1);
  }

  private avoid(steer: { forward: number; turn: number }): { forward: number; turn: number } {
    if (steer.forward <= 0) return steer;
    const phys = this.deps.arena.phys;
    const body = this.self.vehicle.body;
    const origin = this.self.centre();
    const yaw = this.self.vehicle.yaw;
    // Wider whiskers than a line bot's: this hull is four metres across.
    const reach = 6 + this.self.vehicle.speed * 0.9;

    let clearAhead = true;
    let bias = 0;
    for (const [offset, weight] of [
      [0, 0],
      [-0.55, 1],
      [0.55, -1],
    ] as const) {
      const a = yaw + offset;
      const to = new CANNON.Vec3(origin.x + Math.sin(a) * reach, origin.y, origin.z + Math.cos(a) * reach);
      const hit = phys.raycast(origin, to, WORLD_MASK, body);
      if (!hit) continue;
      if (offset === 0) clearAhead = false;
      bias += weight * (1 - hit.distance / reach);
    }
    if (clearAhead && bias === 0) return steer;

    return {
      forward: clearAhead ? steer.forward : steer.forward * 0.45,
      turn: clamp(steer.turn + bias * 1.6 + (bias === 0 ? this.strafeSign * 0.8 : 0), -1, 1),
    };
  }

  // ---- repair -----------------------------------------------------------

  /**
   * Disengage from it entirely and it patches itself, so a losing raid cannot
   * just hide and run the clock out — and a boss visibly repairing is a far
   * better prompt to go back in than a timer ticking down.
   *
   * Two conditions, both required: nobody in sight *and* nobody has hurt it for
   * a while. Raiders dying and running back in is still a fight, and it must
   * never be rewarded as though the raid had walked away. The ceiling is the top
   * of the phase it is currently in, so pushing it through a gate is permanent.
   *
   * A wipe is the exception, and it is what makes deaths expensive now that
   * nobody runs out of them: with the whole raid dead at once there is nobody
   * to interrupt it, and it patches six times as fast until somebody comes back.
   */
  private updateRepair(dt: number): void {
    const arena = this.deps.arena;
    const quiet =
      arena.time - this.self.lastAttackedAt > REGEN_DELAY &&
      !this.perception.remembered().some((t) => t.visible);
    if (!quiet) {
      this.unseenFor = 0;
      this.repairing = false;
      return;
    }

    const ceiling = this.self.maxHealth * this.deps.phase().from;
    if (this.self.health >= ceiling) return;

    const wiped = !arena.tanks.some((t) => t.alive && arena.areEnemies(this.self, t));
    this.unseenFor += dt;
    if (!this.repairing) {
      this.repairing = true;
      arena.notify(
        wiped
          ? `${this.self.name} is repairing while the raid is down`
          : `${this.self.name} is out of contact and repairing`,
        'warning',
      );
    }
    const rate = REGEN_PER_SECOND * (wiped ? WIPE_REGEN_MULTIPLIER : 1);
    const gain = Math.min(this.self.maxHealth * rate * dt, ceiling - this.self.health);
    arena.heal(this.self, gain, this.self);

    this.pulseTimer -= dt;
    if (this.pulseTimer <= 0) {
      this.pulseTimer = 0.5;
      arena.fx.supplyBurst(this.self.position, 0x86efac, 2);
    }
  }
}
