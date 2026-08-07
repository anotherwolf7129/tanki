import type { MapDef } from '../schema';
import { box, mirrorX, perimeter, platform, ramp, repeat } from './kit';

const half = { x: 100, z: 75 };

const side = [
  // Terraced stands, three steps up to the outer wall.
  platform(84, 0, 20, 150, 3, 'concrete'),
  platform(92, 0, 12, 150, 6, 'concrete'),
  // Yaw 90 climbs toward +X, so these finish flush with the stand's near edge.
  ramp(67, -40, 12, 14, 3, 90, 'concrete'),
  ramp(67, 40, 12, 14, 3, 90, 'concrete'),
  // Goal mouth framing.
  box(66, -20, 3, 6, 26),
  box(66, 20, 3, 6, 26),
  ...repeat(2, (i) => box(40, -30 + i * 60, 6, 3.5, 14, { material: 'metal' })),
];

export const stadium: MapDef = {
  id: 'stadium',
  displayName: 'Stadium',
  size: 'medium',
  maxPlayers: 20,
  modes: ['DM', 'TDM', 'CTF', 'CP'],
  gravityScale: 1.0,
  theme: 'summer',
  bounds: half,
  spawns: {
    red: [
      { pos: [-58, 0, -25], yaw: 90 },
      { pos: [-58, 0, 0], yaw: 90 },
      { pos: [-58, 0, 25], yaw: 90 },
      { pos: [-60, 0, -50], yaw: 90 },
      { pos: [-60, 0, 50], yaw: 90 },
    ],
    blue: [
      { pos: [58, 0, -25], yaw: 270 },
      { pos: [58, 0, 0], yaw: 270 },
      { pos: [58, 0, 25], yaw: 270 },
      { pos: [60, 0, -50], yaw: 270 },
      { pos: [60, 0, 50], yaw: 270 },
    ],
    free: [
      { pos: [0, 0, 55], yaw: 180 },
      { pos: [0, 0, -55], yaw: 0 },
      { pos: [-40, 0, 55], yaw: 150 },
      { pos: [40, 0, -55], yaw: 330 },
      { pos: [-40, 0, -55], yaw: 30 },
      { pos: [40, 0, 55], yaw: 210 },
      { pos: [0, 0, 20], yaw: 180 },
      { pos: [0, 0, -20], yaw: 0 },
    ],
  },
  flags: { red: [-72, 0, 0], blue: [72, 0, 0] },
  controlPoints: [
    { id: 'A', pos: [0, 0, 0], radius: 12 },
    { id: 'B', pos: [-36, 0, 0], radius: 9 },
    { id: 'C', pos: [36, 0, 0], radius: 9 },
  ],
  supplyZones: [
    { pos: [0, 0, 45], types: ['repair', 'armor'] },
    { pos: [0, 0, -45], types: ['damage', 'nitro'] },
    { pos: [-50, 0, 0], types: ['repair', 'mine'] },
    { pos: [50, 0, 0], types: ['repair', 'mine'] },
  ],
  goldBoxZones: [
    [0, 0, 0],
    [0, 0, 50],
    [0, 0, -50],
  ],
  props: [
    ...perimeter(half.x, half.z, 20),
    // Centre circle cover: low, so the bowl keeps its open sightlines.
    box(-12, 0, 4, 2.5, 16, { material: 'metal' }),
    box(12, 0, 4, 2.5, 16, { material: 'metal' }),
    box(0, -34, 24, 3, 5),
    box(0, 34, 24, 3, 5),
    ...side,
    ...mirrorX(side),
  ],
};
