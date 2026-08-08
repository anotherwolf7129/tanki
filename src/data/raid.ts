import type { HullDef } from './schema';

/**
 * Boss Raid tuning. One squad — you plus a handful of allied bots — against a
 * single Overseer that is far tougher and materially smarter than a line bot.
 *
 * The mode's whole design sits on one tension, and every number here serves it:
 * you deal far more damage to the boss than your squadmates do, and the boss
 * decides who to shoot by accumulated damage. Your advantage *is* what puts you
 * in front of the gun. Managing that — trading aggro with the squad, working
 * round to the engine deck while it is busy elsewhere — is the mode.
 *
 * The raid is meant to be *hard*. Nobody runs out of lives — the squad comes
 * back forever — so the only two things that can end a raid badly are the clock
 * and the Overseer healing faster than you hurt it. That is what every number
 * below is aimed at: dying is expensive in tempo, never in tickets.
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
 * Siege ordnance: the multiplier on everything the Overseer does to a raider.
 *
 * The Cataclysm was authored as a tank gun and the boss is not fighting tanks,
 * it is besieging them. A direct hit lands for the shell plus its own blast, so
 * at ×1.20 a light hull comes out of one the other side on a sliver — the
 * "almost" is the whole point. You are allowed exactly one mistake.
 */
export const BOSS_LETHALITY = 1.2;

/**
 * And how that lands on each hull class. Small hulls are what the gun is sized
 * against; heavy hulls are the answer to it. This is the one place in the game
 * where hull class changes how much damage you take rather than only how much
 * you have, and it exists so that "bring something that survives a shell" is a
 * real decision at the garage rather than a shrug.
 */
export const BOSS_CLASS_LETHALITY: Record<HullDef['class'], number> = {
  light: 1.28,
  medium: 1,
  heavy: 0.86,
  special: 0.8,
};

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

/**
 * Reinforcements are unlimited — the squad always comes back. What a death
 * costs is *time*, and the price rises with every one the raid has taken.
 *
 * This replaces the old shared ticket pool, which failed in both directions: a
 * raid that was winning never noticed it, and a raid that was losing was ended
 * by an accountant rather than by the boss. A climbing respawn delay is the
 * same pressure applied where you can feel it — the longer the squad has been
 * dying, the longer the Overseer is left alone with its repair kits.
 */
export const RESPAWN_BASE = 4;
export const RESPAWN_PER_LOSS = 0.25;
export const RESPAWN_MAX = 12;

export function respawnDelayFor(losses: number): number {
  return Math.min(RESPAWN_MAX, RESPAWN_BASE + RESPAWN_PER_LOSS * Math.max(0, losses));
}

/**
 * Repair. This exists to stop a losing raid simply refusing to fight and
 * running out the clock, and it is deliberately narrow: the boss has to be both
 * unhurt for this long *and* unable to see anyone. A squad that is dying and
 * respawning is still fighting, so the natural rhythm of a raid never feeds it.
 *
 * It also cannot undo a phase. Whatever gate the raid has pushed it through
 * stays pushed — every heal the boss has, from regeneration to its own repair
 * kits, is clamped to the top of the phase it is currently in — so a long fight
 * is always progress even when it goes badly.
 */
export const REGEN_DELAY = 10;
/** Fraction of its maximum health the boss repairs per second while left alone. */
export const REGEN_PER_SECOND = 0.0008;
/**
 * And how much faster it works while the entire raid is dead at once. A wipe no
 * longer ends the fight, so it has to cost something: the boss spends those
 * seconds patching, and the squad comes back to a healthier target.
 */
export const WIPE_REGEN_MULTIPLIER = 6;

/**
 * The Overseer carries field supplies like everyone else, and uses them for the
 * same reason you do. Repair kits are the interesting one: the heal-over-time
 * half is interrupted by damage exactly as yours is, so a boss that has just
 * cracked one open is a boss you can punish for it. That is the whole design —
 * it is not a heal, it is a window.
 */
export const BOSS_REPAIR_KITS = 4;
export const BOSS_ARMOR_KITS = 3;
export const BOSS_DAMAGE_KITS = 2;
/** Health fraction below which it will spend a repair kit. */
export const BOSS_REPAIR_AT = 0.72;
/** Seconds of not being shot it wants first, unless it is desperate. */
export const BOSS_REPAIR_QUIET = 1.6;
/** Below this it stops waiting for quiet and just uses the kit. */
export const BOSS_REPAIR_DESPERATE = 0.3;
/** How far it will detour for a supply box, and how hurt it has to be to bother. */
export const BOSS_BOX_REACH = 75;
export const BOSS_BOX_AT = 0.8;

export interface RaidPhase {
  index: number;
  name: string;
  /** Health fraction at or below which this phase becomes active. */
  from: number;
  /** Multiplier on every ability cooldown. */
  cooldownScale: number;
  /** Shells in a Siege Barrage salvo. */
  shells: number;
  /** Rounds the main gun puts downrange per trigger pull. */
  salvo: number;
  /** Fan angle between salvo rounds, in degrees. */
  salvoSpreadDeg: number;
  /** Berserk: permanently supercharged and running, from here down. */
  enraged?: boolean;
  blurb: string;
}

/**
 * Phases change tempo and volume, never armour. A boss that quietly gains
 * armour reads as cheating; a boss that shortens its cooldowns, fans three
 * shells out of one barrel and then goes berserk reads as *angry*, and every
 * one of those is still something you can dodge.
 *
 * Each gate is crossed exactly once — the boss can never heal back through one
 * — and crossing it slams the raid off it with a pressure wave, so a phase
 * change is an event rather than a number quietly changing on the HUD.
 */
export const RAID_PHASES: RaidPhase[] = [
  {
    index: 1,
    name: 'Advance',
    from: 1,
    cooldownScale: 1,
    shells: 3,
    salvo: 1,
    salvoSpreadDeg: 0,
    blurb: 'Holds the middle distance and picks off whoever hurts it most.',
  },
  {
    index: 2,
    name: 'Siege',
    from: 0.66,
    cooldownScale: 0.72,
    shells: 4,
    salvo: 2,
    salvoSpreadDeg: 4,
    blurb: 'Two shells a pull, salvos come faster, and cover stops being cover.',
  },
  {
    index: 3,
    name: 'Meltdown',
    from: 0.33,
    cooldownScale: 0.5,
    shells: 6,
    salvo: 3,
    salvoSpreadDeg: 5.5,
    blurb: 'Abilities on a short leash, three shells a pull, and it runs stragglers down.',
  },
  {
    index: 4,
    name: 'Wrath',
    from: 0.15,
    cooldownScale: 0.34,
    shells: 7,
    salvo: 4,
    salvoSpreadDeg: 7,
    enraged: true,
    blurb: 'Berserk. Reloads half again as fast, never stops moving, four shells a pull.',
  },
];

export function phaseFor(healthFraction: number): RaidPhase {
  let phase = RAID_PHASES[0];
  for (const p of RAID_PHASES) if (healthFraction <= p.from) phase = p;
  return phase;
}

/** Fire-rate multiplier and hull speed the boss keeps once enraged. */
export const ENRAGE_FIRE_RATE = 1.45;
/** Blast the boss throws off as it crosses a phase gate, to break the stack on it. */
export const PHASE_PULSE_RADIUS = 26;
export const PHASE_PULSE_DAMAGE = 380;
export const PHASE_PULSE_IMPULSE = 24;

/** Difficulty scales the boss's pool through the same knob bots are tuned by. */
export function bossHealth(allyCount: number, hullTierMultiplier: number): number {
  const pool = BOSS_BASE_HEALTH + BOSS_HEALTH_PER_ALLY * Math.max(0, allyCount);
  return Math.round(pool * (hullTierMultiplier / 0.7));
}

export interface BossAbilityDef {
  id: 'quake' | 'collapse' | 'barrage' | 'overcharge';
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
  collapse: {
    id: 'collapse',
    displayName: 'Structural Collapse',
    windup: 2.2,
    cooldown: 24,
    warning: 'OVERSEER is ranging the structures — get off your cover',
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

/**
 * Structural Collapse — the Overseer fighting with the map rather than on it.
 *
 * It ranges the cover the raid is actually using — the block you are hiding
 * behind, the crate you are reloading against, the supply drop everyone
 * converges on — and brings it down on top of you. Several structures at once,
 * each marked through the whole wind-up, so it is always a place you chose to
 * be standing.
 *
 * It is the exact inverse of the Siege Barrage: the barrage punishes hiding at
 * range, the collapse punishes hiding *at all*. Between them the only safe
 * ground is open ground, which is where its main gun lives. That is the trap,
 * and it is the reason the boss has an answer to every way a raid stalls.
 *
 * Falling masonry does not care about line of sight, so this resolves without
 * one — being on the wrong side of the cover is not a defence when the cover is
 * what is landing on you.
 */
export const COLLAPSE_RADIUS = 13;
export const COLLAPSE_DAMAGE_CENTRE = 820;
export const COLLAPSE_DAMAGE_EDGE = 260;
export const COLLAPSE_IMPULSE = 16;
/** How far from a raider a structure can be and still be dropped on them. */
export const COLLAPSE_REACH = 21;
/** Largest footprint a prop can have and still count as cover rather than terrain. */
export const COLLAPSE_MAX_SPAN = 26;
/** Shortest a prop can be and still be worth collapsing. */
export const COLLAPSE_MIN_HEIGHT = 1.4;
/** Structures it will bring down at once, by phase index. */
export const COLLAPSE_SITES = [2, 3, 4, 5];

export const BARRAGE_SPEED = 78;
export const BARRAGE_GRAVITY = 24;
export const BARRAGE_INTERVAL = 0.32;
export const BARRAGE_DAMAGE = 400;
export const BARRAGE_SPLASH_RADIUS = 10;
export const BARRAGE_SPREAD = 6;

export const OVERCHARGE_DURATION = 9;

/**
 * Purge, the Juggernaut's ultimate, vents the reactor: it throws the raid off
 * the hull and patches the boss on the way. The heal is small against a pool
 * this size and clamped to the phase gate like every other heal it has, so it
 * buys the Overseer a few seconds of breathing room rather than a reset — but a
 * raid that lets it charge Purge four times has given away a phase.
 *
 * The fraction itself lives on the hull in `hulls.json`, since that is where
 * the overdrive is defined; this is the health fraction below which the boss
 * will spend a charged Purge purely to heal, with nobody close enough to throw.
 */
export const PURGE_HEAL_AT = 0.55;
