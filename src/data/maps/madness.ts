import type { MapDef } from '../schema';
import { box, cylinder, mirrorX, mirrorZ, perimeter, platform, ramp, repeat } from './kit';

const half = { x: 120, z: 120 };

const quadrant = [
  platform(55, 55, 30, 30, 12, 'metal'),
  ramp(55, 27, 14, 26, 12, 0, 'metal'),
  cylinder(90, 40, 7, 22, 'metal'),
  cylinder(40, 90, 7, 22, 'metal'),
  box(20, 60, 6, 6, 30, { material: 'hazard' }),
  ...repeat(2, (i) => box(95, 90 + i * 14, 14, 5, 6, { material: 'metal' })),
];

/** Low gravity turns every ramp into a launch pad — that is the whole modifier. */
export const madness: MapDef = {
  id: 'madness',
  displayName: 'Madness',
  size: 'large',
  maxPlayers: 32,
  modes: ['DM', 'TDM'],
  gravityScale: 0.35,
  theme: 'space',
  bounds: half,
  spawns: {
    red: [
      { pos: [-104, 0, -40], yaw: 90 },
      { pos: [-104, 0, 0], yaw: 90 },
      { pos: [-104, 0, 40], yaw: 90 },
    ],
    blue: [
      { pos: [104, 0, -40], yaw: 270 },
      { pos: [104, 0, 0], yaw: 270 },
      { pos: [104, 0, 40], yaw: 270 },
    ],
    free: [
      { pos: [0, 0, 100], yaw: 180 },
      { pos: [0, 0, -100], yaw: 0 },
      { pos: [100, 0, 0], yaw: 270 },
      { pos: [-100, 0, 0], yaw: 90 },
      { pos: [55, 12, 55], yaw: 225 },
      { pos: [-55, 12, -55], yaw: 45 },
      { pos: [-55, 12, 55], yaw: 135 },
      { pos: [55, 12, -55], yaw: 315 },
    ],
  },
  supplyZones: [
    { pos: [0, 6, 0], types: ['repair', 'armor', 'damage', 'nitro'] },
    { pos: [0, 0, 70], types: ['mine', 'repair'] },
    { pos: [0, 0, -70], types: ['mine', 'repair'] },
    { pos: [70, 0, 0], types: ['damage'] },
    { pos: [-70, 0, 0], types: ['armor'] },
  ],
  goldBoxZones: [
    [0, 0, 0],
    [55, 12, 55],
    [-55, 12, -55],
  ],
  props: [
    ...perimeter(half.x, half.z, 40),
    platform(0, 0, 26, 26, 6, 'hazard'),
    ramp(0, -20, 14, 14, 6, 0, 'hazard'),
    ramp(0, 20, 14, 14, 6, 180, 'hazard'),
    ramp(-20, 0, 14, 14, 6, 90, 'hazard'),
    ramp(20, 0, 14, 14, 6, 270, 'hazard'),
    ...quadrant,
    ...mirrorX(quadrant),
    ...mirrorZ(quadrant),
    ...mirrorZ(mirrorX(quadrant)),
  ],
};
