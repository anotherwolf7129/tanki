import turretsJson from './turrets.json';
import hullsJson from './hulls.json';
import type { HullDef, TurretDef } from './schema';

function withIds<T extends object>(raw: Record<string, unknown>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [id, def] of Object.entries(raw)) out[id] = { id, ...(def as object) } as T;
  return out;
}

export const TURRETS = withIds<TurretDef>(turretsJson as Record<string, unknown>);
export const HULLS = withIds<HullDef>(hullsJson as Record<string, unknown>);

export const TURRET_IDS = Object.keys(TURRETS);
export const HULL_IDS = Object.keys(HULLS).filter((id) => HULLS[id].purchasable !== false);

export function turret(id: string): TurretDef {
  const t = TURRETS[id];
  if (!t) throw new Error(`unknown turret: ${id}`);
  return t;
}

export function hull(id: string): HullDef {
  const h = HULLS[id];
  if (!h) throw new Error(`unknown hull: ${id}`);
  return h;
}

/**
 * Preferred engagement band for a turret, in metres. Bots use this to decide
 * how close to close. Derived from the range table rather than hand-authored so
 * new turrets pick up sensible behaviour for free.
 */
export function preferredRange(t: TurretDef): [number, number] {
  const cap = t.hardCap ?? t.rangeMinDamage;
  if (t.cone) return [3, t.cone.range * 0.75];
  if (t.beam) return [4, t.beam.range * 0.8];
  if (t.chain) return [3, t.chain.jumpRange];
  const near = Math.max(6, t.rangeMaxDamage * 0.25);
  const far = Math.min(cap * 0.9, t.rangeMaxDamage * 1.05);
  return [near, Math.max(near + 5, far)];
}
