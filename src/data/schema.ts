/**
 * Data schemas. Parameter names follow the reference spec verbatim so the JSON
 * tables read the same way the wiki documents them.
 */

export type TeamId = 'red' | 'blue' | 'free';

export type FireMode =
  | 'single'
  | 'splash'
  | 'hitscan'
  | 'sniper'
  | 'ballistic'
  | 'sustained'
  | 'minigun'
  | 'shotgun'
  | 'bouncing'
  | 'guided'
  | 'cone'
  | 'beam'
  | 'chain'
  | 'dual';

export interface SplashDef {
  radius: number;
  /** Damage at the centre of the blast. Defaults to the turret's direct damage. */
  damageMax?: number;
  damageMin: number;
}

export interface ClipDef {
  size: number;
  shotInterval: number;
  partialReload: boolean;
}

export interface ConeDef {
  angleDeg: number;
  range: number;
  tickRate: number;
}

export interface BeamDef {
  range: number;
  tickRate: number;
  lockConeDeg: number;
}

export interface ChainDef {
  jumps: number;
  falloff: number;
  jumpRange: number;
  tickRate: number;
}

export interface FuelDef {
  capacity: number;
  drainPerSec: number;
  rechargePerSec: number;
  healDrainPerSec?: number;
}

export interface HeatDef {
  risePerSec: number;
  fallPerSec: number;
  selfBurnDps: number;
  spinUp: number;
}

export interface ScopedDef {
  minDamage: number;
  maxDamage: number;
  chargeTime: number;
  reloadTime: number;
  rotationMultiplier: number;
  fov: number;
  movementLocked: boolean;
  recoil: number;
}

export interface GuidedDef {
  missiles: number;
  lockTime: number;
  volleyInterval: number;
  acceleration: number;
  turnRate: number;
}

export interface AltFireDef {
  damage: number;
  weakDamage: number;
  reloadTime: number;
  impactForce: number;
  recoil: number;
  projectileSpeed: number;
  splash?: SplashDef;
}

export interface TurretDef {
  id: string;
  displayName: string;
  class: string;
  fireMode: FireMode;

  damage: number;
  weakDamage: number;
  criticalDamage?: number;
  maxCritChance?: number;
  critChanceStep?: number;
  healPerTick?: number;

  impactForce: number;
  recoil: number;
  reloadTime: number;
  rotationSpeed: number;
  rotationAcceleration: number;

  rangeMaxDamage: number;
  rangeMinDamage: number;
  hardCap?: number;

  projectileSpeed?: number;
  gravity?: number;
  barrels?: number;
  bounces?: number;
  pellets?: { count: number; spreadDeg: number };
  pierce?: { targets: number; damageLossPerTarget: number };
  charge?: { time: number; autoFire: boolean };
  firingRotationMultiplier?: number;

  splash?: SplashDef;
  clip?: ClipDef;
  cone?: ConeDef;
  beam?: BeamDef;
  chain?: ChainDef;
  fuel?: FuelDef;
  heat?: HeatDef;
  scoped?: ScopedDef;
  guided?: GuidedDef;
  alt?: AltFireDef;

  applies?: { effect: StatusKind; magnitude: number; duration: number };
  blockedByTanks?: boolean;
  selfDamage: boolean;
  purchasable?: boolean;
  special?: string[];
}

export interface OverdriveDef {
  id: string;
  displayName: string;
  effect: string;
  radius?: number;
  range?: number;
  duration?: number;
  delay?: number;
  damage?: number;
  heal?: number;
  healFraction?: number;
  jumps?: number;
  launchImpulse?: number;
  damageReduction?: number;
  speedMultiplier?: number;
  fireRateMultiplier?: number;
  contactDamage?: number;
}

export interface HullDef {
  id: string;
  displayName: string;
  class: 'light' | 'medium' | 'heavy' | 'special';

  protection: number;
  topSpeed: number;
  power: number;
  acceleration: number;
  reverseAcceleration: number;
  nitroAcceleration: number;
  lateralAcceleration: number;
  turnSpeed: number;
  mass: number;

  hover: boolean;
  hoverHeight?: number;
  size: [number, number, number];
  turretMountHeight: number;
  centredTurret?: boolean;
  recoilResistance?: number;
  statusImmune?: boolean;
  fixedTurret?: string;
  purchasable?: boolean;

  overdriveChargePerBattlePoint: number;
  overdriveChargePerSecond: number;
  heatResistance: number;
  overdrive: OverdriveDef;
}

export type StatusKind =
  | 'burning'
  | 'freezing'
  | 'emp'
  | 'stun'
  | 'ap'
  | 'jammer'
  | 'supercharge'
  | 'doubleArmor'
  | 'doubleDamage'
  | 'nitro'
  | 'reveal';

export type SupplyKind = 'repair' | 'armor' | 'damage' | 'nitro' | 'mine';

export type ModeCode = 'DM' | 'TDM' | 'CTF' | 'CP';

/** Primitive prop kit. Everything is built on the 5 m grid from the spec. */
export type PropKind = 'box' | 'ramp' | 'cylinder' | 'platform';

export interface PropDef {
  kind: PropKind;
  pos: [number, number, number];
  size: [number, number, number];
  /** Yaw in degrees. */
  rot?: number;
  material?: 'concrete' | 'metal' | 'sand' | 'glass' | 'hazard';
}

export interface SpawnDef {
  pos: [number, number, number];
  yaw: number;
}

export interface MapDef {
  id: string;
  displayName: string;
  size: 'small' | 'medium' | 'large';
  maxPlayers: number;
  modes: ModeCode[];
  gravityScale: number;
  bounds: { x: number; z: number };
  theme: 'summer' | 'winter' | 'urban' | 'space';
  spawns: Record<TeamId, SpawnDef[]>;
  flags?: { red: [number, number, number]; blue: [number, number, number] };
  controlPoints?: { id: string; pos: [number, number, number]; radius: number }[];
  supplyZones: { pos: [number, number, number]; types: SupplyKind[] }[];
  goldBoxZones: [number, number, number][];
  props: PropDef[];
}
