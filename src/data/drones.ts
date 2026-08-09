/**
 * Drones — one optional escort, fitted in the garage next to the hull and the
 * turret.
 *
 * A drone is deliberately not a third augment. An augment modifies the item it
 * is bolted to and is authored per turret or per hull; a drone modifies
 * *supplies*, which belong to no item, so it lives in its own slot and its own
 * table. That keeps the read surface tiny: the whole system is two fields, and
 * the only place in the simulation that consults them is `Tank.applySupply`.
 *
 * Every drone is a trade in the same shape as an augment — what it gives back
 * has to cost something a player can feel, or the slot is just a free buff with
 * a menu in front of it.
 */
export interface DroneDef {
  id: string;
  displayName: string;
  blurb: string;
  /**
   * How many times over a supply's effect lands. The supplies are already
   * doublings, so 2 doubles the doubling: Double Damage becomes quadruple
   * damage, Double Armour becomes a quarter of the damage taken, and a Speed
   * Boost applies its +40 % twice. Durations are untouched — the kit hits
   * harder, it does not last longer.
   */
  supplyAmplify?: number;
  /**
   * Only one timed supply buff may run at a time. Double Armour, Double Damage
   * and Speed Boost lock each other out, and using one ends whichever of the
   * others was running. Repair Kit and Mine are not buffs and are unaffected.
   */
  exclusiveBuffs?: boolean;
}

export const DRONES: Record<string, DroneDef> = {
  overcharger: {
    id: 'overcharger',
    displayName: 'Overcharger',
    blurb:
      'Runs your supplies through its reactor, one at a time. Whatever you use lands twice over — quadruple damage, a quarter of the damage taken, twice the speed boost, twice the repair — but the reactor holds a single charge, so starting one buff ends whichever was already running. Repair Kit and Mine leave nothing running and never take the charge.',
    supplyAmplify: 2,
    exclusiveBuffs: true,
  },
};

export const DRONE_IDS: string[] = Object.keys(DRONES);

/**
 * Looks a drone up by id. An unknown id — a garage saved before a rename, or a
 * hand-edited loadout — comes back as "no drone" rather than throwing on the
 * way into a battle.
 */
export function droneFor(id: string | null | undefined): DroneDef | null {
  if (!id) return null;
  return DRONES[id] ?? null;
}
