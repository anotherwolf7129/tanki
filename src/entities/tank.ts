import * as CANNON from 'cannon-es';
import * as THREE from 'three';
import type { HullDef, SupplyKind, TeamId, TurretDef } from '../data/schema';
import { CROSS_COOLDOWN, SELF_COOLDOWN, SUPPLIES, SUPPLY_ORDER, crossCooldownApplies } from '../data/supplies';
import { barrelReach, pitchLimits } from '../data';
import { angleDelta, clamp, DEG } from '../core/mathx';
import { VehicleController } from '../physics/vehicle';
import type { PhysicsWorld } from '../physics/world';
import { StatusSet } from './status';
import { Weapon } from './weapon';
import { buildTankMesh, type TankMesh } from '../render/tankmesh';
import type { Arena } from '../game/types';
import type { AiController } from '../ai/controller';

const TMP_FWD = new CANNON.Vec3();
const TMP_SMOKE = new CANNON.Vec3();

export interface TankConfig {
  id: number;
  name: string;
  team: TeamId;
  isPlayer: boolean;
  /** Boss Raid's Overseer. Exempt from the bot equipment gap, and a legal target
   *  for the raid damage rules. */
  isBoss?: boolean;
  hull: HullDef;
  turret: TurretDef;
  hullMultiplier: number;
  turretMultiplier: number;
  spawnProtection: number;
  overdriveChargeRate: number;
}

export interface SupplyState {
  count: number;
  cooldown: number;
}

/**
 * One combatant. Owns its rigid body, its turret aim state, its weapon and its
 * supply inventory. The player and every bot are the same class — bots differ
 * only by having a `BotController` attached and a different difficulty profile
 * feeding their stats.
 */
export class Tank {
  readonly id: number;
  readonly name: string;
  readonly team: TeamId;
  readonly isPlayer: boolean;
  readonly isBoss: boolean;
  readonly hull: HullDef;
  readonly turretDef: TurretDef;

  readonly vehicle: VehicleController;
  readonly status = new StatusSet();
  readonly weapon: Weapon;
  readonly mesh: TankMesh;

  maxHealth: number;
  health: number;
  alive = true;
  respawnTimer = 0;
  spawnProtection = 0;
  readonly spawnProtectionDuration: number;

  /** World-space turret aim, independent of hull yaw. */
  turretYaw = 0;
  turretPitch = 0;
  private turretYawVel = 0;
  desiredYaw = 0;
  desiredPitch = 0;

  overdriveCharge = 0;
  overdriveActive = 0;
  private readonly overdriveChargeRate: number;

  readonly supplies: Record<SupplyKind, SupplyState> = {
    repair: { count: 0, cooldown: 0 },
    armor: { count: 0, cooldown: 0 },
    damage: { count: 0, cooldown: 0 },
    nitro: { count: 0, cooldown: 0 },
    mine: { count: 0, cooldown: 0 },
  };
  private healOverTime = 0;
  private healRemaining = 0;
  private smokeTimer = 0;

  kills = 0;
  deaths = 0;
  score = 0;
  crystals = 0;
  damageDealt = 0;
  /**
   * Damage this tank has done to itself — its own blast, its own overheating
   * barrel. Kept apart from `damageDealt` because it is nobody's score, and
   * because it is the only honest signal an AI has that its last shot was a
   * mistake it should not repeat.
   */
  selfDamageTaken = 0;
  lastAttacker: Tank | null = null;
  lastAttackedAt = -999;
  lastHitProtectionAt = -999;
  bankedFlagPoints = 0;

  /** Set by CTF/CP modes. */
  carryingFlag: TeamId | null = null;

  ai: AiController | null = null;
  /** Populated by the Mammoth rampage overdrive. */
  contactDamage = 0;
  damageReduction = 0;

  constructor(
    cfg: TankConfig,
    phys: PhysicsWorld,
    scene: THREE.Scene,
    spawn: { pos: CANNON.Vec3; yaw: number },
  ) {
    this.id = cfg.id;
    this.name = cfg.name;
    this.team = cfg.team;
    this.isPlayer = cfg.isPlayer;
    this.isBoss = cfg.isBoss === true;

    // Tier multipliers are the spec's "equipment gap": the player runs top gear,
    // bots run mid gear, and the difference is legible in the garage UI.
    this.hull = scaleHull(cfg.hull, cfg.hullMultiplier);
    this.turretDef = scaleTurret(cfg.turret, cfg.turretMultiplier);

    this.maxHealth = this.hull.protection;
    this.health = this.maxHealth;
    this.spawnProtectionDuration = cfg.spawnProtection;
    this.spawnProtection = cfg.spawnProtection;
    this.overdriveChargeRate = cfg.overdriveChargeRate;
    this.status.immune = !!this.hull.statusImmune;

    this.vehicle = new VehicleController(phys, this.hull, spawn.pos, spawn.yaw);
    this.turretYaw = spawn.yaw;
    this.desiredYaw = spawn.yaw;
    this.weapon = new Weapon(this, this.turretDef);
    this.mesh = buildTankMesh(this.hull, this.turretDef, this.team, this.isPlayer);
    scene.add(this.mesh.root);
  }

  dispose(scene: THREE.Scene): void {
    this.vehicle.dispose();
    scene.remove(this.mesh.root);
    this.mesh.dispose();
  }

  get position(): CANNON.Vec3 {
    return this.vehicle.body.position;
  }

  get velocity(): CANNON.Vec3 {
    return this.vehicle.body.velocity;
  }

  get healthFraction(): number {
    return clamp(this.health / this.maxHealth, 0, 1);
  }

  /** Centre of mass, the point bots aim at and line-of-sight tests use. */
  centre(out = new CANNON.Vec3()): CANNON.Vec3 {
    out.copy(this.position);
    out.y += this.hull.size[1] * 0.25;
    return out;
  }

  turretOrigin(out = new CANNON.Vec3()): CANNON.Vec3 {
    const up = this.vehicle.upVector();
    out.copy(this.position);
    out.vadd(up.scale(this.hull.turretMountHeight * 0.6), out);
    return out;
  }

  aimDirection(out = new CANNON.Vec3()): CANNON.Vec3 {
    const cp = Math.cos(this.turretPitch);
    out.set(Math.sin(this.turretYaw) * cp, Math.sin(this.turretPitch), Math.cos(this.turretYaw) * cp);
    return out;
  }

  /** Barrel tip, where shots originate and muzzle flashes are drawn. */
  muzzle(out = new CANNON.Vec3()): CANNON.Vec3 {
    const origin = this.turretOrigin(out);
    const dir = this.aimDirection(new CANNON.Vec3());
    origin.vadd(dir.scale(barrelReach(this.hull, this.turretDef)), origin);
    return origin;
  }

  /** How far this turret's barrel can be elevated and depressed, in radians. */
  get pitchLimits(): [number, number] {
    return pitchLimits(this.turretDef);
  }

  /** Effective turret rotation speed after status, scoping and firing modifiers. */
  private turretRotationSpeed(): number {
    let speed = this.turretDef.rotationSpeed * this.status.turretScale;
    speed *= this.weapon.rotationMultiplier;
    return speed;
  }

  updateAim(dt: number): void {
    const maxSpeed = this.turretRotationSpeed() * DEG;
    const accel = this.turretDef.rotationAcceleration * DEG;
    const delta = angleDelta(this.turretYaw, this.desiredYaw);

    // Accelerate toward the target and brake so the turret settles instead of
    // snapping — the reference feel depends on the turret lagging the mouse.
    const stopDist = (this.turretYawVel * this.turretYawVel) / (2 * accel);
    const wantAccel = Math.abs(delta) <= stopDist ? -Math.sign(this.turretYawVel) * accel : Math.sign(delta) * accel;
    this.turretYawVel = clamp(this.turretYawVel + wantAccel * dt, -maxSpeed, maxSpeed);
    if (Math.abs(delta) < 0.004 && Math.abs(this.turretYawVel) * dt > Math.abs(delta)) {
      this.turretYaw = this.desiredYaw;
      this.turretYawVel = 0;
    } else {
      this.turretYaw += this.turretYawVel * dt;
    }

    const pitchRate = Math.max(0.6, maxSpeed) * 1.2;
    const [minPitch, maxPitch] = this.pitchLimits;
    const pd = clamp(this.desiredPitch - this.turretPitch, -pitchRate * dt, pitchRate * dt);
    this.turretPitch = clamp(this.turretPitch + pd, minPitch, maxPitch);
  }

  update(dt: number, arena: Arena): void {
    if (!this.alive) {
      this.respawnTimer -= dt;
      return;
    }

    this.spawnProtection = Math.max(0, this.spawnProtection - dt);
    const { burnDamage, burnSourceId } = this.status.update(dt);
    if (burnDamage > 0) {
      const src = arena.tanks.find((t) => t.id === burnSourceId) ?? null;
      arena.damage(this, burnDamage, src, { kind: 'burn' });
    }

    if (this.healRemaining > 0) {
      const tick = Math.min(dt, this.healRemaining);
      arena.heal(this, this.healOverTime * tick, this);
      this.healRemaining -= tick;
    }

    for (const kind of SUPPLY_ORDER) {
      const s = this.supplies[kind];
      if (s.cooldown > 0) s.cooldown = Math.max(0, s.cooldown - dt);
    }

    if (this.overdriveActive > 0) this.overdriveActive = Math.max(0, this.overdriveActive - dt);
    this.overdriveCharge = Math.min(
      100,
      this.overdriveCharge + this.hull.overdriveChargePerSecond * this.overdriveChargeRate * dt,
    );

    this.updateAim(dt);
    this.weapon.update(dt, arena);
    this.updateVisuals(dt, arena);
    this.syncMesh();
  }

  /**
   * Cosmetic state: track scroll, gun recoil recovery, and the engine fire and
   * smoke column a badly hurt hull trails. The smoke doubles as information —
   * a burning tank is one worth chasing, from either side of the fight.
   */
  private updateVisuals(dt: number, arena: Arena): void {
    const along = this.vehicle.forwardVector(TMP_FWD);
    const speedAlong = this.velocity.x * along.x + this.velocity.y * along.y + this.velocity.z * along.z;
    this.mesh.animate(dt, speedAlong);
    this.mesh.setHealth(this.healthFraction);

    if (this.healthFraction < 0.34) {
      this.smokeTimer -= dt;
      if (this.smokeTimer <= 0) {
        this.smokeTimer = 0.1 + this.healthFraction * 0.5;
        TMP_SMOKE.copy(this.position);
        TMP_SMOKE.y += this.hull.size[1] * 0.7;
        TMP_SMOKE.z -= this.hull.size[2] * 0.2;
        arena.fx.smoke(TMP_SMOKE, this.hull.size[0] * 0.3, 1.1, { x: 0, y: 3.2, z: 0 });
      }
    }
  }

  /** Called by the weapon when it fires, so the gun kicks in its mantlet. */
  onFired(recoil: number): void {
    this.mesh.kick(0.16 + Math.min(0.34, recoil * 0.09));
    // The raid boss hangs the rest of its salvo off this — see `BossController`.
    this.ai?.onFired?.();
  }

  /** Battle points feed the overdrive bar as well as the scoreboard. */
  addBattlePoints(points: number): void {
    this.score += points;
    this.overdriveCharge = Math.min(
      100,
      this.overdriveCharge + points * this.hull.overdriveChargePerBattlePoint * this.overdriveChargeRate * 0.1,
    );
  }

  canUseSupply(kind: SupplyKind): boolean {
    const s = this.supplies[kind];
    return this.alive && s.count > 0 && s.cooldown <= 0 && !this.status.has('emp');
  }

  /**
   * Consumes one supply. Boxes picked up in the arena call `applySupply`
   * directly instead, which is what lets box control bypass Smart Cooldowns.
   */
  useSupply(kind: SupplyKind, arena: Arena): boolean {
    if (!this.canUseSupply(kind)) return false;
    this.supplies[kind].count -= 1;
    this.supplies[kind].cooldown = SELF_COOLDOWN;
    for (const other of SUPPLY_ORDER) {
      if (crossCooldownApplies(kind, other)) {
        this.supplies[other].cooldown = Math.max(this.supplies[other].cooldown, CROSS_COOLDOWN);
      }
    }
    this.applySupply(kind, arena);
    return true;
  }

  applySupply(kind: SupplyKind, arena: Arena): void {
    const def = SUPPLIES[kind];
    switch (kind) {
      case 'repair':
        arena.heal(this, def.instantHeal ?? 0, this);
        this.healOverTime = (def.healOverTime ?? 0) / (def.healDuration ?? 1);
        this.healRemaining = def.healDuration ?? 0;
        this.status.remove('burning');
        this.status.remove('freezing');
        break;
      case 'armor':
        this.status.apply('doubleArmor', 1, def.duration ?? 40, this.id);
        break;
      case 'damage':
        this.status.apply('doubleDamage', 1, def.duration ?? 40, this.id);
        break;
      case 'nitro':
        this.status.apply('nitro', 1, def.duration ?? 40, this.id);
        break;
      case 'mine':
        arena.spawnMine(this, this.position.clone());
        break;
    }
    arena.fx.supplyBurst(this.position, def.colour);
  }

  /** Damage taken while healing interrupts the over-time portion. */
  interruptHeal(): void {
    this.healRemaining = 0;
  }

  giveSupply(kind: SupplyKind, count = 1): void {
    this.supplies[kind].count += count;
  }

  respawn(spawn: { pos: CANNON.Vec3; yaw: number }): void {
    this.alive = true;
    this.health = this.maxHealth;
    this.status.clear();
    this.status.immune = !!this.hull.statusImmune;
    this.spawnProtection = this.spawnProtectionDuration;
    this.overdriveActive = 0;
    this.healRemaining = 0;
    this.contactDamage = 0;
    this.damageReduction = 0;
    this.carryingFlag = null;
    this.weapon.reset();
    this.vehicle.teleport(spawn.pos, spawn.yaw);
    this.turretYaw = spawn.yaw;
    this.desiredYaw = spawn.yaw;
    this.turretPitch = 0;
    this.turretYawVel = 0;
    this.smokeTimer = 0;
    // Overlays are cleared here rather than left to the next weapon tick: a
    // tank killed mid-flamethrower is respawned before its weapon updates
    // again, and would otherwise reappear for a frame still spraying fire.
    this.mesh.resetOverlays();
    this.mesh.setHealth(1);
    this.mesh.root.visible = true;
    this.syncMesh();
  }

  kill(): void {
    this.alive = false;
    this.deaths += 1;
    this.health = 0;
    this.status.clear();
    this.carryingFlag = null;
    this.mesh.resetOverlays();
    this.mesh.root.visible = false;
    this.vehicle.body.velocity.setZero();
    this.vehicle.body.angularVelocity.setZero();
    // Parked far below the arena so it stops colliding while dead.
    this.vehicle.body.position.set(0, -400 - this.id * 6, 0);
  }

  syncMesh(): void {
    const b = this.vehicle.body;
    this.mesh.root.position.set(b.position.x, b.position.y, b.position.z);
    this.mesh.root.quaternion.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
    // Turret yaw is stored in world space, so subtract the hull's yaw to place it.
    this.mesh.turret.rotation.y = angleDelta(this.vehicle.yaw, this.turretYaw);
    this.mesh.barrel.rotation.x = -this.turretPitch;
    this.mesh.setShield(this.spawnProtection > 0 || this.damageReduction > 0);
  }
}

function scaleHull(def: HullDef, k: number): HullDef {
  if (k === 1) return def;
  return {
    ...def,
    protection: Math.round(def.protection * k),
    // Speed scales far less than health, so a tier gap never turns into a
    // mobility gap the player can simply run away from.
    topSpeed: def.topSpeed * (1 + (k - 1) * 0.25),
    acceleration: def.acceleration * (1 + (k - 1) * 0.25),
    turnSpeed: def.turnSpeed * (1 + (k - 1) * 0.2),
  };
}

function scaleTurret(def: TurretDef, k: number): TurretDef {
  if (k === 1) return def;
  const alt = def.alt ? { ...def.alt, damage: def.alt.damage * k, weakDamage: def.alt.weakDamage * k } : undefined;
  const scoped = def.scoped
    ? { ...def.scoped, minDamage: def.scoped.minDamage * k, maxDamage: def.scoped.maxDamage * k }
    : undefined;
  return {
    ...def,
    damage: def.damage * k,
    weakDamage: def.weakDamage * k,
    criticalDamage: def.criticalDamage != null ? def.criticalDamage * k : undefined,
    healPerTick: def.healPerTick != null ? def.healPerTick * k : undefined,
    reloadTime: def.reloadTime / (1 + (k - 1) * 0.3),
    splash: def.splash
      ? {
          ...def.splash,
          damageMax: def.splash.damageMax != null ? def.splash.damageMax * k : undefined,
          damageMin: def.splash.damageMin * k,
        }
      : undefined,
    alt,
    scoped,
  };
}
