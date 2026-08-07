import type { MapDef } from '../schema';
import { box, mirrorX, perimeter, platform, ramp, repeat } from './kit';

const half = { x: 140, z: 100 };

const side = [
  // Base wall with two exits.
  box(112, -42, 6, 7, 40),
  box(112, 42, 6, 7, 40),
  box(112, 0, 6, 7, 20),
  // Flanking hedgerows.
  ...repeat(4, (i) => box(70, -66 + i * 44, 5, 4, 22)),
  // Forward bunker overlooking mid.
  platform(48, 0, 20, 30, 6),
  ramp(48, -23, 12, 16, 6, 0),
  box(38, 0, 2, 3, 30, { y: 6, material: 'metal' }),
  // Scattered cover on the approach.
  box(88, -70, 10, 3.5, 10, { material: 'sand' }),
  box(88, 70, 10, 3.5, 10, { material: 'sand' }),
];

export const silence: MapDef = {
  id: 'silence',
  displayName: 'Silence',
  size: 'medium',
  maxPlayers: 20,
  modes: ['DM', 'TDM', 'CTF', 'CP'],
  gravityScale: 1.0,
  theme: 'summer',
  bounds: half,
  spawns: {
    red: [
      { pos: [-126, 0, -30], yaw: 90 },
      { pos: [-126, 0, 0], yaw: 90 },
      { pos: [-126, 0, 30], yaw: 90 },
      { pos: [-118, 0, -58], yaw: 90 },
      { pos: [-118, 0, 58], yaw: 90 },
    ],
    blue: [
      { pos: [126, 0, -30], yaw: 270 },
      { pos: [126, 0, 0], yaw: 270 },
      { pos: [126, 0, 30], yaw: 270 },
      { pos: [118, 0, -58], yaw: 270 },
      { pos: [118, 0, 58], yaw: 270 },
    ],
    free: [
      { pos: [0, 0, 80], yaw: 180 },
      { pos: [0, 0, -80], yaw: 0 },
      { pos: [-90, 0, 80], yaw: 135 },
      { pos: [90, 0, -80], yaw: 315 },
      { pos: [-60, 0, -80], yaw: 45 },
      { pos: [60, 0, 80], yaw: 225 },
      { pos: [0, 4, 0], yaw: 0 },
      { pos: [-40, 0, 40], yaw: 270 },
    ],
  },
  flags: { red: [-130, 0, 0], blue: [130, 0, 0] },
  controlPoints: [
    { id: 'A', pos: [0, 0, -55], radius: 10 },
    { id: 'B', pos: [0, 4, 0], radius: 10 },
    { id: 'C', pos: [0, 0, 55], radius: 10 },
  ],
  supplyZones: [
    { pos: [0, 0, 40], types: ['repair', 'damage'] },
    { pos: [0, 0, -40], types: ['armor', 'nitro'] },
    { pos: [-70, 0, 0], types: ['repair', 'mine'] },
    { pos: [70, 0, 0], types: ['repair', 'mine'] },
  ],
  goldBoxZones: [
    [0, 0, 0],
    [0, 0, 70],
    [0, 0, -70],
  ],
  props: [
    ...perimeter(half.x, half.z),
    // Centre island, contested from four sides.
    platform(0, 0, 24, 24, 4),
    ramp(0, -18, 14, 12, 4, 0),
    ramp(0, 18, 14, 12, 4, 180),
    box(0, -60, 30, 5, 6),
    box(0, 60, 30, 5, 6),
    ...side,
    ...mirrorX(side),
  ],
};
