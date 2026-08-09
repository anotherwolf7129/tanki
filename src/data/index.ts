import turretsJson from './turrets.json';
import hullsJson from './hulls.json';
import { DEG } from '../core/mathx';
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

const DEFAULT_PITCH_UP = 30;
const DEFAULT_PITCH_DOWN = 18;

/**
 * Elevation envelope for a turret as `[min, max]` radians. This is the single
 * source of truth for how far a barrel can be tilted — auto-aim, the bots and
 * the turret controller all clamp against it.
 */
export function pitchLimits(t: TurretDef): [number, number] {
  const up = (t.pitchUpDeg ?? DEFAULT_PITCH_UP) * DEG;
  const down = (t.pitchDownDeg ?? DEFAULT_PITCH_DOWN) * DEG;
  return [-down, up];
}

/**
 * Distance from the turret ring to the muzzle, in metres.
 *
 * Both the renderer and the simulation read this: the barrel is modelled to
 * exactly this length, and shots, muzzle flashes and line-of-sight probes all
 * start from its tip. Keeping one number means a Railgun's tracer leaves the
 * end of a Railgun barrel rather than somewhere inside it.
 */
export function barrelReach(h: HullDef, t: TurretDef): number {
  const base = h.size[2] * 0.55 + 1.2;
  switch (t.class) {
    case 'short-range':
      return base * 0.8;
    case 'medium-range':
      return base;
    default:
      return base * 1.2;
  }
}

/**
 * Sustained output for the turrets that fire in ticks rather than shots, in
 * damage per second, or `null` for a turret whose card should quote per-shot
 * damage instead.
 *
 * A cone, a beam and an arc all deal their `damage` ten times a second, so the
 * raw figure is a tenth of what the gun actually does and reads next to a
 * Magnum's 400 as if the thing were broken. Fuel is folded in as well: uptime
 * settles at `recharge / (drain + recharge)` regardless of how the trigger is
 * used, so the number is what the turret sustains, not what it peaks at.
 */
export function tickDamagePerSecond(t: TurretDef): number | null {
  const rate = t.cone?.tickRate ?? t.beam?.tickRate ?? t.chain?.tickRate;
  if (rate == null) return null;
  const uptime = t.fuel ? t.fuel.rechargePerSec / (t.fuel.drainPerSec + t.fuel.rechargePerSec) : 1;
  return t.damage * rate * uptime;
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
