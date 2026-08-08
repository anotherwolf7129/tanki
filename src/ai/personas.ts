export type PersonaId = 'rusher' | 'sniper' | 'support' | 'bruiser' | 'flanker' | 'objective';

export interface Persona {
  id: PersonaId;
  displayName: string;
  hull: string;
  turret: string;
  /** 0 = never closes, 1 = always charges. */
  aggression: number;
  /** Multiplier on the persona's aim error; a sniper is sharper than a rusher. */
  aimSkill: number;
  /** Multiplier on reaction delay; higher means slower to notice. */
  reactionScale: number;
  /** Fraction of the preferred band the bot tries to hold. */
  standoff: number;
  usesCover: boolean;
  /** Chance per engagement tick of repositioning after firing. */
  repositionChance: number;
  /** How strongly the bot weights mode objectives over kills. */
  objectiveBias: number;
  /** Prefers wide approach routes rather than the direct line. */
  flanks: boolean;
  healsAllies: boolean;
  retreatHealth: number;
}

/**
 * Loadout-driven behaviour, not a single skill slider. A roster of eight
 * identical bots reads as fake inside thirty seconds; mixing these does not.
 */
export const PERSONAS: Record<PersonaId, Persona> = {
  rusher: {
    id: 'rusher',
    displayName: 'Rusher',
    hull: 'wasp',
    turret: 'firebird',
    aggression: 1,
    aimSkill: 1.5,
    reactionScale: 0.9,
    standoff: 0.25,
    usesCover: false,
    repositionChance: 0.05,
    objectiveBias: 0.3,
    flanks: false,
    healsAllies: false,
    retreatHealth: 0.12,
  },
  sniper: {
    id: 'sniper',
    displayName: 'Sniper',
    hull: 'mammoth',
    turret: 'shaft',
    aggression: 0.15,
    aimSkill: 0.55,
    // Very slow to react to flankers — the classic sniper failure mode.
    reactionScale: 1.8,
    standoff: 1.0,
    usesCover: true,
    repositionChance: 0.5,
    objectiveBias: 0.2,
    flanks: false,
    healsAllies: false,
    retreatHealth: 0.35,
  },
  support: {
    id: 'support',
    displayName: 'Support',
    hull: 'hunter',
    turret: 'isida',
    aggression: 0.35,
    aimSkill: 1.1,
    reactionScale: 1.1,
    standoff: 0.5,
    usesCover: true,
    repositionChance: 0.25,
    objectiveBias: 0.5,
    flanks: false,
    healsAllies: true,
    retreatHealth: 0.45,
  },
  bruiser: {
    id: 'bruiser',
    displayName: 'Bruiser',
    hull: 'titan',
    turret: 'vulcan',
    aggression: 0.5,
    aimSkill: 1.0,
    reactionScale: 1.0,
    standoff: 0.7,
    usesCover: true,
    // Holds chokepoints; poor at chasing.
    repositionChance: 0.1,
    objectiveBias: 0.7,
    flanks: false,
    healsAllies: false,
    retreatHealth: 0.2,
  },
  flanker: {
    id: 'flanker',
    displayName: 'Flanker',
    hull: 'hornet',
    turret: 'ricochet',
    aggression: 0.75,
    aimSkill: 0.9,
    reactionScale: 0.95,
    standoff: 0.55,
    usesCover: true,
    repositionChance: 0.45,
    objectiveBias: 0.4,
    flanks: true,
    healsAllies: false,
    retreatHealth: 0.3,
  },
  objective: {
    id: 'objective',
    displayName: 'Objective',
    hull: 'viking',
    turret: 'twins',
    aggression: 0.55,
    aimSkill: 1.05,
    reactionScale: 1.0,
    standoff: 0.6,
    usesCover: true,
    repositionChance: 0.2,
    // Ignores kills and plays the mode.
    objectiveBias: 1,
    flanks: false,
    healsAllies: false,
    retreatHealth: 0.3,
  },
};

export const PERSONA_IDS = Object.keys(PERSONAS) as PersonaId[];

/** A believable mixed roster: never all one persona, always some variety. */
export function rosterFor(count: number): PersonaId[] {
  const weights: [PersonaId, number][] = [
    ['rusher', 0.22],
    ['flanker', 0.2],
    ['bruiser', 0.18],
    ['objective', 0.18],
    ['sniper', 0.12],
    ['support', 0.1],
  ];
  const out: PersonaId[] = [];
  for (const [id, w] of weights) {
    const n = Math.max(id === 'sniper' || id === 'support' ? 0 : 1, Math.round(count * w));
    for (let i = 0; i < n && out.length < count; i++) out.push(id);
  }
  while (out.length < count) out.push('objective');
  return out.slice(0, count);
}

/**
 * A raid squad, which wants different things from a deathmatch roster.
 *
 * The Overseer holds about forty metres, so every gun in the squad has to reach
 * that far — a Rusher's fifteen-metre flamethrower simply never gets to fire,
 * and a squadmate that spends the whole raid running at something it cannot
 * touch is worse than no squadmate at all. What is left is a body to hold its
 * attention first, then a healer, then reach.
 */
export function raidRosterFor(count: number): PersonaId[] {
  const order: PersonaId[] = ['bruiser', 'support', 'flanker', 'objective', 'sniper', 'bruiser'];
  const out: PersonaId[] = [];
  for (let i = 0; i < count; i++) out.push(order[i % order.length]);
  return out;
}

export const BOT_NAMES = [
  'Vosper', 'Kite', 'Ashgrove', 'Redline', 'Marrow', 'Quill', 'Halcyon', 'Brackish',
  'Ninefold', 'Tarn', 'Coldiron', 'Vellum', 'Sundown', 'Pike', 'Gantry', 'Loam',
  'Rooksby', 'Fenwick', 'Cinder', 'Thrale', 'Bellweather', 'Mox', 'Harrow', 'Slate',
  'Verger', 'Orrery', 'Culvert', 'Dray', 'Spindle', 'Wraithe', 'Kestrel', 'Bramble',
];
