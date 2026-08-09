/**
 * Augments — one optional modification per turret and per hull.
 *
 * The rule that keeps this from becoming a second stat system: an augment is
 * either *numbers* or *behaviour*, never a bit of both smeared across the
 * codebase. Numbers live in `stats` and are folded into a copy of the item's
 * definition before the battle starts, so the whole simulation reads them for
 * free — a turret whose reload was cut by an augment simply has a shorter
 * `reloadTime`, and the HUD, the bots and the garage card all agree without
 * knowing an augment exists. Behaviour lives in `traits`, which the handful of
 * places that can actually observe it — the damage funnel, the tank's own tick —
 * check by name.
 *
 * Offensive traits belong to turret augments and defensive ones to hull
 * augments. Keeping those sets disjoint is what lets the two be merged with a
 * plain object spread rather than a resolution table.
 */
import type { HullDef, TurretDef } from './schema';

export type AugmentSlot = 'turret' | 'hull';

/** Heat at which a minigun cuts out, when the turret does not say otherwise. */
export const DEFAULT_HEAT_CEILING = 1.15;

/** Multipliers, except where a comment says otherwise. */
export interface TurretStatMods {
  damage?: number;
  reloadTime?: number;
  projectileSpeed?: number;
  impactForce?: number;
  recoil?: number;
  rotationSpeed?: number;
  /** Scales the traverse penalty a turret suffers while firing. */
  firingRotation?: number;
  /** Scales the whole range table — full-damage band, falloff and hard cap. */
  range?: number;
  splashRadius?: number;
  splashDamage?: number;
  criticalDamage?: number;
  critChanceStep?: number;
  healPerTick?: number;
  chargeTime?: number;
  /** Added to the clip, in shells. */
  clipSize?: number;
  shotInterval?: number;
  /** Added to the pellet count. */
  pellets?: number;
  pelletSpread?: number;
  /** Added to the number of wall bounces. */
  bounces?: number;
  /** Added to the number of tanks a shot pierces. */
  pierceTargets?: number;
  pierceLoss?: number;
  /** Added to the missiles in a guided volley. */
  guidedMissiles?: number;
  lockTime?: number;
  /** Added to the number of chain jumps. */
  chainJumps?: number;
  chainFalloff?: number;
  coneAngle?: number;
  coneRange?: number;
  beamRange?: number;
  fuelCapacity?: number;
  fuelRecharge?: number;
  fuelDrain?: number;
  heatRise?: number;
  heatFall?: number;
  /** Added to the heat at which the gun cuts out, in heat units. */
  heatCeiling?: number;
  selfBurn?: number;
  /** Scales the effect a cone turret applies on contact. */
  statusMagnitude?: number;
  statusDuration?: number;
  scopedCharge?: number;
  scopedDamage?: number;
  scopedReload?: number;
  scopedRecoil?: number;
  /** Frees a scoped turret from having to stand still. */
  scopedMobile?: boolean;
  altDamage?: number;
  altReload?: number;
  altSplashRadius?: number;
}

/** Multipliers, except where a comment says otherwise. */
export interface HullStatMods {
  protection?: number;
  topSpeed?: number;
  acceleration?: number;
  turnSpeed?: number;
  lateralAcceleration?: number;
  /** Added to the hull's heat resistance, in percentage points. */
  heatResistance?: number;
  /** Added to the hull's recoil resistance, clamped to 1. */
  recoilResistance?: number;
  /** Scales both overdrive charge channels at once. */
  overdriveCharge?: number;
}

export interface AugmentTraits {
  // ---- offensive, from the turret ----
  /**
   * Sets the target alight on a direct or splash hit. `whenOverheated` is the
   * Vulcan case: the burn only rides along once the barrel is genuinely cooking,
   * which is also the point at which the gun is hurting its own driver.
   */
  ignite?: { dps: number; duration: number; whenOverheated?: boolean };
  chill?: { magnitude: number; duration: number };
  /** Chance per hit of knocking the target's turret out for a moment. */
  disrupt?: { duration: number; chance: number };
  /** Fraction of damage dealt returned to the shooter as health. */
  lifesteal?: number;
  bonusVsBurning?: number;
  bonusVsFrozen?: number;
  /** Extra damage against a target already below `below` health. */
  execute?: { below: number; bonus: number };

  // ---- defensive, from the hull ----
  damageTaken?: number;
  burnTaken?: number;
  /** Fraction of incoming direct damage returned to the attacker. */
  thorns?: number;
  /** 0..1, shortens every hostile status effect applied to this hull. */
  statusResistance?: number;
  regen?: { perSecond: number; delay: number };
  /** Speed multiplier that switches on below `below` health. */
  adrenaline?: { below: number; speed: number };
  /** Contact damage when this hull runs something over above `minSpeed`. */
  ram?: { damage: number; minSpeed: number };
  supplyPotency?: number;
  /** Overdrive charge, as a fraction of a full bar, granted per kill. */
  overdriveOnKill?: number;
  /** Added seconds of spawn protection. */
  spawnProtection?: number;
}

export interface AugmentDef {
  /** Qualified `item.augment`, unique across the whole table. */
  id: string;
  displayName: string;
  slot: AugmentSlot;
  /** Turret or hull id this augment can be fitted to. */
  item: string;
  blurb: string;
  stats?: TurretStatMods & HullStatMods;
  traits?: AugmentTraits;
}

interface Spec {
  id: string;
  displayName: string;
  blurb: string;
  stats?: TurretStatMods & HullStatMods;
  traits?: AugmentTraits;
}

/**
 * Three per item, each a different answer to "what is this thing bad at". None
 * of them is a straight upgrade: every stat augment that adds somewhere takes
 * somewhere else, and the behavioural ones cost you the choice of the other two.
 */
const TURRET_TABLE: Record<string, Spec[]> = {
  firebird: [
    {
      id: 'slow_burn',
      displayName: 'Slow Burn',
      blurb: 'Fire clings. Burn lasts almost twice as long, so a target that breaks contact still cooks.',
      stats: { statusDuration: 1.9, statusMagnitude: 0.85 },
    },
    {
      id: 'wide_nozzle',
      displayName: 'Wide Nozzle',
      blurb: 'A broader, longer jet that catches tanks trying to slip past — at a cost in raw damage.',
      stats: { coneAngle: 1.4, coneRange: 1.15, range: 1.15, damage: 0.88 },
    },
    {
      id: 'pressure_tank',
      displayName: 'Pressure Tank',
      blurb: 'Half again the fuel and a faster refill. You stop running dry mid-kill.',
      stats: { fuelCapacity: 1.5, fuelRecharge: 1.3 },
    },
  ],
  freeze: [
    {
      id: 'deep_chill',
      displayName: 'Deep Chill',
      blurb:
        'Each contact tick bites harder, and the stream tears into a hull that is already frozen. A held stream locks a tank down in half the time.',
      stats: { statusMagnitude: 1.6 },
      traits: { bonusVsFrozen: 0.3 },
    },
    {
      id: 'cryo_jet',
      displayName: 'Cryo Jet',
      blurb: 'Reach past the usual knife range, at the price of a thinner stream.',
      stats: { coneRange: 1.35, range: 1.35, coneAngle: 0.8 },
    },
    {
      id: 'coolant_reserve',
      displayName: 'Coolant Reserve',
      blurb: 'A bigger tank that drains slower. Freeze is only useful while it is still firing.',
      stats: { fuelCapacity: 1.45, fuelDrain: 0.85 },
    },
  ],
  isida: [
    {
      id: 'field_medic',
      displayName: 'Field Medic',
      blurb: 'Heals harder for less fuel. The support build, and the reason a squad survives a raid.',
      stats: { healPerTick: 1.45, fuelDrain: 0.75 },
    },
    {
      id: 'vampirism',
      displayName: 'Vampirism',
      blurb: 'A third of the damage you do to enemies comes back to you as health.',
      traits: { lifesteal: 0.35 },
    },
    {
      id: 'long_lead',
      displayName: 'Long Lead',
      blurb: 'Holds the lock a third further out, which is the difference between healing and dying with them.',
      stats: { beamRange: 1.35, range: 1.35 },
    },
  ],
  tesla: [
    {
      id: 'arc_cascade',
      displayName: 'Arc Cascade',
      blurb: 'Two more jumps and a gentler falloff. Punishes anyone who groups up.',
      stats: { chainJumps: 2, chainFalloff: 1.25 },
    },
    {
      id: 'overload',
      displayName: 'Overload',
      blurb: 'A quarter more damage per tick, bought with a fuel drain you feel immediately.',
      stats: { damage: 1.25, fuelDrain: 1.4 },
    },
    {
      id: 'static_field',
      displayName: 'Static Field',
      blurb: 'The arc numbs what it touches — every tick slows the target a little further.',
      traits: { chill: { magnitude: 0.1, duration: 1.6 } },
    },
  ],
  hammer: [
    {
      id: 'choke',
      displayName: 'Choke',
      blurb: 'A tighter pattern that keeps the whole spread on target well past its usual range.',
      stats: { pelletSpread: 0.55, range: 1.2 },
    },
    {
      id: 'buckshot',
      displayName: 'Buckshot',
      blurb: 'Four more pellets, each doing less. Devastating in a corridor, wasted anywhere else.',
      stats: { pellets: 4, damage: 0.82, pelletSpread: 1.15 },
    },
    {
      id: 'quick_hands',
      displayName: 'Quick Hands',
      blurb: 'Shells loaded loose. A fifth off the reload and one more in the tube.',
      stats: { reloadTime: 0.78, clipSize: 1, damage: 0.94 },
    },
  ],
  twins: [
    {
      id: 'tight_grouping',
      displayName: 'Tight Grouping',
      blurb: 'Both barrels regulated for range: full damage a quarter further out.',
      stats: { range: 1.3, projectileSpeed: 1.2 },
    },
    {
      id: 'overpressure',
      displayName: 'Overpressure',
      blurb: 'Heavier charges. More per shell, fewer shells per second.',
      stats: { damage: 1.18, reloadTime: 1.15, impactForce: 1.3 },
    },
    {
      id: 'cyclic_feed',
      displayName: 'Cyclic Feed',
      blurb: 'A faster cycle at lower charge — suppression over stopping power.',
      stats: { reloadTime: 0.8, damage: 0.9 },
    },
  ],
  ricochet: [
    {
      id: 'rebound',
      displayName: 'Rebound',
      blurb: 'Three more bounces. Shots come back around corners you did not aim at.',
      stats: { bounces: 3 },
    },
    {
      id: 'hot_load',
      displayName: 'Hot Load',
      blurb: 'Flatter, faster shells that shove what they hit — harder to dodge, harder to bank.',
      stats: { projectileSpeed: 1.4, impactForce: 1.5, bounces: -1 },
    },
    {
      id: 'extended_drum',
      displayName: 'Extended Drum',
      blurb: 'Three more in the drum, and a longer wait once it runs out.',
      stats: { clipSize: 3, reloadTime: 1.2 },
    },
  ],
  smoky: [
    {
      id: 'hair_trigger',
      displayName: 'Hair Trigger',
      blurb: 'The critical meter climbs far faster. Fewer shots between the ones that matter.',
      stats: { critChanceStep: 1.7 },
    },
    {
      id: 'overpressure_shell',
      displayName: 'Overpressure Shell',
      blurb: 'Criticals hit a third harder, ordinary shells slightly softer.',
      stats: { criticalDamage: 1.32, damage: 0.94 },
    },
    {
      id: 'rifling',
      displayName: 'Rifling',
      blurb: 'A longer barrel: full damage a third further out, and a slower traverse to swing it.',
      stats: { range: 1.35, rotationSpeed: 0.85 },
    },
  ],
  striker: [
    {
      id: 'salvo',
      displayName: 'Salvo',
      blurb: 'Six missiles instead of four, each carrying a little less.',
      stats: { guidedMissiles: 2, damage: 0.85 },
    },
    {
      id: 'fast_lock',
      displayName: 'Fast Lock',
      blurb: 'Locks in well under a second. You can fire before the target rounds the corner.',
      stats: { lockTime: 0.55 },
    },
    {
      id: 'thermobaric',
      displayName: 'Thermobaric',
      blurb:
        'A wider, hotter blast that sets what survives it on fire — and every missile after the first lands on a target that is already burning.',
      stats: { splashRadius: 1.3, splashDamage: 1.15, reloadTime: 1.1 },
      traits: { ignite: { dps: 45, duration: 4 }, bonusVsBurning: 0.2 },
    },
  ],
  vulcan: [
    {
      /**
       * The showcase augment. Vulcan already punishes its own driver for holding
       * the trigger; Ignition makes that punishment worth taking by turning the
       * overheated barrel into a flamethrower. The extra ceiling is the whole
       * mechanic: without it the window between "overheated" and "cut out" is
       * two thirds of a second and the burn never gets going.
       */
      id: 'ignition',
      displayName: 'Ignition',
      blurb:
        'Once the barrel is overheated, every round sets the target alight — a burn heavy enough to finish a tank on its own if you keep the trigger down. The gun runs hotter before it cuts out, and cooks you the whole time.',
      stats: { heatCeiling: 0.35 },
      traits: { ignite: { dps: 90, duration: 6, whenOverheated: true } },
    },
    {
      id: 'heat_sink',
      displayName: 'Heat Sink',
      blurb: 'Runs cool and vents fast, and barely scorches you when it does overheat.',
      stats: { heatRise: 0.68, heatFall: 1.4, selfBurn: 0.45 },
    },
    {
      id: 'spun_up',
      displayName: 'Spun Up',
      blurb: 'Barrels at speed in half the time, and the gyro fights you less while firing.',
      stats: { firingRotation: 1.7, heatRise: 1.1 },
      // Spin-up itself is folded in by `applyTurretAugment` below.
    },
  ],
  thunder: [
    {
      id: 'shockwave',
      displayName: 'Shockwave',
      blurb: 'A third more blast radius. Cover stops helping at the edges.',
      stats: { splashRadius: 1.35, splashDamage: 0.92 },
    },
    {
      id: 'concussion',
      displayName: 'Concussion',
      blurb: 'The overpressure knocks a gun crew out cold — hits sometimes disable the target briefly.',
      traits: { disrupt: { duration: 1.3, chance: 0.4 } },
    },
    {
      id: 'heavy_shell',
      displayName: 'Heavy Shell',
      blurb: 'More shell, slower loader. Direct hits land considerably harder.',
      stats: { damage: 1.18, reloadTime: 1.14, impactForce: 1.25 },
    },
  ],
  railgun: [
    {
      id: 'deep_pierce',
      displayName: 'Deep Pierce',
      blurb: 'Five tanks deep with far less bleed between them. A line of enemies is a single shot.',
      stats: { pierceTargets: 2, pierceLoss: 0.5 },
    },
    {
      id: 'capacitor',
      displayName: 'Capacitor',
      blurb: 'A third off the charge. You commit later and get the shot away sooner.',
      stats: { chargeTime: 0.62 },
    },
    {
      id: 'overcharge',
      displayName: 'Overcharge',
      blurb: 'A heavier rail with a longer cycle — the single biggest hit in the garage.',
      stats: { damage: 1.22, reloadTime: 1.18, recoil: 1.2 },
    },
  ],
  magnum: [
    {
      id: 'cluster',
      displayName: 'Cluster',
      blurb: 'Submunitions spread the blast wider and keep it lethal at the fringe.',
      stats: { splashRadius: 1.3, splashDamage: 1.25, damage: 0.85 },
    },
    {
      id: 'flat_trajectory',
      displayName: 'Flat Trajectory',
      blurb: 'A hotter charge: the bomb gets there far quicker and leads much less.',
      stats: { projectileSpeed: 1.45 },
    },
    {
      id: 'autoloader',
      displayName: 'Autoloader',
      blurb: 'A quarter off the reload, at the cost of the shell that made it worth waiting for.',
      stats: { reloadTime: 0.74, damage: 0.88, splashDamage: 0.88 },
    },
  ],
  gauss: [
    {
      id: 'capacitor_bank',
      displayName: 'Capacitor Bank',
      blurb: 'The super shot comes back around a quarter sooner.',
      stats: { altReload: 0.74 },
    },
    {
      id: 'piercing_slug',
      displayName: 'Piercing Slug',
      blurb: 'Tunes the light shot into a real rifle: more damage, much more reach.',
      stats: { damage: 1.22, range: 1.3, altDamage: 0.9 },
    },
    {
      id: 'overpressure_core',
      displayName: 'Overpressure Core',
      blurb: 'Everything goes into the super shot — harder, wider, and slower to charge.',
      stats: { altDamage: 1.18, altSplashRadius: 1.3, chargeTime: 1.25 },
    },
  ],
  shaft: [
    {
      /**
       * The augment that changes how the turret is played rather than what its
       * numbers say. Shaft's scope normally nails the hull to the floor, which
       * is why a flanker beats it; this trades charge speed for the right to
       * keep moving.
       */
      id: 'mobile_scope',
      displayName: 'Mobile Scope',
      blurb: 'Gyro-stabilised optics: you can drive while scoped. The charge builds slower for it.',
      stats: { scopedMobile: true, scopedCharge: 1.3 },
    },
    {
      id: 'steady_aim',
      displayName: 'Steady Aim',
      blurb: 'Reaches full charge in two seconds instead of three, and settles faster after the shot.',
      stats: { scopedCharge: 0.68, scopedRecoil: 0.5 },
    },
    {
      id: 'match_ammo',
      displayName: 'Match Ammo',
      blurb: 'A hand-loaded top end. Charged shots hit appreciably harder, and a wounded target is simply finished.',
      stats: { scopedDamage: 1.18, scopedReload: 1.12 },
      traits: { execute: { below: 0.35, bonus: 0.3 } },
    },
  ],
  terminator: [
    {
      id: 'disruptor',
      displayName: 'Disruptor',
      blurb: 'The beam scrambles fire control — targets are regularly left unable to shoot back.',
      traits: { disrupt: { duration: 0.9, chance: 0.25 } },
    },
    {
      id: 'extended_emitter',
      displayName: 'Extended Emitter',
      blurb: 'Holds its lock a third further out.',
      stats: { beamRange: 1.3, range: 1.3 },
    },
    {
      id: 'overload_coil',
      displayName: 'Overload Coil',
      blurb: 'A quarter more damage per tick, and a slower traverse to carry the coil.',
      stats: { damage: 1.25, rotationSpeed: 0.85 },
    },
  ],
  cataclysm: [
    {
      id: 'incendiary',
      displayName: 'Incendiary',
      blurb: 'Siege rounds that leave everything they touch burning.',
      traits: { ignite: { dps: 60, duration: 5 } },
    },
    {
      id: 'siege_charge',
      displayName: 'Siege Charge',
      blurb: 'A wider blast that reaches into whatever the target was hiding behind.',
      stats: { splashRadius: 1.25, splashDamage: 1.1 },
    },
    {
      id: 'rapid_cycling',
      displayName: 'Rapid Cycling',
      blurb: 'A fifth off the reload, and less behind each shell.',
      stats: { reloadTime: 0.8, damage: 0.9 },
    },
  ],
};

const HULL_TABLE: Record<string, Spec[]> = {
  wasp: [
    {
      id: 'featherweight',
      displayName: 'Featherweight',
      blurb: 'Stripped to the frame. Quicker off the line and faster flat out, with less to lose.',
      stats: { acceleration: 1.2, topSpeed: 1.08, protection: 0.92 },
    },
    {
      id: 'adrenaline',
      displayName: 'Adrenaline',
      blurb: 'Below a third health the governor comes off and the hull runs a quarter faster.',
      traits: { adrenaline: { below: 0.35, speed: 1.3 } },
    },
    {
      id: 'fast_charge',
      displayName: 'Fast Charge',
      blurb: 'A hot reactor: the N2 bomb comes back around a third sooner.',
      stats: { overdriveCharge: 1.35 },
    },
  ],
  hornet: [
    {
      id: 'grip_tuning',
      displayName: 'Grip Tuning',
      blurb: 'Tightens up Hornet’s trademark drift, which is either the fix or the problem.',
      stats: { lateralAcceleration: 1.8, turnSpeed: 1.08 },
    },
    {
      id: 'scout_plating',
      displayName: 'Scout Plating',
      blurb: 'Enough extra armour to survive the trip back out, at a little top speed.',
      stats: { protection: 1.14, topSpeed: 0.96 },
    },
    {
      id: 'kill_rush',
      displayName: 'Kill Rush',
      blurb: 'Every kill dumps a fifth of a bar straight into the sonar.',
      traits: { overdriveOnKill: 0.2 },
    },
  ],
  hopper: [
    {
      id: 'skimmer',
      displayName: 'Skimmer',
      blurb: 'Runs the lifters hard: noticeably faster, and thinner where it counts.',
      stats: { topSpeed: 1.12, acceleration: 1.1, protection: 0.94 },
    },
    {
      id: 'dampeners',
      displayName: 'Dampeners',
      blurb: 'Inertial dampers soak recoil and impacts — a stable platform for a heavy gun.',
      stats: { recoilResistance: 0.45 },
    },
    {
      id: 'repair_loop',
      displayName: 'Repair Loop',
      blurb: 'Nanite loop repairs the hull steadily once nothing has hit you for six seconds.',
      traits: { regen: { perSecond: 45, delay: 6 } },
    },
  ],
  hunter: [
    {
      id: 'reactive_armour',
      displayName: 'Reactive Armour',
      blurb: 'Takes a tenth less from everything. Boring, and the reason Hunter is still standing.',
      traits: { damageTaken: 0.9 },
    },
    {
      id: 'field_repair',
      displayName: 'Field Repair',
      blurb: 'Repairs itself between fights — five seconds clear and the hull starts closing up.',
      traits: { regen: { perSecond: 55, delay: 5 } },
    },
    {
      id: 'ram_plate',
      displayName: 'Ram Plate',
      blurb: 'A welded prow. Driving into someone at speed hurts them considerably more than you.',
      traits: { ram: { damage: 320, minSpeed: 5 } },
    },
  ],
  crusader: [
    {
      id: 'ablative_coating',
      displayName: 'Ablative Coating',
      blurb: 'Fire and ice slide off: hostile effects last less than half as long.',
      traits: { statusResistance: 0.55, burnTaken: 0.6 },
      stats: { heatResistance: 15 },
    },
    {
      id: 'reinforced_hull',
      displayName: 'Reinforced Hull',
      blurb: 'More plate, less pace.',
      stats: { protection: 1.15, topSpeed: 0.94, acceleration: 0.94 },
    },
    {
      id: 'kinetic_buffer',
      displayName: 'Kinetic Buffer',
      blurb: 'Shrugs off shells and the shoves that come with them.',
      traits: { damageTaken: 0.92 },
      stats: { recoilResistance: 0.35 },
    },
  ],
  viking: [
    {
      id: 'supply_chain',
      displayName: 'Supply Chain',
      blurb: 'Kits go further: repairs heal more and every buff runs longer.',
      traits: { supplyPotency: 1.45 },
    },
    {
      id: 'overclock',
      displayName: 'Overclock',
      blurb: 'Supercharge comes back a quarter sooner, which is most of what Viking is for.',
      stats: { overdriveCharge: 1.3 },
    },
    {
      id: 'heavy_frame',
      displayName: 'Heavy Frame',
      blurb: 'A medium that takes a heavy’s beating, at a medium’s pace minus a little.',
      stats: { protection: 1.14, topSpeed: 0.95 },
    },
  ],
  dictator: [
    {
      id: 'bulwark',
      displayName: 'Bulwark',
      blurb: 'Layered plate across the front arc. An eighth off everything that reaches you.',
      traits: { damageTaken: 0.88 },
    },
    {
      id: 'torque_governor',
      displayName: 'Torque Governor',
      blurb: 'Fixes the thing everyone complains about: Dictator finally turns.',
      stats: { turnSpeed: 1.3, acceleration: 1.2 },
    },
    {
      id: 'requisition_boost',
      displayName: 'Requisition Boost',
      blurb: 'Everything the hull hands out lands heavier, on you and on the squad.',
      traits: { supplyPotency: 1.4 },
    },
  ],
  ares: [
    {
      id: 'regenerative_plating',
      displayName: 'Regenerative Plating',
      blurb: 'Ares repairs itself as well as everyone else, once it is out of contact.',
      traits: { regen: { perSecond: 70, delay: 5 } },
    },
    {
      id: 'heat_shields',
      displayName: 'Heat Shields',
      blurb: 'Built for a burning arena: fire barely registers and effects wash off fast.',
      stats: { heatResistance: 35 },
      traits: { burnTaken: 0.45, statusResistance: 0.4 },
    },
    {
      id: 'siege_mode',
      displayName: 'Siege Mode',
      blurb: 'Trades what little speed it had for a tenth off all incoming damage.',
      traits: { damageTaken: 0.9 },
      stats: { topSpeed: 0.9, recoilResistance: 0.2 },
    },
  ],
  titan: [
    {
      id: 'bastion',
      displayName: 'Bastion',
      blurb: 'A wall. A seventh off everything, and slower than it already was.',
      traits: { damageTaken: 0.86 },
      stats: { topSpeed: 0.92 },
    },
    {
      /** Pairs with Vulcan's Ignition: the hull that can afford to stay overheated. */
      id: 'thermal_sink',
      displayName: 'Thermal Sink',
      blurb: 'Heat sinks through the whole chassis — your own barrel barely scorches you, and neither does anyone else’s fire.',
      stats: { heatResistance: 40 },
      traits: { burnTaken: 0.5, statusResistance: 0.3 },
    },
    {
      id: 'counterweight',
      displayName: 'Counterweight',
      blurb: 'Anchors the hull against recoil and lets it swing round faster than it should.',
      stats: { recoilResistance: 0.55, turnSpeed: 1.25 },
    },
  ],
  mammoth: [
    {
      id: 'juggernaut_plating',
      displayName: 'Juggernaut Plating',
      blurb: 'Even more of what Mammoth already is.',
      stats: { protection: 1.14, topSpeed: 0.94 },
    },
    {
      id: 'spall_liner',
      displayName: 'Spall Liner',
      blurb: 'Sheds fragments back down the line of fire — attackers eat a slice of what they deal.',
      traits: { thorns: 0.15 },
    },
    {
      id: 'charger',
      displayName: 'Charger',
      blurb: 'Four and a half tonnes with somewhere to be. Running someone down is a real attack.',
      stats: { topSpeed: 1.12, acceleration: 1.15 },
      traits: { ram: { damage: 520, minSpeed: 4 } },
    },
  ],
  juggernaut: [
    {
      id: 'siege_reactor',
      displayName: 'Siege Reactor',
      blurb: 'Purge comes back far sooner. The raid gets less time between resets.',
      stats: { overdriveCharge: 1.4 },
    },
    {
      id: 'bulwark_field',
      displayName: 'Bulwark Field',
      blurb: 'A tenth off everything the raid throws at it.',
      traits: { damageTaken: 0.9 },
    },
    {
      id: 'grinder',
      displayName: 'Grinder',
      blurb: 'Drives through raiders rather than around them.',
      traits: { ram: { damage: 900, minSpeed: 3 } },
    },
  ],
};

function build(): Record<string, AugmentDef> {
  const out: Record<string, AugmentDef> = {};
  for (const [slot, table] of [
    ['turret', TURRET_TABLE],
    ['hull', HULL_TABLE],
  ] as [AugmentSlot, Record<string, Spec[]>][]) {
    for (const [item, specs] of Object.entries(table)) {
      for (const spec of specs) {
        const id = `${item}.${spec.id}`;
        out[id] = { ...spec, id, slot, item };
      }
    }
  }
  return out;
}

export const AUGMENTS = build();

/** Every augment that can be fitted to one item, in menu order. */
export function augmentsFor(slot: AugmentSlot, item: string): AugmentDef[] {
  const table = slot === 'turret' ? TURRET_TABLE : HULL_TABLE;
  return (table[item] ?? []).map((spec) => AUGMENTS[`${item}.${spec.id}`]);
}

/**
 * Looks an augment up and checks it actually belongs to the item it is being
 * fitted to. A saved garage from before a rename — or a bot persona pointing at
 * the wrong turret — comes back as "no augment" rather than as a silent buff on
 * something it was never balanced against.
 */
export function augmentFor(slot: AugmentSlot, item: string, id: string | null | undefined): AugmentDef | null {
  if (!id) return null;
  const def = AUGMENTS[id];
  if (!def || def.slot !== slot || def.item !== item) return null;
  return def;
}

/** One of an item's augments at random, for bots that have no preference. */
export function randomAugmentFor(slot: AugmentSlot, item: string): AugmentDef | null {
  const list = augmentsFor(slot, item);
  if (!list.length) return null;
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * Traits from both slots, as one object. Offensive traits are authored on
 * turrets and defensive ones on hulls, so the two sets never collide and a
 * spread is the whole merge.
 */
export function mergeTraits(turret: AugmentDef | null, hull: AugmentDef | null): AugmentTraits {
  return { ...(turret?.traits ?? {}), ...(hull?.traits ?? {}) };
}

const mul = (base: number, k: number | undefined): number => (k == null ? base : base * k);

/** Folds an augment's numbers into a copy of the turret definition. */
export function applyTurretAugment(def: TurretDef, aug: AugmentDef | null): TurretDef {
  const s = aug?.stats;
  if (!s) return def;

  const out: TurretDef = { ...def };
  out.damage = mul(def.damage, s.damage);
  out.weakDamage = mul(def.weakDamage, s.damage);
  if (def.criticalDamage != null) out.criticalDamage = mul(def.criticalDamage, s.criticalDamage ?? s.damage);
  if (def.critChanceStep != null) out.critChanceStep = mul(def.critChanceStep, s.critChanceStep);
  if (def.healPerTick != null) out.healPerTick = mul(def.healPerTick, s.healPerTick);

  out.reloadTime = mul(def.reloadTime, s.reloadTime);
  out.rotationSpeed = mul(def.rotationSpeed, s.rotationSpeed);
  out.rotationAcceleration = mul(def.rotationAcceleration, s.rotationSpeed);
  out.impactForce = mul(def.impactForce, s.impactForce);
  out.recoil = mul(def.recoil, s.recoil);
  out.rangeMaxDamage = mul(def.rangeMaxDamage, s.range);
  out.rangeMinDamage = mul(def.rangeMinDamage, s.range);
  if (def.hardCap != null) out.hardCap = mul(def.hardCap, s.range);
  if (def.projectileSpeed != null) out.projectileSpeed = mul(def.projectileSpeed, s.projectileSpeed);
  if (def.firingRotationMultiplier != null) {
    // A multiplier on a penalty: clamped so an augment can cancel the penalty
    // but never turn it into a bonus the turret was not authored to have.
    out.firingRotationMultiplier = Math.min(1, mul(def.firingRotationMultiplier, s.firingRotation));
  }

  if (def.splash) {
    out.splash = {
      radius: mul(def.splash.radius, s.splashRadius),
      damageMax: def.splash.damageMax != null ? mul(def.splash.damageMax, s.splashDamage ?? s.damage) : undefined,
      damageMin: mul(def.splash.damageMin, s.splashDamage ?? s.damage),
    };
  }
  if (def.clip) {
    out.clip = {
      ...def.clip,
      size: Math.max(1, def.clip.size + (s.clipSize ?? 0)),
      shotInterval: mul(def.clip.shotInterval, s.shotInterval),
    };
  }
  if (def.pellets) {
    out.pellets = {
      count: Math.max(1, def.pellets.count + (s.pellets ?? 0)),
      spreadDeg: mul(def.pellets.spreadDeg, s.pelletSpread),
    };
  }
  if (def.bounces != null) out.bounces = Math.max(0, def.bounces + (s.bounces ?? 0));
  if (def.pierce) {
    out.pierce = {
      targets: Math.max(1, def.pierce.targets + (s.pierceTargets ?? 0)),
      damageLossPerTarget: mul(def.pierce.damageLossPerTarget, s.pierceLoss),
    };
  }
  if (def.charge) out.charge = { ...def.charge, time: mul(def.charge.time, s.chargeTime) };
  if (def.guided) {
    out.guided = {
      ...def.guided,
      missiles: Math.max(1, def.guided.missiles + (s.guidedMissiles ?? 0)),
      lockTime: mul(def.guided.lockTime, s.lockTime),
    };
  }
  if (def.chain) {
    out.chain = {
      ...def.chain,
      jumps: Math.max(0, def.chain.jumps + (s.chainJumps ?? 0)),
      // Falloff is a survival fraction, so it can be improved but never past 1.
      falloff: Math.min(0.95, mul(def.chain.falloff, s.chainFalloff)),
    };
  }
  if (def.cone) {
    out.cone = {
      ...def.cone,
      angleDeg: mul(def.cone.angleDeg, s.coneAngle),
      range: mul(def.cone.range, s.coneRange),
    };
  }
  if (def.beam) out.beam = { ...def.beam, range: mul(def.beam.range, s.beamRange) };
  if (def.fuel) {
    out.fuel = {
      ...def.fuel,
      capacity: mul(def.fuel.capacity, s.fuelCapacity),
      drainPerSec: mul(def.fuel.drainPerSec, s.fuelDrain),
      rechargePerSec: mul(def.fuel.rechargePerSec, s.fuelRecharge),
      healDrainPerSec:
        def.fuel.healDrainPerSec != null ? mul(def.fuel.healDrainPerSec, s.fuelDrain) : undefined,
    };
  }
  if (def.heat) {
    out.heat = {
      ...def.heat,
      risePerSec: mul(def.heat.risePerSec, s.heatRise),
      fallPerSec: mul(def.heat.fallPerSec, s.heatFall),
      selfBurnDps: mul(def.heat.selfBurnDps, s.selfBurn),
      // Spin-up rides on the same knob that loosens the firing traverse: both
      // are "the gyro fights you less", and splitting them into two fields
      // nobody would ever set independently is noise.
      spinUp: s.firingRotation ? def.heat.spinUp / s.firingRotation : def.heat.spinUp,
      ceiling: (def.heat.ceiling ?? DEFAULT_HEAT_CEILING) + (s.heatCeiling ?? 0),
    };
  }
  if (def.applies) {
    out.applies = {
      ...def.applies,
      magnitude: mul(def.applies.magnitude, s.statusMagnitude),
      duration: mul(def.applies.duration, s.statusDuration),
    };
  }
  if (def.scoped) {
    out.scoped = {
      ...def.scoped,
      minDamage: mul(def.scoped.minDamage, s.scopedDamage),
      maxDamage: mul(def.scoped.maxDamage, s.scopedDamage),
      chargeTime: mul(def.scoped.chargeTime, s.scopedCharge),
      reloadTime: mul(def.scoped.reloadTime, s.scopedReload),
      recoil: mul(def.scoped.recoil, s.scopedRecoil),
      movementLocked: s.scopedMobile ? false : def.scoped.movementLocked,
    };
  }
  if (def.alt) {
    out.alt = {
      ...def.alt,
      damage: mul(def.alt.damage, s.altDamage),
      weakDamage: mul(def.alt.weakDamage, s.altDamage),
      reloadTime: mul(def.alt.reloadTime, s.altReload),
      splash: def.alt.splash
        ? {
            radius: mul(def.alt.splash.radius, s.altSplashRadius),
            damageMax:
              def.alt.splash.damageMax != null ? mul(def.alt.splash.damageMax, s.altDamage) : undefined,
            damageMin: mul(def.alt.splash.damageMin, s.altDamage),
          }
        : undefined,
    };
  }
  return out;
}

/** Folds an augment's numbers into a copy of the hull definition. */
export function applyHullAugment(def: HullDef, aug: AugmentDef | null): HullDef {
  const s = aug?.stats;
  if (!s) return def;
  return {
    ...def,
    protection: Math.round(mul(def.protection, s.protection)),
    topSpeed: mul(def.topSpeed, s.topSpeed),
    acceleration: mul(def.acceleration, s.acceleration),
    reverseAcceleration: mul(def.reverseAcceleration, s.acceleration),
    nitroAcceleration: mul(def.nitroAcceleration, s.acceleration),
    lateralAcceleration: mul(def.lateralAcceleration, s.lateralAcceleration),
    turnSpeed: mul(def.turnSpeed, s.turnSpeed),
    heatResistance: Math.min(100, def.heatResistance + (s.heatResistance ?? 0)),
    recoilResistance:
      s.recoilResistance != null
        ? Math.min(1, (def.recoilResistance ?? 0) + s.recoilResistance)
        : def.recoilResistance,
    overdriveChargePerBattlePoint: mul(def.overdriveChargePerBattlePoint, s.overdriveCharge),
    overdriveChargePerSecond: mul(def.overdriveChargePerSecond, s.overdriveCharge),
  };
}
