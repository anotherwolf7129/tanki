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
  BOSS_ABILITIES,
  OVERCHARGE_DURATION,
  QUAKE_DAMAGE_CENTRE,
  QUAKE_DAMAGE_EDGE,
  QUAKE_IMPULSE,
  QUAKE_RADIUS,
  REGEN_DELAY,
  REGEN_PER_SECOND,
  type BossAbilityDef,
  type RaidPhase,
} from '../data/raid';
import { angleDelta, ballisticPitch, clamp, DEG, predictIntercept, randRange } from '../core/mathx';
import { WORLD_MASK } from '../physics/world';
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
}

interface Telegraph {
  def: BossAbilityDef;
  remaining: number;
  total: number;
}

interface Barrage {
  remaining: number;
  timer: number;
  aim: CANNON.Vec3;
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
 * - **It protects its own weak point.** It prefers ground with a wall behind it
 *   and refuses to be surrounded, because its engine deck is where the damage
 *   is. Reaching that deck is a manoeuvre you have to earn.
 * - **It spends abilities on reasons.** Quake when raiders stack on it, Barrage
 *   when they hide, Overcharge when someone is isolated — each with a visible
 *   wind-up, so every one of them is something you could have avoided.
 * - **It will not be waited out.** Break contact entirely and it repairs.
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
  private readonly readyAt: Record<BossAbilityDef['id'], number> = {
    quake: 12,
    barrage: 8,
    overcharge: 30,
  };
  private chargeUntil = -1;
  private pulseTimer = 0;

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
    if (this.barrage) return BOSS_ABILITIES.barrage.displayName;
    return this.telegraph?.def.displayName ?? null;
  }

  /** 0..1 through the current wind-up, for the HUD's warning bar. */
  get telegraphProgress(): number {
    if (!this.telegraph) return this.barrage ? 1 : 0;
    return clamp(1 - this.telegraph.remaining / this.telegraph.total, 0, 1);
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
      this.target = this.pickTarget();
      this.considerAbility(now);
      this.considerOverdrive();
      this.updateGoal();
    }

    this.updateTelegraph(dt);
    this.updateBarrage(dt);
    this.updateAim(dt);
    this.updateFiring();
    this.updateMovement(dt);
    this.updateRepair(dt);
  }

  onDeath(): void {
    this.target = null;
    this.telegraph = null;
    this.barrage = null;
    this.path = [];
    this.goal = null;
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
        this.threat.set(t.id, (this.threat.get(t.id) ?? 0) + (t.damageDealt - seen));
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

  private pickTarget(): Tank | null {
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
    if (this.telegraph || this.barrage) {
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

    weapon.intent.fire = true;
  }

  // ---- abilities --------------------------------------------------------

  /**
   * Each ability answers a specific problem the raid is causing it, so the one
   * it picks is readable from the outside: stack on it and it quakes, hide and
   * it lobs, spread out and it picks the loner off.
   */
  private considerAbility(now: number): void {
    if (this.telegraph || this.barrage) return;

    const arena = this.deps.arena;
    const phase = this.deps.phase();
    const raiders = this.visibleRaiders();
    const here = this.self.position;
    const track = this.currentTrack();

    const close = raiders.filter((t) => t.position.distanceTo(here) <= QUAKE_RADIUS * 0.85);
    const wants: BossAbilityDef['id'][] = [];

    if (close.length >= 2 || (close.length === 1 && this.self.healthFraction < 0.5)) wants.push('quake');
    if ((track && !track.visible) || this.densestCluster(raiders) >= 2) wants.push('barrage');
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
      this.telegraph = { def, remaining: def.windup, total: def.windup };
      this.readyAt[id] = now + def.windup + def.cooldown * phase.cooldownScale;
      arena.notify(def.warning, 'warning');
      return;
    }
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

    // A pulsing ring at the hull, so the wind-up is something you can see from
    // across the map rather than only something the kill feed mentioned.
    this.pulseTimer -= dt;
    if (this.pulseTimer <= 0) {
      this.pulseTimer = 0.16;
      this.deps.arena.fx.supplyBurst(this.self.position, 0xff4d4d, 1.6 + this.telegraphProgress * 2.4);
    }

    t.remaining -= dt;
    if (t.remaining > 0) return;
    this.telegraph = null;
    this.execute(t.def);
  }

  private execute(def: BossAbilityDef): void {
    const arena = this.deps.arena;
    switch (def.id) {
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

  /** Centre of the densest knot of raiders, or the last place it saw its target. */
  private barrageAim(): CANNON.Vec3 | null {
    const raiders = this.visibleRaiders();
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
    return track ? track.lastKnown.clone() : null;
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
    arena.spawnProjectile({
      owner: this.self,
      turret: this.self.turretDef,
      position: muzzle,
      direction: new CANNON.Vec3(Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp),
      speed: BARRAGE_SPEED,
      damage: BARRAGE_DAMAGE,
      weakDamage: BARRAGE_DAMAGE,
      impactForce: 2.4,
      selfDamage: false,
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

  private considerOverdrive(): void {
    if (this.self.overdriveCharge < 100) return;
    const arena = this.deps.arena;
    const radius = this.self.hull.overdrive.radius ?? 24;
    let near = 0;
    for (const t of arena.tanks) {
      if (t === this.self || !t.alive || !arena.areEnemies(this.self, t)) continue;
      if (t.position.distanceTo(this.self.position) <= radius) near += 1;
    }
    // Purge is a reset button, not an opener: it wants bodies to throw.
    if (near >= 2 || (near >= 1 && this.self.healthFraction < 0.35)) this.pendingOverdrive = true;
  }

  // ---- positioning ------------------------------------------------------

  private updateGoal(): void {
    const track = this.currentTrack();
    if (!track) {
      if (!this.hasPath()) this.setGoal(this.searchPoint());
      return;
    }

    // Overcharged, it stops managing range and simply runs someone down.
    if (this.deps.arena.time < this.chargeUntil) {
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
    const band = near + (far - near) * 0.4;
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

    if (this.unstickTimer > 0) {
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
      speedScale: this.self.status.movementScale,
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

    this.unseenFor += dt;
    if (!this.repairing) {
      this.repairing = true;
      arena.notify(`${this.self.name} is out of contact and repairing`, 'warning');
    }
    const gain = Math.min(this.self.maxHealth * REGEN_PER_SECOND * dt, ceiling - this.self.health);
    arena.heal(this.self, gain, this.self);

    this.pulseTimer -= dt;
    if (this.pulseTimer <= 0) {
      this.pulseTimer = 0.5;
      arena.fx.supplyBurst(this.self.position, 0x86efac, 2);
    }
  }
}
