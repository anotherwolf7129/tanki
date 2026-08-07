import type { PropDef } from '../schema';

/**
 * Prop kit. The spec fixes one standard prop at 5 m, so every helper here works
 * in multiples of that grid and maps stay dimensionally coherent with the
 * weapon range tables.
 */
export const GRID = 5;

type Mat = PropDef['material'];

export function box(
  x: number,
  z: number,
  w: number,
  h: number,
  d: number,
  opts: { y?: number; rot?: number; material?: Mat } = {},
): PropDef {
  return {
    kind: 'box',
    pos: [x, (opts.y ?? 0) + h / 2, z],
    size: [w, h, d],
    rot: opts.rot ?? 0,
    material: opts.material ?? 'concrete',
  };
}

/** A raised deck you can drive onto via ramps. Top surface sits at `height`. */
export function platform(
  x: number,
  z: number,
  w: number,
  d: number,
  height: number,
  material: Mat = 'metal',
): PropDef {
  return { kind: 'platform', pos: [x, height / 2, z], size: [w, height, d], rot: 0, material };
}

/** Wedge climbing from ground to `height` along +Z after yaw rotation. */
export function ramp(
  x: number,
  z: number,
  w: number,
  d: number,
  height: number,
  rot = 0,
  material: Mat = 'concrete',
): PropDef {
  return { kind: 'ramp', pos: [x, height / 2, z], size: [w, height, d], rot, material };
}

export function cylinder(
  x: number,
  z: number,
  radius: number,
  h: number,
  material: Mat = 'concrete',
): PropDef {
  return { kind: 'cylinder', pos: [x, h / 2, z], size: [radius * 2, h, radius * 2], rot: 0, material };
}

/** Closed arena boundary. Height is generous so nothing escapes on a ramp launch. */
export function perimeter(halfX: number, halfZ: number, h = 12, t = 4): PropDef[] {
  return [
    box(0, -halfZ - t / 2, halfX * 2 + t * 2, h, t),
    box(0, halfZ + t / 2, halfX * 2 + t * 2, h, t),
    box(-halfX - t / 2, 0, t, h, halfZ * 2),
    box(halfX + t / 2, 0, t, h, halfZ * 2),
  ];
}

/** Mirror props across the X axis (x -> -x), for symmetric team maps. */
export function mirrorX(props: PropDef[]): PropDef[] {
  return props.map((p) => ({
    ...p,
    pos: [-p.pos[0], p.pos[1], p.pos[2]] as [number, number, number],
    rot: p.rot ? -p.rot : 0,
  }));
}

/** Mirror props across the Z axis (z -> -z). */
export function mirrorZ(props: PropDef[]): PropDef[] {
  return props.map((p) => ({
    ...p,
    pos: [p.pos[0], p.pos[1], -p.pos[2]] as [number, number, number],
    rot: p.rot ? 180 - p.rot : 180,
  }));
}

/** Evenly spaced clones of a prop factory along a line. */
export function repeat(count: number, fn: (i: number) => PropDef | PropDef[]): PropDef[] {
  const out: PropDef[] = [];
  for (let i = 0; i < count; i++) {
    const r = fn(i);
    if (Array.isArray(r)) out.push(...r);
    else out.push(r);
  }
  return out;
}

/** A rectangular building shell with a doorway on each of two opposite faces. */
export function building(
  x: number,
  z: number,
  w: number,
  d: number,
  h: number,
  material: Mat = 'concrete',
): PropDef[] {
  const t = 1.2;
  const gap = 5;
  const sideW = (w - gap) / 2;
  return [
    box(x - (gap / 2 + sideW / 2), z - d / 2, sideW, h, t, { material }),
    box(x + (gap / 2 + sideW / 2), z - d / 2, sideW, h, t, { material }),
    box(x - (gap / 2 + sideW / 2), z + d / 2, sideW, h, t, { material }),
    box(x + (gap / 2 + sideW / 2), z + d / 2, sideW, h, t, { material }),
    box(x - w / 2, z, t, h, d, { material }),
    box(x + w / 2, z, t, h, d, { material }),
  ];
}
