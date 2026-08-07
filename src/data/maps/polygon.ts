import type { MapDef } from '../schema';
import { box, cylinder, mirrorX, mirrorZ, perimeter, platform, ramp } from './kit';

const half = { x: 70, z: 70 };

const quadrant = [
  cylinder(34, 34, 6, 6, 'metal'),
  box(20, 46, 22, 4, 4, { material: 'hazard' }),
  box(46, 20, 4, 4, 22, { material: 'hazard' }),
  box(56, 56, 8, 7, 8),
];

export const polygon: MapDef = {
  id: 'polygon',
  displayName: 'Polygon',
  size: 'small',
  maxPlayers: 16,
  modes: ['DM', 'TDM', 'CP'],
  gravityScale: 1.0,
  theme: 'urban',
  bounds: half,
  spawns: {
    red: [
      { pos: [-58, 0, -20], yaw: 90 },
      { pos: [-58, 0, 0], yaw: 90 },
      { pos: [-58, 0, 20], yaw: 90 },
    ],
    blue: [
      { pos: [58, 0, -20], yaw: 270 },
      { pos: [58, 0, 0], yaw: 270 },
      { pos: [58, 0, 20], yaw: 270 },
    ],
    free: [
      { pos: [0, 0, 58], yaw: 180 },
      { pos: [0, 0, -58], yaw: 0 },
      { pos: [60, 0, 40], yaw: 200 },
      { pos: [-60, 0, -40], yaw: 20 },
      { pos: [-60, 0, 40], yaw: 160 },
      { pos: [60, 0, -40], yaw: 340 },
      { pos: [0, 0, 24], yaw: 180 },
      { pos: [0, 0, -24], yaw: 0 },
    ],
  },
  controlPoints: [
    { id: 'A', pos: [0, 4, 0], radius: 10 },
    { id: 'B', pos: [-46, 0, 46], radius: 8 },
    { id: 'C', pos: [46, 0, -46], radius: 8 },
  ],
  supplyZones: [
    { pos: [0, 0, 30], types: ['repair', 'damage'] },
    { pos: [0, 0, -30], types: ['armor', 'nitro'] },
    { pos: [-30, 0, 0], types: ['mine'] },
    { pos: [30, 0, 0], types: ['mine'] },
  ],
  goldBoxZones: [
    [0, 0, 0],
    [-46, 0, -46],
    [46, 0, 46],
  ],
  props: [
    ...perimeter(half.x, half.z, 14),
    // Raised centre — the whole map funnels here, which is the point.
    platform(0, 0, 18, 18, 4, 'metal'),
    ramp(0, -14, 10, 10, 4, 0, 'metal'),
    ramp(0, 14, 10, 10, 4, 180, 'metal'),
    ramp(-14, 0, 10, 10, 4, 90, 'metal'),
    ramp(14, 0, 10, 10, 4, 270, 'metal'),
    ...quadrant,
    ...mirrorX(quadrant),
    ...mirrorZ(quadrant),
    ...mirrorZ(mirrorX(quadrant)),
  ],
};
