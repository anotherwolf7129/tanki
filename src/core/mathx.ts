export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Shortest signed angular difference from `a` to `b`, in radians. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Frame-rate independent exponential smoothing factor. */
export function damp(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

export function randRange(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}

export function pick<T>(arr: readonly T[]): T {
  return arr[(Math.random() * arr.length) | 0];
}

export function shuffled<T>(arr: readonly T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Intercept point for a projectile of finite speed against a moving target.
 * Falls back to the target's current position when no solution exists (target
 * outrunning the shell), which is the right behaviour for a bot: it just misses.
 */
export function predictIntercept(
  shooter: { x: number; y: number; z: number },
  target: { x: number; y: number; z: number },
  vel: { x: number; y: number; z: number },
  speed: number,
): { x: number; y: number; z: number } {
  if (!isFinite(speed) || speed <= 0) return { ...target };
  const rx = target.x - shooter.x;
  const ry = target.y - shooter.y;
  const rz = target.z - shooter.z;
  const a = vel.x * vel.x + vel.y * vel.y + vel.z * vel.z - speed * speed;
  const b = 2 * (rx * vel.x + ry * vel.y + rz * vel.z);
  const c = rx * rx + ry * ry + rz * rz;

  let t: number;
  if (Math.abs(a) < 1e-4) {
    if (Math.abs(b) < 1e-6) return { ...target };
    t = -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return { ...target };
    const sq = Math.sqrt(disc);
    const t1 = (-b - sq) / (2 * a);
    const t2 = (-b + sq) / (2 * a);
    const valid = [t1, t2].filter((x) => x > 0);
    if (!valid.length) return { ...target };
    t = Math.min(...valid);
  }
  if (!isFinite(t) || t < 0 || t > 6) return { ...target };
  return { x: target.x + vel.x * t, y: target.y + vel.y * t, z: target.z + vel.z * t };
}

/**
 * Launch elevation for a ballistic shell that must land on `target`.
 * Returns null when the target is out of range for the given speed.
 */
export function ballisticPitch(
  horizontal: number,
  height: number,
  speed: number,
  gravity: number,
): number | null {
  const s2 = speed * speed;
  const disc = s2 * s2 - gravity * (gravity * horizontal * horizontal + 2 * height * s2);
  if (disc < 0) return null;
  // Low arc — keeps time-of-flight down, which is what a gunner wants.
  return Math.atan2(s2 - Math.sqrt(disc), gravity * horizontal);
}
