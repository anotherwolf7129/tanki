export type PersonaId = 'rusher' | 'sniper' | 'support' | 'bruiser' | 'flanker' | 'objective' | 'medic';

export interface Persona {
  id: PersonaId;
  displayName: string;
  hull: string;
  turret: string;
  /**
   * The augments this persona fits, when the difficulty lets bots have them.
   * Chosen to double down on what the persona already does rather than to patch
   * its weakness — a Rusher that burns longer is more of a Rusher, and reading
   * the fight off the way an enemy behaves is the whole point of having these.
   */
  hullAugment?: string;
  turretAugment?: string;
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
  /**
   * How readily the bot breaks off what it is doing to put the beam on an ally,
   * as the health fraction a squadmate has to fall below before it is worth
   * healing. Zero means it never diverts — which is what every gun that cannot
   * heal in the first place gets, regardless of what this says.
   *
   * The threshold is the whole difference between a support that tops people up
   * between fights and a medic that treats healing as the job: at 0.98 there is
   * nearly always somebody worth beaming, so the medic is nearly always healing.
   */
  healThreshold: number;
  /** Sticks to the player rather than fighting its own war. */
  escortsPlayer: boolean;
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
    hullAugment: 'wasp.adrenaline',
    turretAugment: 'firebird.slow_burn',
    aggression: 1,
    aimSkill: 1.5,
    reactionScale: 0.9,
    standoff: 0.25,
    usesCover: false,
    repositionChance: 0.05,
    objectiveBias: 0.3,
    flanks: false,
    healsAllies: false,
    healThreshold: 0,
    escortsPlayer: false,
    retreatHealth: 0.12,
  },
  sniper: {
    id: 'sniper',
    displayName: 'Sniper',
    hull: 'mammoth',
    turret: 'shaft',
    hullAugment: 'mammoth.spall_liner',
    turretAugment: 'shaft.match_ammo',
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
    healThreshold: 0,
    escortsPlayer: false,
    retreatHealth: 0.35,
  },
  support: {
    id: 'support',
    displayName: 'Support',
    hull: 'hunter',
    turret: 'isida',
    hullAugment: 'hunter.field_repair',
    // Long Lead rather than Field Medic, so the squad's two Isidas are not the
    // same tank twice: the Support keeps the beam on people from further out,
    // the Medic below heals harder from closer in.
    turretAugment: 'isida.long_lead',
    aggression: 0.35,
    aimSkill: 1.1,
    reactionScale: 1.1,
    standoff: 0.5,
    usesCover: true,
    repositionChance: 0.25,
    objectiveBias: 0.5,
    flanks: false,
    healsAllies: true,
    // Tops squadmates up whenever they are meaningfully hurt, but still fights
    // its own fight — the Medic below is the one that treats this as the job.
    healThreshold: 0.85,
    escortsPlayer: false,
    retreatHealth: 0.45,
  },
  bruiser: {
    id: 'bruiser',
    displayName: 'Bruiser',
    hull: 'titan',
    turret: 'vulcan',
    // The augment the player is most likely to meet: a Titan that can afford to
    // sit overheated, behind a Vulcan that sets you alight while it is.
    hullAugment: 'titan.thermal_sink',
    turretAugment: 'vulcan.ignition',
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
    healThreshold: 0,
    escortsPlayer: false,
    retreatHealth: 0.2,
  },
  flanker: {
    id: 'flanker',
    displayName: 'Flanker',
    hull: 'hornet',
    turret: 'ricochet',
    hullAugment: 'hornet.kill_rush',
    turretAugment: 'ricochet.rebound',
    aggression: 0.75,
    aimSkill: 0.9,
    reactionScale: 0.95,
    standoff: 0.55,
    usesCover: true,
    repositionChance: 0.45,
    objectiveBias: 0.4,
    flanks: true,
    healsAllies: false,
    healThreshold: 0,
    escortsPlayer: false,
    retreatHealth: 0.3,
  },
  objective: {
    id: 'objective',
    displayName: 'Objective',
    hull: 'viking',
    turret: 'twins',
    hullAugment: 'viking.supply_chain',
    turretAugment: 'twins.tight_grouping',
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
    healThreshold: 0,
    escortsPlayer: false,
    retreatHealth: 0.3,
  },
  /**
   * The squad's dedicated healer, and the one persona whose job is somebody
   * else's health bar rather than its own.
   *
   * A Support with an Isida already heals, but it heals the way a bot with a
   * gun heals — between its own engagements, at whoever happens to be in front
   * of it. That is not what a raid needs. This one escorts the player, holds
   * inside beam range of them, and treats every scratch as worth topping up,
   * because a healer that only shows up below half health is a healer the
   * player never notices existing.
   *
   * Its aggression and objective bias are deliberately near the floor: it
   * shoots when it has nobody to heal, not the other way round.
   */
  medic: {
    id: 'medic',
    displayName: 'Medic',
    hull: 'hunter',
    turret: 'isida',
    hullAugment: 'hunter.field_repair',
    turretAugment: 'isida.field_medic',
    aggression: 0.2,
    aimSkill: 1.2,
    reactionScale: 1.05,
    standoff: 0.45,
    usesCover: true,
    repositionChance: 0.15,
    // Plays only the objectives that override persona outright — carrying a
    // flag home, holding a contested point — and heals through everything else.
    objectiveBias: 0.15,
    flanks: false,
    healsAllies: true,
    healThreshold: 0.98,
    escortsPlayer: true,
    // Breaks off earlier than anything else on the field. A dead medic heals
    // nobody, and it is the one tank in the squad whose absence is felt by
    // every other tank in it.
    retreatHealth: 0.45,
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
 * The same roster with one slot given over to a Medic.
 *
 * Used for the player's own side in every team mode: a healer that heals
 * *enemies* is a mechanic the player only ever experiences as a health bar
 * refusing to go down, so the dedicated one is always on your team. It replaces
 * a slot rather than adding one, and it takes the Support's slot first, so a
 * side never fields two Isidas at four bots and the enemy roster is unchanged.
 */
export function rosterWithMedic(count: number): PersonaId[] {
  const out = rosterFor(count);
  if (!out.length) return out;
  if (out.includes('medic')) return out;
  const at = out.indexOf('support');
  out[at >= 0 ? at : out.length - 1] = 'medic';
  return out;
}

/**
 * A raid squad, which wants different things from a deathmatch roster.
 *
 * The Overseer holds about forty metres, so every gun in the squad has to reach
 * that far — a Rusher's fifteen-metre flamethrower simply never gets to fire,
 * and a squadmate that spends the whole raid running at something it cannot
 * touch is worse than no squadmate at all. What is left is a body to hold its
 * attention first, then a healer, then reach.
 *
 * The Medic is first in the order rather than second, because a raid with one
 * squadmate should still have the healer: the Overseer out-damages anything
 * else in the game, and the single mechanic that keeps a raid standing in front
 * of it is somebody holding a beam on whoever it is currently hitting.
 *
 * It is also the one slot the reach rule above does not apply to. An Isida
 * cannot touch something forty metres away and never tries to: its twenty
 * metres are measured to the *squadmate* it is healing, not to the boss. The
 * squad pays for it in damage — measured, a raid trades roughly a third of one
 * gun's output for it — and buys back a squad that is alive to use the rest.
 */
export function raidRosterFor(count: number): PersonaId[] {
  const order: PersonaId[] = ['medic', 'bruiser', 'flanker', 'support', 'objective', 'sniper', 'bruiser'];
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
