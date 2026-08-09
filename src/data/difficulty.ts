/**
 * The player-advantage layer. Everything here is a knob; the shipped presets
 * shade from "bots are slow and imprecise" to "bots are you".
 *
 * The design rule from the spec is worth restating because it constrains every
 * value below: bots are never made weak or passive, only *slow* and
 * *imprecise*. Health and rate of fire stay respectable; reaction time and aim
 * error carry the difficulty.
 *
 * On top of that sits the equipment gap, and it never closes: on every preset
 * the player's hull and turret are tiered above anything else on the field,
 * squadmates included. Difficulty decides how *much* of an edge that is, not
 * whether there is one — the tank you drive is meant to read as the best one in
 * the battle, and the only thing that outclasses it is the Overseer, whose pool
 * is authored outside this table entirely.
 */
export interface DifficultyProfile {
  name: string;
  blurb: string;
  bot: {
    hullTierMultiplier: number;
    turretTierMultiplier: number;
    reactionDelayMs: [number, number];
    aimErrorDeg: number;
    minAimErrorDeg: number;
    /** Fraction of aim error shed per second of continuous tracking. */
    trackingConvergence: number;
    fovDegrees: number;
    viewDistance: number;
    supplyUseChance: number;
    overdriveChargeRate: number;
    /** Chance per decision tick of re-evaluating the current target. */
    targetSwitchChance: number;
    spawnProtection: number;
    /**
     * Whether bots fit augments. Part of the equipment gap rather than a
     * separate difficulty knob: on Recruit you are the only tank on the field
     * with a modification, and the garage says so.
     */
    augments: boolean;
  };
  player: {
    aimAssistStrength: number;
    lastHitProtection: boolean;
    overdriveChargeRate: number;
    damageDealtMultiplier: number;
    damageTakenMultiplier: number;
    hullTierMultiplier: number;
    turretTierMultiplier: number;
    spawnProtection: number;
  };
  dynamic: { enabled: boolean; targetKD: number; adjustRate: number };
}

export const DIFFICULTIES: Record<string, DifficultyProfile> = {
  recruit: {
    name: 'Recruit',
    blurb: 'Bots are slow to spot you and shoot loosely. You out-gun them outright.',
    bot: {
      hullTierMultiplier: 0.55,
      turretTierMultiplier: 0.7,
      reactionDelayMs: [500, 900],
      aimErrorDeg: 7,
      minAimErrorDeg: 2.6,
      trackingConvergence: 0.25,
      fovDegrees: 100,
      viewDistance: 90,
      supplyUseChance: 0.1,
      overdriveChargeRate: 0.35,
      targetSwitchChance: 0.12,
      spawnProtection: 1,
      augments: false,
    },
    player: {
      aimAssistStrength: 0.5,
      lastHitProtection: true,
      overdriveChargeRate: 3,
      damageDealtMultiplier: 1.15,
      damageTakenMultiplier: 0.85,
      hullTierMultiplier: 1.45,
      turretTierMultiplier: 1.35,
      spawnProtection: 3,
    },
    dynamic: { enabled: true, targetKD: 3, adjustRate: 0.2 },
  },
  standard: {
    name: 'Standard',
    blurb: 'The intended experience. Flanking always works; standing still does not.',
    bot: {
      hullTierMultiplier: 0.7,
      turretTierMultiplier: 0.85,
      reactionDelayMs: [280, 600],
      aimErrorDeg: 5,
      minAimErrorDeg: 1.5,
      trackingConvergence: 0.45,
      fovDegrees: 110,
      viewDistance: 120,
      supplyUseChance: 0.25,
      overdriveChargeRate: 0.5,
      targetSwitchChance: 0.2,
      spawnProtection: 1,
      augments: true,
    },
    player: {
      aimAssistStrength: 0.35,
      lastHitProtection: true,
      overdriveChargeRate: 2,
      damageDealtMultiplier: 1,
      damageTakenMultiplier: 1,
      hullTierMultiplier: 1.35,
      turretTierMultiplier: 1.25,
      spawnProtection: 3,
    },
    dynamic: { enabled: true, targetKD: 2.5, adjustRate: 0.2 },
  },
  veteran: {
    name: 'Veteran',
    blurb: 'Bots react in a third of a second and hold their aim. Your gear is still the best on the field.',
    bot: {
      hullTierMultiplier: 0.9,
      turretTierMultiplier: 0.95,
      reactionDelayMs: [180, 380],
      aimErrorDeg: 3.2,
      minAimErrorDeg: 0.9,
      trackingConvergence: 0.7,
      fovDegrees: 130,
      viewDistance: 160,
      supplyUseChance: 0.5,
      overdriveChargeRate: 0.8,
      targetSwitchChance: 0.3,
      spawnProtection: 2,
      augments: true,
    },
    player: {
      aimAssistStrength: 0.15,
      lastHitProtection: false,
      overdriveChargeRate: 1.3,
      damageDealtMultiplier: 1,
      damageTakenMultiplier: 1,
      hullTierMultiplier: 1.2,
      turretTierMultiplier: 1.15,
      spawnProtection: 3,
    },
    dynamic: { enabled: false, targetKD: 2, adjustRate: 0.15 },
  },
  nightmare: {
    name: 'Nightmare',
    blurb: 'No handicap of any kind — 120 ms reactions, converging aim. Only your gear is still ahead.',
    bot: {
      hullTierMultiplier: 1,
      turretTierMultiplier: 1,
      reactionDelayMs: [90, 200],
      aimErrorDeg: 2,
      minAimErrorDeg: 0.35,
      trackingConvergence: 0.9,
      fovDegrees: 160,
      viewDistance: 220,
      supplyUseChance: 0.8,
      overdriveChargeRate: 1.2,
      targetSwitchChance: 0.35,
      spawnProtection: 3,
      augments: true,
    },
    player: {
      aimAssistStrength: 0,
      lastHitProtection: false,
      overdriveChargeRate: 1,
      damageDealtMultiplier: 1,
      damageTakenMultiplier: 1,
      hullTierMultiplier: 1.15,
      turretTierMultiplier: 1.15,
      spawnProtection: 3,
    },
    dynamic: { enabled: false, targetKD: 1.5, adjustRate: 0 },
  },
};

export const DIFFICULTY_IDS = Object.keys(DIFFICULTIES);

/** Kept off the HUD deliberately — the player should never see the net. */
export const LAST_HIT_FLOOR = 0.1;
export const LAST_HIT_COOLDOWN = 60;

/**
 * Rolling-window dynamic difficulty. Adjustments are multiplicative and capped
 * so a genuinely good player can still reach total dominance.
 */
export class DynamicDifficulty {
  private kills: number[] = [];
  private deaths: number[] = [];
  private elapsed = 0;
  /** 1 = profile as authored; >1 = bots handicapped further. */
  slack = 1;

  constructor(
    private readonly profile: DifficultyProfile,
    private readonly windowSec = 90,
  ) {}

  recordKill(): void {
    if (this.profile.dynamic.enabled) this.kills.push(this.elapsed);
  }

  recordDeath(): void {
    if (this.profile.dynamic.enabled) this.deaths.push(this.elapsed);
  }

  update(dt: number): void {
    this.elapsed += dt;
    if (!this.profile.dynamic.enabled) return;
    const cutoff = this.elapsed - this.windowSec;
    this.kills = this.kills.filter((t) => t >= cutoff);
    this.deaths = this.deaths.filter((t) => t >= cutoff);
    if (this.elapsed < 25) return;

    const kd = this.kills.length / Math.max(1, this.deaths.length);
    const { targetKD, adjustRate } = this.profile.dynamic;
    if (kd < targetKD * 0.6) {
      this.slack = Math.min(1.6, this.slack + adjustRate * dt * 0.35);
    } else if (kd > targetKD * 1.6) {
      this.slack = Math.max(0.75, this.slack - adjustRate * dt * 0.3);
    }
  }
}
