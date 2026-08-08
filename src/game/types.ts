import type * as CANNON from 'cannon-es';
import type { SplashDef, SupplyKind, TeamId, TurretDef } from '../data/schema';
import type { BattleSettings } from '../data/modes';
import type { PhysicsWorld } from '../physics/world';
import type { Tank } from '../entities/tank';
import type { Effects } from '../render/effects';

export type DamageKind = 'direct' | 'splash' | 'burn' | 'self' | 'mine' | 'contact' | 'overdrive';

export interface DamageOptions {
  kind?: DamageKind;
  critical?: boolean;
  /** World point of impact, for hit markers. */
  at?: CANNON.Vec3;
  ignoreArmor?: boolean;
}

export interface HomingSpec {
  target: Tank;
  turnRate: number;
  acceleration: number;
  maxSpeed: number;
}

export interface ProjectileSpawn {
  owner: Tank;
  turret: TurretDef;
  position: CANNON.Vec3;
  direction: CANNON.Vec3;
  speed: number;
  damage: number;
  weakDamage: number;
  impactForce: number;
  selfDamage: boolean;
  colour: number;
  radius: number;
  gravity?: number;
  bounces?: number;
  splash?: SplashDef;
  homing?: HomingSpec;
  critical?: boolean;
  /** Range falloff is measured from the muzzle, not from the shooter. */
  maxLife?: number;
  trail?: boolean;
  /** Forces the exhaust plume on a shell that is neither guided nor lobbed. */
  smokeTrail?: boolean;
}

export interface Notification {
  text: string;
  /**
   * `squad` is radio traffic from your own side. It gets its own colour
   * because it shares the feed with the boss's warnings, and a raid that
   * cannot tell "it is calling down a storm" from "moving, ring on me" at a
   * glance has a feed that is worse than an empty one.
   */
  kind: 'info' | 'kill' | 'objective' | 'warning' | 'gold' | 'squad';
  at: number;
}

/**
 * What weapons, bots and overdrives are allowed to know about the battle.
 * Keeping this narrow is what lets the AI live behind a perception component
 * instead of reading world state directly.
 */
export interface Arena {
  readonly phys: PhysicsWorld;
  readonly tanks: Tank[];
  readonly settings: BattleSettings;
  readonly fx: Effects;
  readonly time: number;
  readonly playerCount: number;

  tankForBody(body: CANNON.Body): Tank | null;
  areEnemies(a: Tank, b: Tank): boolean;
  areAllies(a: Tank, b: Tank): boolean;

  damage(target: Tank, amount: number, source: Tank | null, opts?: DamageOptions): number;
  heal(target: Tank, amount: number, source: Tank | null): number;
  splash(
    centre: CANNON.Vec3,
    radius: number,
    damageMax: number,
    damageMin: number,
    source: Tank | null,
    opts: { selfDamage: boolean; impactForce: number; turret?: TurretDef },
  ): void;

  spawnProjectile(spec: ProjectileSpawn): void;
  spawnMine(owner: Tank, position: CANNON.Vec3): void;
  awardBattlePoints(tank: Tank, points: number): void;
  notify(text: string, kind?: Notification['kind']): void;

  /** Mode hooks — no-ops in modes that do not use them. */
  onSupplyPicked?(tank: Tank, kind: SupplyKind): void;
  teamOf(tank: Tank): TeamId;
}
