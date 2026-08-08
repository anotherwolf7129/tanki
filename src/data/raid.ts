/**
 * Boss Raid tuning. One squad — you plus a handful of allied bots — against a
 * single Overseer that is far tougher and materially smarter than a line bot.
 *
 * The mode's whole design sits on one tension, and every number here serves it:
 * you deal far more damage to the boss than your squadmates do, and the boss
 * decides who to shoot by accumulated damage. Your advantage *is* what puts you
 * in front of the gun. Managing that — trading aggro with the squad, working
 * round to the engine deck while it is busy elsewhere — is the mode.
 */

/** The boss's hull and gun. Neither is available in the garage. */
export const BOSS_HULL = 'juggernaut';
export const BOSS_TURRET = 'cataclysm';
export const BOSS_NAME = 'OVERSEER';

/**
 * Health pool. Sized so a full squad needs several sustained minutes rather
 * than one good burst, and so adding a squadmate lengthens the fight instead of
 * trivialising it.
 */
export const BOSS_BASE_HEALTH = 22000;
export const BOSS_HEALTH_PER_ALLY = 5000;

/**
 * How much of your damage lands, and how much of theirs. The gap is deliberate
 * and shown in the garage: you are the raid's damage, the squad is its noise.
 */
export const PLAYER_BOSS_DAMAGE = 2;
export const ALLY_BOSS_DAMAGE = 0.45;

/**
 * Squadmates run full-tier hulls instead of the bot equipment gap. They keep
 * the bot turret tier, so the damage advantage above is untouched — this buys
 * them survival, not output. A raid squad on line-bot armour simply evaporates
 * under the first barrage, and a boss fight with nobody else left standing is
 * not a raid.
 */
export const ALLY_HULL_MULTIPLIER = 1;

/**
 * Rear-arc bonus. A direct hit landing behind the boss's shoulders strikes the
 * engine deck. This is the skill expression the mode is built around: the boss
 * actively keeps its back to walls and turns to face whoever hurts it most, so
 * a breach costs you a real manoeuvre rather than a lucky angle.
 */
export const BREACH_MULTIPLIER = 1.6;
/** Cosine of the bearing beyond which a hit counts as a rear-arc hit. */
export const BREACH_COS = -0.35;

/**
 * Battle points per point of damage dealt to the boss. There is only one thing
 * to kill in a raid, so the scoreboard has to pay for the work rather than the
 * killing blow — otherwise a squadmate who tanked for four minutes reads as
 * having done nothing.
 */
export const POINTS_PER_DAMAGE = 0.012;

/** Shared respawn pool for the whole squad, plus one per ally. */
export const BASE_REINFORCEMENTS = 6;
export const REINFORCEMENTS_PER_ALLY = 4;

/**
 * Repair. This exists to stop a losing raid simply refusing to fight and
 * running out the clock, and it is deliberately narrow: the boss has to be both
 * unhurt for this long *and* unable to see anyone. A squad that is dying and
 * respawning is still fighting, so the natural rhythm of a raid never feeds it.
 *
 * It also cannot undo a phase. Whatever gate the raid has pushed it through
 * stays pushed, so a long fight is always progress even when it goes badly.
 */
export const REGEN_DELAY = 10;
/** Fraction of its maximum health the boss repairs per second while left alone. */
export const REGEN_PER_SECOND = 0.0008;

export interface RaidPhase {
  index: number;
  name: string;
  /** Health fraction at or below which this phase becomes active. */
  from: number;
  /** Multiplier on every ability cooldown. */
  cooldownScale: number;
  /** Shells in a Siege Barrage salvo. */
  shells: number;
  blurb: string;
}

/**
 * Phases change tempo, never numbers. A boss that quietly gains armour reads as
 * cheating; a boss that starts firing salvos twice as often reads as angry.
 */
export const RAID_PHASES: RaidPhase[] = [
  {
    index: 1,
    name: 'Advance',
    from: 1,
    cooldownScale: 1,
    shells: 3,
    blurb: 'Holds the middle distance and picks off whoever hurts it most.',
  },
  {
    index: 2,
    name: 'Siege',
    from: 0.66,
    cooldownScale: 0.72,
    shells: 4,
    blurb: 'Salvos come faster and it stops letting anyone sit behind cover.',
  },
  {
    index: 3,
    name: 'Meltdown',
    from: 0.33,
    cooldownScale: 0.5,
    shells: 6,
    blurb: 'Abilities on a short leash, and it will run a lone raider down.',
  },
];

export function phaseFor(healthFraction: number): RaidPhase {
  let phase = RAID_PHASES[0];
  for (const p of RAID_PHASES) if (healthFraction <= p.from) phase = p;
  return phase;
}

/** Difficulty scales the boss's pool through the same knob bots are tuned by. */
export function bossHealth(allyCount: number, hullTierMultiplier: number): number {
  const pool = BOSS_BASE_HEALTH + BOSS_HEALTH_PER_ALLY * Math.max(0, allyCount);
  return Math.round(pool * (hullTierMultiplier / 0.7));
}

export function reinforcementsFor(allyCount: number): number {
  return BASE_REINFORCEMENTS + REINFORCEMENTS_PER_ALLY * Math.max(0, allyCount);
}

export interface BossAbilityDef {
  id: 'quake' | 'barrage' | 'overcharge';
  displayName: string;
  /** Seconds of visible wind-up before the ability resolves. */
  windup: number;
  cooldown: number;
  /** Warning pushed to the kill feed when the wind-up starts. */
  warning: string;
}

export const BOSS_ABILITIES: Record<BossAbilityDef['id'], BossAbilityDef> = {
  quake: {
    id: 'quake',
    displayName: 'Quake',
    windup: 1.1,
    cooldown: 17,
    warning: 'OVERSEER is winding up a Quake — get out of the ring',
  },
  barrage: {
    id: 'barrage',
    displayName: 'Siege Barrage',
    windup: 1.4,
    cooldown: 15,
    warning: 'OVERSEER is ranging a Siege Barrage — cover will not save you',
  },
  overcharge: {
    id: 'overcharge',
    displayName: 'Overcharge',
    windup: 0.9,
    cooldown: 26,
    warning: 'OVERSEER is overcharging — it is coming for someone',
  },
};

export const QUAKE_RADIUS = 19;
export const QUAKE_DAMAGE_CENTRE = 550;
export const QUAKE_DAMAGE_EDGE = 200;
export const QUAKE_IMPULSE = 9;

export const BARRAGE_SPEED = 78;
export const BARRAGE_GRAVITY = 24;
export const BARRAGE_INTERVAL = 0.32;
export const BARRAGE_DAMAGE = 400;
export const BARRAGE_SPLASH_RADIUS = 10;
export const BARRAGE_SPREAD = 6;

export const OVERCHARGE_DURATION = 9;
