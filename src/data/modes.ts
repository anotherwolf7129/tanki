import type { ModeCode } from './schema';

export interface ModeDef {
  code: ModeCode;
  displayName: string;
  teams: boolean;
  blurb: string;
  /** Default win condition; overridable from the battle setup screen. */
  scoreLimit: number | null;
  killLimit: number | null;
  flagLimit: number | null;
  timeLimit: number;
}

export const MODES: Record<ModeCode, ModeDef> = {
  DM: {
    code: 'DM',
    displayName: 'Deathmatch',
    teams: false,
    blurb: 'No teams. Only the killer scores. Highest gold box frequency.',
    scoreLimit: null,
    killLimit: null,
    flagLimit: null,
    timeLimit: 15 * 60,
  },
  TDM: {
    code: 'TDM',
    displayName: 'Team Deathmatch',
    teams: true,
    blurb: 'Red against Blue. Most kills wins.',
    scoreLimit: null,
    killLimit: null,
    flagLimit: null,
    timeLimit: 15 * 60,
  },
  CTF: {
    code: 'CTF',
    displayName: 'Capture the Flag',
    teams: true,
    blurb: 'Take the enemy flag home. Your own flag must be on its platform to score.',
    scoreLimit: null,
    killLimit: null,
    flagLimit: null,
    timeLimit: 15 * 60,
  },
  CP: {
    code: 'CP',
    displayName: 'Control Points',
    teams: true,
    blurb: 'Hold the glowing platforms. Captured points accrue score continuously.',
    scoreLimit: null,
    killLimit: null,
    flagLimit: null,
    timeLimit: 15 * 60,
  },
  RAID: {
    code: 'RAID',
    displayName: 'Boss Raid',
    teams: true,
    blurb:
      'You and a squad against one enormous, genuinely clever tank. You out-damage your squadmates — which is exactly what pulls its attention onto you.',
    scoreLimit: null,
    killLimit: null,
    flagLimit: null,
    timeLimit: 12 * 60,
  },
};

export const MODE_CODES: ModeCode[] = ['DM', 'TDM', 'CTF', 'CP', 'RAID'];

export interface BattleSettings {
  mode: ModeCode;
  mapId: string;
  botCount: number;
  difficulty: string;
  timeLimit: number;
  killLimit: number | null;
  flagLimit: number | null;
  scoreLimit: number | null;
  friendlyFire: boolean;
  suppliesEnabled: boolean;
  goldBoxEnabled: boolean;
}

export const DEFAULT_SETTINGS: BattleSettings = {
  mode: 'DM',
  mapId: 'sandbox',
  botCount: 9,
  difficulty: 'standard',
  timeLimit: 8 * 60,
  killLimit: 30,
  flagLimit: 5,
  scoreLimit: 600,
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
