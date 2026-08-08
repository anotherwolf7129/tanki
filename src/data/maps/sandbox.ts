import type { MapDef } from '../schema';
import { box, mirrorX, perimeter, platform, ramp, repeat } from './kit';

const half = { x: 100, z: 100 };

// Right-hand side of the arena; mirrored to build the left.
const side = [
  box(45, 0, 10, 4, 24),
  box(30, -40, 16, 3, 6),
  box(30, 40, 16, 3, 6),
  box(68, -22, 6, 5, 6),
  box(68, 22, 6, 5, 6),
  ...repeat(3, (i) => box(55, -30 + i * 30, 4, 2.5, 4, { material: 'sand' })),
];

export const sandbox: MapDef = {
  id: 'sandbox',
  displayName: 'Sandbox',
  size: 'small',
  maxPlayers: 8,
  modes: ['DM', 'TDM', 'CTF', 'CP', 'RAID'],
  gravityScale: 1.0,
  theme: 'summer',
  bounds: half,
  spawns: {
    red: [
      { pos: [-82, 0, -18], yaw: 90 },
      { pos: [-82, 0, 0], yaw: 90 },
      { pos: [-82, 0, 18], yaw: 90 },
      { pos: [-70, 0, -34], yaw: 90 },
    ],
    blue: [
      { pos: [82, 0, -18], yaw: 270 },
      { pos: [82, 0, 0], yaw: 270 },
      { pos: [82, 0, 18], yaw: 270 },
      { pos: [70, 0, 34], yaw: 270 },
    ],
    free: [
      { pos: [0, 0, 70], yaw: 180 },
      { pos: [0, 0, -70], yaw: 0 },
      { pos: [70, 0, 70], yaw: 225 },
      { pos: [-70, 0, -70], yaw: 45 },
      { pos: [-70, 0, 70], yaw: 135 },
      { pos: [70, 0, -70], yaw: 315 },
      { pos: [0, 5, 0], yaw: 0 },
      { pos: [40, 0, 0], yaw: 270 },
    ],
  },
  flags: { red: [-88, 0, 0], blue: [88, 0, 0] },
  controlPoints: [{ id: 'A', pos: [0, 5, 0], radius: 9 }],
  supplyZones: [
    { pos: [0, 0, 34], types: ['repair', 'armor'] },
    { pos: [0, 0, -34], types: ['damage', 'nitro'] },
    { pos: [-40, 0, 60], types: ['mine', 'repair'] },
    { pos: [40, 0, -60], types: ['mine', 'repair'] },
  ],
  goldBoxZones: [
    [0, 0, 0],
    [0, 0, 55],
    [0, 0, -55],
  ],
  props: [
    ...perimeter(half.x, half.z),
    // Central hill with ramps on all four approaches.
    platform(0, 0, 26, 26, 5, 'sand'),
    ramp(0, -19, 12, 12, 5, 0, 'sand'),
    ramp(0, 19, 12, 12, 5, 180, 'sand'),
    ramp(-19, 0, 12, 12, 5, 90, 'sand'),
    ramp(19, 0, 12, 12, 5, 270, 'sand'),
    ...side,
    ...mirrorX(side),
  ],
};
