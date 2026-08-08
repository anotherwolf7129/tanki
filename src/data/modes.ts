import type { ModeCode } from './schema';

export interface ModeDef {
  code: ModeCode;
  displayName: string;
  teams: boolean;
  blurb: string;
  /**
   * The mode's race-to-a-number win condition, or null for modes that only end
   * on the clock. Every mode counts something different — kills, flags, held
   * points — so this describes what it counts as well as the default value, and
   * the battle setup screen builds its slider from it.
   */
  limit: LimitSpec | null;
  timeLimit: number;
}

/**
 * A mode's win condition as a tunable. `max` is deliberately generous: the
 * default is a suggestion, and a lobby that wants a marathon should be able to
 * ask for one without editing the source.
 */
export interface LimitSpec {
  /** What the number counts, e.g. "kills". Used in the setup screen and HUD. */
  unit: string;
  /** Full label for the setup screen, e.g. "Team kill limit". */
  label: string;
  /** One line explaining whose total is being counted. */
  hint: string;
  value: number;
  max: number;
  step: number;
}

export const MODES: Record<ModeCode, ModeDef> = {
  DM: {
    code: 'DM',
    displayName: 'Deathmatch',
    teams: false,
    blurb: 'No teams. Only the killer scores. Highest gold box frequency.',
    limit: {
      unit: 'kills',
      label: 'Kill limit',
      hint: 'One player has to reach it alone, so it counts far slower than a team total.',
      value: 30,
      max: 100,
      step: 5,
    },
    timeLimit: 15 * 60,
  },
  TDM: {
    code: 'TDM',
    displayName: 'Team Deathmatch',
    teams: true,
    blurb: 'Red against Blue. Most kills wins.',
    limit: {
      unit: 'kills',
      label: 'Team kill limit',
      // Ten tanks trading kills bank a combined 30 in about three minutes,
      // which is why the old shared default ended a TDM before it started.
      hint: 'Counts one whole team’s kills, so it fills roughly as fast as the lobby is large.',
      value: 100,
      max: 400,
      step: 10,
    },
    timeLimit: 15 * 60,
  },
  CTF: {
    code: 'CTF',
    displayName: 'Capture the Flag',
    teams: true,
    blurb: 'Take the enemy flag home. Your own flag must be on its platform to score.',
    limit: {
      unit: 'flags',
      label: 'Flag limit',
      hint: 'Deliveries by one team. Kills never end a CTF battle.',
      value: 5,
      max: 30,
      step: 1,
    },
    timeLimit: 15 * 60,
  },
  CP: {
    code: 'CP',
    displayName: 'Control Points',
    teams: true,
    blurb: 'Hold the glowing platforms. Captured points accrue score continuously.',
    limit: {
      unit: 'points',
      label: 'Score limit',
      hint: 'Team score, accruing continuously from every platform you hold.',
      value: 600,
      max: 3000,
      step: 100,
    },
    timeLimit: 15 * 60,
  },
  RAID: {
    code: 'RAID',
    displayName: 'Boss Raid',
    teams: true,
    blurb:
      'You and a squad against one enormous, genuinely clever tank that almost kills a light hull with a single shell, brings the map down on you and goes berserk on the way out. Reinforcements are unlimited; the clock is not.',
    // A raid ends when the Overseer falls or the clock does. Nobody is ever out
    // of lives, so there is nothing to race to but the health bar — and with a
    // boss this hard the clock is the loss condition, so it is a generous one.
    limit: null,
    timeLimit: 15 * 60,
  },
};

export const MODE_CODES: ModeCode[] = ['DM', 'TDM', 'CTF', 'CP', 'RAID'];

export interface BattleSettings {
  mode: ModeCode;
  mapId: string;
  botCount: number;
  difficulty: string;
  timeLimit: number;
  /**
   * Win condition per mode, in that mode's own unit, or null for "clock only".
   * Kept per mode rather than as one shared number because 30 is a long
   * Deathmatch and a three-minute Team Deathmatch — the same field serving both
   * is what made TDM end before anyone had left their spawn.
   */
  limits: Record<ModeCode, number | null>;
  friendlyFire: boolean;
  suppliesEnabled: boolean;
  goldBoxEnabled: boolean;
}

/** The default race-to-a-number for every mode, straight from `MODES`. */
export function defaultLimits(): Record<ModeCode, number | null> {
  const out = {} as Record<ModeCode, number | null>;
  for (const code of MODE_CODES) out[code] = MODES[code].limit?.value ?? null;
  return out;
}

/** The active mode's win condition, or null when only the clock ends it. */
export function modeLimit(settings: BattleSettings): number | null {
  const limit = settings.limits?.[settings.mode];
  return limit != null && limit > 0 ? limit : null;
}

export const DEFAULT_SETTINGS: BattleSettings = {
  mode: 'DM',
  mapId: 'sandbox',
  botCount: 9,
  difficulty: 'standard',
  timeLimit: 8 * 60,
  limits: defaultLimits(),
  friendlyFire: false,
  suppliesEnabled: true,
  goldBoxEnabled: true,
};

/**
 * CTF scoring from the wiki, where X is the number of players in the battle.
 * Pickup and transfer only pay out if the flag is eventually delivered, so the
 * caller banks them and settles on capture.
 */
export function flagPoints(playerCount: number): {
  pickup: number;
  transfer: number;
  delivery: number;
} {
  const base = 10 * playerCount;
  return { pickup: base * 0.2, transfer: base * 0.3, delivery: base * 0.5 };
}
