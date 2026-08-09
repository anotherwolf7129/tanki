import * as CANNON from 'cannon-es';
import type { SplashDef, TurretDef } from '../data/schema';
import { DEFAULT_HEAT_CEILING } from '../data/augments';
import { clamp, DEG } from '../core/mathx';
import { SHOT_MASK } from '../physics/world';
import type { Arena } from '../game/types';
import type { Tank } from './tank';

export interface FireIntent {
  fire: boolean;
  alt: boolean;
  scope: boolean;
}

const TURRET_COLOURS: Record<string, number> = {
  firebird: 0xff7a2f,
  freeze: 0x7dd3fc,
  isida: 0x86efac,
  tesla: 0xa5b4fc,
  hammer: 0xfbbf24,
  twins: 0x38bdf8,
  ricochet: 0x22d3ee,
  smoky: 0xfacc15,
  striker: 0xfb7185,
  vulcan: 0xfb923c,
  thunder: 0xf97316,
  railgun: 0xe879f9,
  magnum: 0xf59e0b,
  gauss: 0x818cf8,
  shaft: 0x67e8f9,
  terminator: 0xef4444,
  cataclysm: 0xff5a3c,
};

/**
 * How full a drained tank has to refill before the trigger works again. The
 * fraction sets the rhythm rather than the uptime — that is fixed by the drain
 * and recharge rates — and a low one chops a held stream into stutters too
 * short to finish anything with.
 */
const FUEL_UNLOCK_FRACTION = 0.5;

/** Full damage inside `rangeMaxDamage`, linear down to `weakDamage`, then flat. */
export function damageAtRange(t: TurretDef, base: number, weak: number, d: number): number {
  if (t.hardCap != null && d > t.hardCap) return 0;
  if (d <= t.rangeMaxDamage) return base;
  if (d >= t.rangeMinDamage) return weak;
  const k = (d - t.rangeMaxDamage) / (t.rangeMinDamage - t.rangeMaxDamage);
  return base + (weak - base) * k;
}

/**
 * Every firing archetype in the spec, driven from the turret data table.
 * Adding a turret is a JSON edit as long as it reuses one of these modes.
 */
export class Weapon {
  readonly intent: FireIntent = { fire: false, alt: false, scope: false };

  private cooldown = 0;
  private clip: number;
  private reloading = false;
  private reloadRemaining = 0;
  private charge = 0;
  private charging = false;
  private fuel: number;
  private fuelLocked = false;
  private heat = 0;
  private spin = 0;
  private critChance = 0;
  private lockProgress = 0;
  private lockTarget: Tank | null = null;
  private volleyRemaining = 0;
  private volleyTimer = 0;
  private barrel = 0;
  private tickAccum = 0;
  private firingRecently = 0;
  private beamTarget: Tank | null = null;
  scopedActive = false;

  /** Set by the shooter each tick; hitscan and cone modes need the exact ray. */
  private readonly tmpFrom = new CANNON.Vec3();
  private readonly tmpDir = new CANNON.Vec3();

  constructor(
    private readonly owner: Tank,
    readonly def: TurretDef,
  ) {
    this.clip = def.clip?.size ?? 0;
    this.fuel = def.fuel?.capacity ?? 0;
  }

  reset(): void {
    this.cooldown = 0;
    this.clip = this.def.clip?.size ?? 0;
    this.reloading = false;
    this.reloadRemaining = 0;
    this.charge = 0;
    this.charging = false;
    this.fuel = this.def.fuel?.capacity ?? 0;
    this.fuelLocked = false;
    this.heat = 0;
    this.spin = 0;
    this.critChance = 0;
    this.lockProgress = 0;
    this.lockTarget = null;
    this.volleyRemaining = 0;
    this.beamTarget = null;
    this.scopedActive = false;
    // Tick accumulators carry over into the next life otherwise, which lets a
    // respawned sustained-fire turret land a free tick the instant it opens up.
    this.tickAccum = 0;
    this.firingRecently = 0;
    this.barrel = 0;
    this.intent.fire = false;
    this.intent.alt = false;
    this.intent.scope = false;
  }

  // ---- HUD-facing state -------------------------------------------------

  get colour(): number {
    return TURRET_COLOURS[this.def.id] ?? 0xffffff;
  }
  get reloadFraction(): number {
    const total = this.reloading ? this.currentReloadTime() : Math.max(0.0001, this.currentReloadTime());
    return clamp(1 - (this.reloading ? this.reloadRemaining : this.cooldown) / total, 0, 1);
  }
  get clipRemaining(): number {
    return this.clip;
  }
  get clipSize(): number {
    return this.def.clip?.size ?? 0;
  }
  get fuelFraction(): number {
    return this.def.fuel ? clamp(this.fuel / this.def.fuel.capacity, 0, 1) : 1;
  }
  get heatFraction(): number {
    return clamp(this.heat, 0, this.heatCeiling);
  }
  /** Heat at which this barrel stops firing altogether. */
  get heatCeiling(): number {
    return this.def.heat?.ceiling ?? DEFAULT_HEAT_CEILING;
  }
  /**
   * The barrel is in the red: cooking its own driver, and — with Vulcan's
   * Ignition fitted — setting fire to whatever it hits.
   */
  get overheated(): boolean {
    return this.def.heat != null && this.heat > 1;
  }
  get chargeFraction(): number {
    const time = this.scopedActive ? (this.def.scoped?.chargeTime ?? 1) : (this.def.charge?.time ?? 1);
    return clamp(this.charge / time, 0, 1);
  }
  get isCharging(): boolean {
    return this.charging;
  }
  /** True when letting go of the trigger is what fires this turret. */
  get releaseFires(): boolean {
    return this.def.fireMode === 'sniper' || this.def.fireMode === 'dual';
  }
  get lockFraction(): number {
    return this.def.guided ? clamp(this.lockProgress / this.def.guided.lockTime, 0, 1) : 0;
  }
  get currentLockTarget(): Tank | null {
    return this.lockTarget;
  }
  get critChancePercent(): number {
    return this.critChance;
  }
  get ready(): boolean {
    return this.cooldown <= 0 && !this.reloading && (this.clipSize === 0 || this.clip > 0);
  }

  /** Multiplier applied to the hull's turret rotation speed. */
  get rotationMultiplier(): number {
    if (this.scopedActive && this.def.scoped) return this.def.scoped.rotationMultiplier;
    if (this.def.firingRotationMultiplier && this.firingRecently > 0) return this.def.firingRotationMultiplier;
    return 1;
  }

  get movementLocked(): boolean {
    return this.scopedActive && !!this.def.scoped?.movementLocked;
  }

  get scopeFov(): number | null {
    return this.scopedActive ? (this.def.scoped?.fov ?? null) : null;
  }

  // ---- main tick --------------------------------------------------------

  update(dt: number, arena: Arena): void {
    this.firingRecently = Math.max(0, this.firingRecently - dt);
    if (this.cooldown > 0) this.cooldown -= dt;
    if (this.reloading) {
      this.reloadRemaining -= dt;
      if (this.reloadRemaining <= 0) {
        this.reloading = false;
        this.clip = this.def.clip?.size ?? 0;
      }
    }

    const canFire = this.owner.status.canFire && this.owner.alive;
    const intent = canFire ? this.intent : { fire: false, alt: false, scope: false };

    switch (this.def.fireMode) {
      case 'cone':
        this.tickCone(dt, arena, intent);
        break;
      case 'beam':
        this.tickBeam(dt, arena, intent);
        break;
      case 'chain':
        this.tickChain(dt, arena, intent);
        break;
      case 'minigun':
        this.tickMinigun(dt, arena, intent);
        break;
      case 'sustained':
        this.tickSustained(dt, arena, intent);
        break;
      case 'shotgun':
      case 'bouncing':
        this.tickClip(dt, arena, intent);
        break;
      case 'hitscan':
        this.tickCharged(dt, arena, intent);
        break;
      case 'sniper':
        this.tickSniper(dt, arena, intent);
        break;
      case 'guided':
        this.tickGuided(dt, arena, intent);
        break;
      case 'dual':
        this.tickDual(dt, arena, intent);
        break;
      case 'ballistic':
      case 'splash':
      case 'single':
      default:
        this.tickSingle(dt, arena, intent);
        break;
    }

    this.regenFuel(dt);
  }

  // ---- archetypes -------------------------------------------------------

  private tickSingle(_dt: number, arena: Arena, intent: FireIntent): void {
    if (!intent.fire || !this.ready) return;
    this.fireShell(arena, this.def.damage, this.def.weakDamage, {
      speed: this.def.projectileSpeed ?? 400,
      gravity: this.def.gravity,
      splash: this.def.splash,
      impactForce: this.def.impactForce,
      recoil: this.def.recoil,
    });
    this.cooldown = this.currentReloadTime();
  }

  private tickSustained(_dt: number, arena: Arena, intent: FireIntent): void {
    if (!intent.fire || this.cooldown > 0) return;
    const barrels = this.def.barrels ?? 1;
    const offset = barrels > 1 ? (this.barrel % 2 === 0 ? -0.45 : 0.45) : 0;
    this.barrel += 1;
    this.fireShell(arena, this.def.damage, this.def.weakDamage, {
      speed: this.def.projectileSpeed ?? 220,
      impactForce: this.def.impactForce,
      recoil: this.def.recoil,
      splash: this.def.splash,
      lateralOffset: offset,
    });
    this.cooldown = this.currentReloadTime();
  }

  private tickMinigun(dt: number, arena: Arena, intent: FireIntent): void {
    const h = this.def.heat!;
    if (intent.fire && this.heat < this.heatCeiling) {
      this.spin = Math.min(1, this.spin + dt / h.spinUp);
      this.heat += h.risePerSec * dt;
      this.firingRecently = 0.25;
      if (this.spin >= 1 && this.cooldown <= 0) {
        this.fireShell(arena, this.def.damage, this.def.weakDamage, {
          speed: this.def.projectileSpeed ?? 500,
          impactForce: this.def.impactForce,
          recoil: this.def.recoil,
          splash: this.def.splash,
          spreadDeg: 0.7,
        });
        this.cooldown = this.currentReloadTime();
      }
    } else {
      this.spin = Math.max(0, this.spin - dt / (h.spinUp * 1.5));
      this.heat = Math.max(0, this.heat - h.fallPerSec * dt);
    }
    if (this.heat > 1) {
      // Overheating burns the shooter, softened by the hull's heat resistance.
      const resist = 1 - this.owner.hull.heatResistance / 100;
      arena.damage(this.owner, h.selfBurnDps * dt * resist, this.owner, { kind: 'self' });
    }
  }

  private tickClip(_dt: number, arena: Arena, intent: FireIntent): void {
    if (this.reloading) return;
    if (this.clip <= 0) {
      this.beginReload();
      return;
    }
    if (!intent.fire || this.cooldown > 0) return;

    if (this.def.pellets) {
      // A pellet carries its share of the blast, not the whole one: eight
      // full-strength detonations from one trigger pull would make a splash
      // shotgun the strongest gun in the game by an order of magnitude.
      const share = resolveSplash(this.def.splash, this.def.damage, 1 / this.def.pellets.count);
      for (let i = 0; i < this.def.pellets.count; i++) {
        this.fireShell(arena, this.def.damage, this.def.weakDamage, {
          speed: this.def.projectileSpeed ?? 300,
          impactForce: this.def.impactForce / this.def.pellets.count,
          recoil: i === 0 ? this.def.recoil : 0,
          splash: share,
          spreadDeg: this.def.pellets.spreadDeg,
          radius: 0.12,
          skipMuzzleFlash: i > 0,
        });
      }
    } else {
      this.fireShell(arena, this.def.damage, this.def.weakDamage, {
        speed: this.def.projectileSpeed ?? 260,
        impactForce: this.def.impactForce,
        recoil: this.def.recoil,
        splash: this.def.splash,
        bounces: this.def.bounces,
      });
    }

    this.clip -= 1;
    this.cooldown = this.def.clip!.shotInterval;
    if (this.clip <= 0) this.beginReload();
  }

  private tickCharged(dt: number, arena: Arena, intent: FireIntent): void {
    const c = this.def.charge!;
    if (!this.ready) {
      this.charging = false;
      this.charge = 0;
      return;
    }
    if (intent.fire) {
      this.charging = true;
      this.charge += dt;
      if (this.charge >= c.time) {
        this.fireHitscan(arena, this.def.damage, this.def.recoil, this.def.impactForce, this.def.pierce);
        this.charge = 0;
        this.charging = false;
        this.cooldown = this.currentReloadTime();
      }
    } else if (this.charging) {
      // Railgun charges are committed, not cancellable — release does nothing.
      if (!c.autoFire) {
        this.fireHitscan(arena, this.def.damage * this.chargeFraction, this.def.recoil, this.def.impactForce, this.def.pierce);
        this.cooldown = this.currentReloadTime();
      }
      this.charge = 0;
      this.charging = false;
    }
  }

  private tickSniper(dt: number, arena: Arena, intent: FireIntent): void {
    const s = this.def.scoped!;
    this.scopedActive = intent.scope;

    // Release always resolves the shot, even on the frame the scope drops —
    // the player's hold on the trigger is what scopes in, so letting go ends
    // both at once and the charge must not be swallowed by that.
    if (this.charging && !intent.fire) {
      const k = this.charge / s.chargeTime;
      const dmg = s.minDamage + (s.maxDamage - s.minDamage) * k;
      this.fireHitscan(arena, dmg, s.recoil, this.def.impactForce * (1 + k));
      this.cooldown = s.reloadTime;
      this.charge = 0;
      this.charging = false;
      return;
    }

    if (!this.scopedActive) {
      this.charge = 0;
      this.charging = false;
      // Arcade mode: a tap for a quick, capped shot. Bots use this at knife
      // range, where standing still to charge would be suicide.
      if (intent.fire && this.ready) {
        this.fireHitscan(arena, this.def.damage, this.def.recoil, this.def.impactForce);
        this.cooldown = this.def.reloadTime;
        this.intent.fire = false;
      }
      return;
    }

    if (!this.ready) {
      this.charge = 0;
      this.charging = false;
      return;
    }
    if (intent.fire) {
      this.charging = true;
      this.charge = Math.min(s.chargeTime, this.charge + dt);
    }
  }

  private tickGuided(dt: number, arena: Arena, intent: FireIntent): void {
    const g = this.def.guided!;

    if (this.volleyRemaining > 0) {
      this.volleyTimer -= dt;
      if (this.volleyTimer <= 0 && this.lockTarget) {
        this.volleyTimer = g.volleyInterval;
        this.volleyRemaining -= 1;
        this.fireShell(arena, this.def.damage, this.def.weakDamage, {
          speed: this.def.projectileSpeed ?? 40,
          impactForce: this.def.impactForce,
          recoil: this.volleyRemaining === g.missiles - 1 ? this.def.recoil : 0,
          splash: this.def.splash,
          spreadDeg: 6,
          homing: { target: this.lockTarget, turnRate: g.turnRate, acceleration: g.acceleration, maxSpeed: 90 },
          maxLife: 8,
          skipMuzzleFlash: false,
        });
        if (this.volleyRemaining <= 0) {
          this.cooldown = this.currentReloadTime();
          this.lockProgress = 0;
          this.lockTarget = null;
        }
      }
      return;
    }

    if (!intent.fire || !this.ready) {
      this.lockProgress = Math.max(0, this.lockProgress - dt * 2);
      if (this.lockProgress <= 0) this.lockTarget = null;
      return;
    }

    const candidate = this.pickBeamTarget(arena, this.def.rangeMinDamage, 5);
    if (!candidate) {
      this.lockProgress = Math.max(0, this.lockProgress - dt * 2);
      return;
    }
    if (candidate !== this.lockTarget) {
      this.lockTarget = candidate;
      this.lockProgress = 0;
    }
    this.lockProgress += dt;
    if (this.lockProgress >= g.lockTime) {
      this.volleyRemaining = g.missiles;
      this.volleyTimer = 0;
    }
  }

  /**
   * Tap for the light shot, hold to the top of the charge and release for the
   * super shot. Bots skip the charge and request `alt` directly.
   */
  private tickDual(dt: number, arena: Arena, intent: FireIntent): void {
    const alt = this.def.alt!;
    const chargeTime = this.def.charge?.time ?? 0.9;

    if (intent.alt) {
      this.charge = 0;
      this.charging = false;
      if (this.cooldown <= 0) this.fireAlt(arena, alt);
      return;
    }

    if (intent.fire) {
      // Winding up during the reload would let the player bank a super shot for
      // free, so the charge only starts once the gun is actually loaded.
      if (this.cooldown > 0) {
        this.charge = 0;
        this.charging = false;
        return;
      }
      this.charging = true;
      this.charge = Math.min(chargeTime, this.charge + dt);
      return;
    }

    if (!this.charging) return;
    const full = this.charge >= chargeTime;
    this.charging = false;
    this.charge = 0;
    if (this.cooldown > 0) return;
    if (full) {
      this.fireAlt(arena, alt);
    } else {
      this.fireShell(arena, this.def.damage, this.def.weakDamage, {
        speed: this.def.projectileSpeed ?? 420,
        impactForce: this.def.impactForce,
        recoil: this.def.recoil,
        splash: this.def.splash,
      });
      this.cooldown = this.currentReloadTime();
    }
  }

  private fireAlt(arena: Arena, alt: NonNullable<TurretDef['alt']>): void {
    this.fireShell(arena, alt.damage, alt.weakDamage, {
      speed: alt.projectileSpeed,
      impactForce: alt.impactForce,
      recoil: alt.recoil,
      splash: alt.splash,
      radius: 0.45,
    });
    this.cooldown = alt.reloadTime;
  }

  private tickCone(dt: number, arena: Arena, intent: FireIntent): void {
    const cone = this.def.cone!;
    const firing = intent.fire && this.consumeFuel(dt);
    this.owner.mesh.setStream(firing, this.colour);
    if (!firing) return;
    this.firingRecently = 0.2;

    this.tickAccum += dt;
    const step = 1 / cone.tickRate;
    if (this.tickAccum < step) return;
    const ticks = Math.floor(this.tickAccum / step);
    this.tickAccum -= ticks * step;

    const from = this.owner.muzzle(this.tmpFrom);
    const dir = this.owner.aimDirection(this.tmpDir);
    const cosLimit = Math.cos(cone.angleDeg * 0.5 * DEG);

    for (const other of arena.tanks) {
      if (other === this.owner || !other.alive) continue;
      const to = other.centre();
      const delta = to.vsub(from);
      const dist = delta.length();
      if (dist > cone.range || dist < 0.01) continue;
      if (delta.scale(1 / dist).dot(dir) < cosLimit) continue;
      if (!this.hasClearShot(arena, from, other, this.def.blockedByTanks !== false)) continue;

      const enemy = arena.areEnemies(this.owner, other);
      if (!enemy && !arena.settings.friendlyFire) {
        // Firebird thaws frozen allies; Freeze puts out their fires.
        this.applyAllySideEffect(other);
        continue;
      }
      const dmg =
        damageAtRange(this.def, this.def.damage, this.def.weakDamage, dist) *
        ticks *
        this.streamDamageScale;
      arena.damage(other, dmg, this.owner, { kind: 'direct', at: to });
      if (this.def.applies) {
        const a = this.def.applies;
        other.status.apply(a.effect, a.magnitude, a.duration, this.owner.id);
        if (a.effect === 'burning') other.status.remove('freezing');
        if (a.effect === 'freezing') other.status.remove('burning');
      }
    }
  }

  private applyAllySideEffect(ally: Tank): void {
    if (this.def.special?.includes('thawsAllies')) ally.status.remove('freezing');
    if (this.def.special?.includes('extinguishesBurn')) ally.status.remove('burning');
  }

  private tickBeam(dt: number, arena: Arena, intent: FireIntent): void {
    const beam = this.def.beam!;
    if (!intent.fire) {
      this.beamTarget = null;
      this.owner.mesh.setBeam(null, this.colour);
      return;
    }

    // Lock persists until line of sight breaks, which is what makes Isida
    // reward positioning rather than tracking.
    if (this.beamTarget && (!this.beamTarget.alive || !this.beamInRange(arena, this.beamTarget, beam.range, beam.lockConeDeg))) {
      this.beamTarget = null;
    }
    if (!this.beamTarget) this.beamTarget = this.pickBeamTarget(arena, beam.range, beam.lockConeDeg, true);
    const target = this.beamTarget;
    if (!target) {
      this.owner.mesh.setBeam(null, this.colour);
      return;
    }

    const healing = arena.areAllies(this.owner, target) && target !== this.owner;
    const drain = healing ? (this.def.fuel?.healDrainPerSec ?? 0.5) : (this.def.fuel?.drainPerSec ?? 1);
    if (this.def.fuel && !this.consumeFuel(dt, drain)) {
      this.owner.mesh.setBeam(null, this.colour);
      return;
    }

    this.owner.mesh.setBeam(target.centre(), healing ? 0x86efac : this.colour);
    this.tickAccum += dt;
    const step = 1 / beam.tickRate;
    if (this.tickAccum < step) return;
    const ticks = Math.floor(this.tickAccum / step);
    this.tickAccum -= ticks * step;

    if (healing) {
      arena.heal(target, (this.def.healPerTick ?? 0) * ticks, this.owner);
    } else if (arena.areEnemies(this.owner, target)) {
      const dmg = this.def.damage * ticks * this.streamDamageScale;
      arena.damage(target, dmg, this.owner, { kind: 'direct', at: target.centre() });
    }
  }

  private tickChain(dt: number, arena: Arena, intent: FireIntent): void {
    const ch = this.def.chain!;
    const firing = intent.fire && this.consumeFuel(dt);
    if (!firing) {
      this.owner.mesh.setBeam(null, this.colour);
      return;
    }
    this.tickAccum += dt;
    const step = 1 / ch.tickRate;
    if (this.tickAccum < step) {
      return;
    }
    const ticks = Math.floor(this.tickAccum / step);
    this.tickAccum -= ticks * step;

    const primary = this.pickBeamTarget(arena, this.def.hardCap ?? ch.jumpRange, 35);
    if (!primary) {
      this.owner.mesh.setBeam(null, this.colour);
      return;
    }

    let current = primary;
    let damage = this.def.damage * ticks * this.streamDamageScale;
    const hit = new Set<Tank>([current]);
    const points: CANNON.Vec3[] = [current.centre()];

    for (let jump = 0; jump <= ch.jumps; jump++) {
      arena.damage(current, damage, this.owner, { kind: 'direct', at: current.centre() });
      damage *= ch.falloff;
      const next = arena.tanks.find(
        (t) =>
          t.alive &&
          !hit.has(t) &&
          arena.areEnemies(this.owner, t) &&
          t.centre().distanceTo(current.centre()) <= ch.jumpRange,
      );
      if (!next) break;
      hit.add(next);
      points.push(next.centre());
      current = next;
    }
    this.owner.mesh.setBeam(points[0], this.colour);
    arena.fx.chain(this.owner.muzzle(), points, this.colour);
  }

  // ---- shared firing helpers -------------------------------------------

  private currentReloadTime(): number {
    const rate = this.owner.status.fireRateScale;
    return this.def.reloadTime / Math.max(0.1, rate);
  }

  /**
   * What one tick of a stream is worth after the shooter's buffs.
   *
   * The tick-based turrets used to be the only guns in the game a Double Damage
   * box did nothing for — the multiplier lives in `fireShell`, and a cone, a
   * beam and an arc never go near it. Rate-of-fire buffs missed them for the
   * same reason from the other side: a stream has no reload to shorten, so
   * Supercharge landed on every turret except the four that have to be in the
   * enemy's face to fire at all. Both fold into the tick instead.
   */
  private get streamDamageScale(): number {
    return this.owner.status.damageDealtScale * Math.max(0.1, this.owner.status.fireRateScale);
  }

  private beginReload(): void {
    if (this.reloading) return;
    this.reloading = true;
    this.reloadRemaining = this.currentReloadTime();
  }

  private regenFuel(dt: number): void {
    const f = this.def.fuel;
    if (!f) return;
    if (!this.intent.fire || this.fuelLocked) {
      this.fuel = Math.min(f.capacity, this.fuel + f.rechargePerSec * dt);
      if (this.fuel >= f.capacity * FUEL_UNLOCK_FRACTION) this.fuelLocked = false;
    }
  }

  private consumeFuel(dt: number, rate?: number): boolean {
    const f = this.def.fuel;
    if (!f) return true;
    if (this.fuelLocked) return false;
    this.fuel -= (rate ?? f.drainPerSec) * dt;
    if (this.fuel <= 0) {
      this.fuel = 0;
      this.fuelLocked = true;
      return false;
    }
    return true;
  }

  private rollCritical(): boolean {
    if (this.def.criticalDamage == null || this.def.maxCritChance == null) return false;
    const hit = Math.random() * 100 < this.critChance;
    if (hit) this.critChance = 0;
    else this.critChance = Math.min(this.def.maxCritChance, this.critChance + (this.def.critChanceStep ?? 0));
    return hit;
  }

  private applyRecoil(magnitude: number): void {
    // The gun always kicks visually, even for turrets whose recoil impulse on
    // the hull is zero — a shot with no movement at the muzzle reads as a bug.
    this.owner.onFired(magnitude);
    if (magnitude <= 0) return;
    const dir = this.owner.aimDirection(new CANNON.Vec3()).negate();
    this.owner.vehicle.applyImpulse(dir, magnitude);
  }

  private fireShell(
    arena: Arena,
    damage: number,
    weakDamage: number,
    opts: {
      speed: number;
      impactForce: number;
      recoil: number;
      gravity?: number;
      splash?: TurretDef['splash'];
      bounces?: number;
      spreadDeg?: number;
      lateralOffset?: number;
      radius?: number;
      homing?: { target: Tank; turnRate: number; acceleration: number; maxSpeed: number };
      maxLife?: number;
      skipMuzzleFlash?: boolean;
    },
  ): void {
    const scale = this.owner.status.damageDealtScale;
    const critical = this.rollCritical();
    const finalDamage = critical ? (this.def.criticalDamage ?? damage) * scale : damage * scale;
    const finalWeak = critical ? (this.def.criticalDamage ?? weakDamage) * scale : weakDamage * scale;

    const dir = this.owner.aimDirection(new CANNON.Vec3());
    if (opts.spreadDeg) applySpread(dir, opts.spreadDeg);

    const pos = this.owner.muzzle(new CANNON.Vec3());
    if (opts.lateralOffset) {
      const right = new CANNON.Vec3(Math.cos(this.owner.turretYaw), 0, -Math.sin(this.owner.turretYaw));
      pos.vadd(right.scale(opts.lateralOffset), pos);
    }

    arena.spawnProjectile({
      owner: this.owner,
      turret: this.def,
      position: pos,
      direction: dir,
      speed: opts.speed,
      damage: finalDamage,
      weakDamage: finalWeak,
      impactForce: opts.impactForce,
      selfDamage: this.def.selfDamage,
      colour: this.colour,
      radius: opts.radius ?? 0.22,
      gravity: opts.gravity,
      bounces: opts.bounces,
      // Resolved here rather than in the projectile so the blast obeys the same
      // multipliers as the direct hit — Double Damage used to leave the splash
      // half of a Thunder shell at base strength.
      splash: resolveSplash(opts.splash, damage, scale),
      homing: opts.homing,
      critical,
      maxLife: opts.maxLife,
      trail: this.def.fireMode !== 'sustained' && this.def.fireMode !== 'minigun',
    });

    if (!opts.skipMuzzleFlash) arena.fx.muzzleFlash(pos, dir, this.colour);
    this.applyRecoil(opts.recoil);
    this.firingRecently = 0.25;
  }

  /**
   * Area damage for the firing modes that resolve on the spot rather than
   * through a shell — hitscan impacts. Shell-borne blasts are detonated by the
   * projectile itself, which is what carries the flight time and the bounce.
   */
  private detonateSplash(
    arena: Arena,
    point: CANNON.Vec3,
    damage: number,
    scale: number,
    impactForce: number,
  ): void {
    const splash = resolveSplash(this.def.splash, damage, scale);
    if (!splash) return;
    arena.splash(point, splash.radius, splash.damageMax, splash.damageMin, this.owner, {
      selfDamage: this.def.selfDamage,
      impactForce: impactForce * 0.6,
      turret: this.def,
    });
    arena.fx.explosion(point, splash.radius, this.colour);
  }

  /** Instant beam. Pierces when the turret declares it (Railgun). */
  private fireHitscan(
    arena: Arena,
    damage: number,
    recoil: number,
    impactForce: number,
    pierce?: TurretDef['pierce'],
  ): void {
    const from = this.owner.muzzle(new CANNON.Vec3());
    const dir = this.owner.aimDirection(new CANNON.Vec3());
    const range = this.def.hardCap ?? 400;
    const to = from.vadd(dir.scale(range));
    const scale = this.owner.status.damageDealtScale;

    const hits = arena.phys.raycastAll(from, to, SHOT_MASK, this.owner.vehicle.body);
    let end = to;
    let remaining = pierce ? pierce.targets : 1;
    let falloff = 1;

    for (const hit of hits) {
      const target = arena.tankForBody(hit.body);
      if (!target) {
        end = hit.point;
        this.detonateSplash(arena, hit.point, damage, scale * falloff, impactForce);
        break;
      }
      if (target === this.owner) continue;
      if (!arena.areEnemies(this.owner, target) && !arena.settings.friendlyFire) continue;

      const dist = hit.distance;
      const dmg = damageAtRange(this.def, damage, this.def.weakDamage, dist) * scale * falloff;
      arena.damage(target, dmg, this.owner, { kind: 'direct', at: hit.point });
      target.vehicle.applyImpulse(dir, impactForce);
      arena.fx.impact(hit.point, hit.normal, this.colour);
      // A pierced target is a detonation point too, so a hitscan gun with a
      // blast stitches one along the beam instead of only at the far end.
      this.detonateSplash(arena, hit.point, damage, scale * falloff, impactForce);

      remaining -= 1;
      falloff *= 1 - (pierce?.damageLossPerTarget ?? 0);
      if (remaining <= 0) {
        end = hit.point;
        break;
      }
    }

    arena.fx.tracer(from, end, this.colour, 0.12, 0.18);
    arena.fx.muzzleFlash(from, dir, this.colour);
    this.applyRecoil(recoil);
    this.firingRecently = 0.3;
  }

  /** Nearest valid target inside a screen-space-ish cone, with line of sight. */
  private pickBeamTarget(arena: Arena, range: number, coneDeg: number, allowAllies = false): Tank | null {
    const from = this.owner.muzzle(new CANNON.Vec3());
    const dir = this.owner.aimDirection(new CANNON.Vec3());
    const cosLimit = Math.cos(coneDeg * DEG);
    let best: Tank | null = null;
    let bestScore = Infinity;

    for (const other of arena.tanks) {
      if (other === this.owner || !other.alive) continue;
      const enemy = arena.areEnemies(this.owner, other);
      if (!enemy && !allowAllies) continue;
      if (!enemy && other.healthFraction >= 1) continue;

      const to = other.centre();
      const delta = to.vsub(from);
      const dist = delta.length();
      if (dist > range || dist < 0.01) continue;
      const dot = delta.scale(1 / dist).dot(dir);
      if (dot < cosLimit) continue;
      if (!this.hasClearShot(arena, from, other, false)) continue;

      // Prefer centred targets over merely close ones.
      const score = dist * (2 - dot);
      if (score < bestScore) {
        bestScore = score;
        best = other;
      }
    }
    return best;
  }

  private beamInRange(arena: Arena, target: Tank, range: number, coneDeg: number): boolean {
    const from = this.owner.muzzle(new CANNON.Vec3());
    const delta = target.centre().vsub(from);
    const dist = delta.length();
    if (dist > range) return false;
    const dir = this.owner.aimDirection(new CANNON.Vec3());
    if (delta.scale(1 / dist).dot(dir) < Math.cos(coneDeg * 1.6 * DEG)) return false;
    return this.hasClearShot(arena, from, target, false);
  }

  private hasClearShot(arena: Arena, from: CANNON.Vec3, target: Tank, blockedByTanks: boolean): boolean {
    const to = target.centre();
    const hits = arena.phys.raycastAll(from, to, SHOT_MASK, this.owner.vehicle.body);
    for (const hit of hits) {
      if (hit.body === target.vehicle.body) return true;
      const other = arena.tankForBody(hit.body);
      if (other) {
        if (blockedByTanks) return false;
        continue;
      }
      return false;
    }
    return true;
  }
}

/** A blast whose centre damage has been settled, not left to a fallback. */
type ResolvedSplash = SplashDef & { damageMax: number };

/**
 * Pins down a blast before it leaves the gun: `damageMax` is optional in the
 * data and falls back to the turret's direct damage, and both ends of the
 * falloff take the shooter's damage multipliers. Returns a definition whose
 * `damageMax` is always populated, so nothing downstream has to re-guess it.
 */
function resolveSplash(
  splash: TurretDef['splash'],
  damage: number,
  scale: number,
): ResolvedSplash | undefined {
  if (!splash) return undefined;
  return {
    radius: splash.radius,
    damageMax: (splash.damageMax ?? damage) * scale,
    damageMin: splash.damageMin * scale,
  };
}

function applySpread(dir: CANNON.Vec3, degrees: number): void {
  const angle = degrees * DEG;
  // Random point in a disc, mapped onto the cone around the aim direction.
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * angle;
  const up = Math.abs(dir.y) > 0.95 ? new CANNON.Vec3(1, 0, 0) : new CANNON.Vec3(0, 1, 0);
  const right = dir.cross(up);
  right.normalize();
  const realUp = right.cross(dir);
  realUp.normalize();
  dir.vadd(right.scale(Math.cos(a) * Math.tan(r)), dir);
  dir.vadd(realUp.scale(Math.sin(a) * Math.tan(r)), dir);
  dir.normalize();
}
