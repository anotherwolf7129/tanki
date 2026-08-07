import type { SupplyKind } from './schema';

export interface SupplyDef {
  id: SupplyKind;
  key: number;
  displayName: string;
  colour: number;
  /** Buff duration in seconds, where applicable. */
  duration?: number;
  instantHeal?: number;
  healOverTime?: number;
  healDuration?: number;
  damage?: number;
  radius?: number;
  armTime?: number;
}

/**
 * The 2016-rebalance ruleset, picked as the single consistent set: 40 s
 * durations, 10 s cross-cooldown, +40 % nitro, tenfold mine and repair values.
 */
export const SUPPLIES: Record<SupplyKind, SupplyDef> = {
  repair: {
    id: 'repair',
    key: 1,
    displayName: 'Repair Kit',
    colour: 0x4ade80,
    instantHeal: 1000,
    healOverTime: 3000,
    healDuration: 3,
  },
  armor: { id: 'armor', key: 2, displayName: 'Double Armor', colour: 0x60a5fa, duration: 40 },
  damage: { id: 'damage', key: 3, displayName: 'Double Damage', colour: 0xf87171, duration: 40 },
  nitro: { id: 'nitro', key: 4, displayName: 'Speed Boost', colour: 0xfbbf24, duration: 40 },
  mine: {
    id: 'mine',
    key: 5,
    displayName: 'Mine',
    colour: 0xa78bfa,
    damage: 1800,
    radius: 8,
    armTime: 1.5,
  },
};

export const SUPPLY_ORDER: SupplyKind[] = ['repair', 'armor', 'damage', 'nitro', 'mine'];

/** Smart Cooldowns: using one supply briefly locks the others, not itself. */
export const CROSS_COOLDOWN = 10;
export const SELF_COOLDOWN = 20;
/** Mine and Repair Kit do not lock each other, per the rebalance. */
export const COOLDOWN_EXEMPT: [SupplyKind, SupplyKind][] = [['mine', 'repair']];

export function crossCooldownApplies(used: SupplyKind, other: SupplyKind): boolean {
  if (used === other) return false;
  return !COOLDOWN_EXEMPT.some(
    ([a, b]) => (a === used && b === other) || (b === used && a === other),
  );
}

export const GOLD_BOX_REWARD = 1000;
export const CRYSTAL_BOX_REWARD = 10;
export const SELF_DESTRUCT_TIME = 5;
