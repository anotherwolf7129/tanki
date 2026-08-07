import type { MapDef } from '../schema';
import { box, building, mirrorX, perimeter, platform, ramp, repeat } from './kit';

const half = { x: 130, z: 130 };

const block = (x: number, z: number, h: number) => building(x, z, 26, 26, h, 'concrete');

const side = [
  ...block(60, -70, 18),
  ...block(60, 0, 24),
  ...block(60, 70, 18),
  ...block(110, -35, 14),
  ...block(110, 35, 14),
  // Rooftop sniper deck reachable by an alley ramp.
  platform(85, 0, 18, 18, 9, 'metal'),
  ramp(85, -19, 12, 20, 9, 0, 'metal'),
  // Street furniture breaking the long corridor sightlines.
  ...repeat(4, (i) => box(30, -75 + i * 50, 4, 3, 8, { material: 'metal' })),
];

export const rio: MapDef = {
  id: 'rio',
  displayName: 'Rio',
  size: 'large',
  maxPlayers: 20,
  modes: ['DM', 'TDM', 'CTF', 'CP'],
  gravityScale: 1.0,
  theme: 'urban',
  bounds: half,
  spawns: {
    red: [
      { pos: [-120, 0, -60], yaw: 90 },
      { pos: [-120, 0, 0], yaw: 90 },
      { pos: [-120, 0, 60], yaw: 90 },
      { pos: [-108, 0, -100], yaw: 90 },
      { pos: [-108, 0, 100], yaw: 90 },
    ],
    blue: [
      { pos: [120, 0, -60], yaw: 270 },
      { pos: [120, 0, 0], yaw: 270 },
      { pos: [120, 0, 60], yaw: 270 },
      { pos: [108, 0, -100], yaw: 270 },
      { pos: [108, 0, 100], yaw: 270 },
    ],
    free: [
      { pos: [0, 0, 110], yaw: 180 },
      { pos: [0, 0, -110], yaw: 0 },
      { pos: [-95, 0, 110], yaw: 135 },
      { pos: [95, 0, -110], yaw: 315 },
      { pos: [0, 0, 35], yaw: 180 },
      { pos: [0, 0, -35], yaw: 0 },
      { pos: [-60, 0, -110], yaw: 45 },
      { pos: [60, 0, 110], yaw: 225 },
    ],
  },
  flags: { red: [-124, 0, 0], blue: [124, 0, 0] },
  controlPoints: [
    { id: 'A', pos: [0, 0, -60], radius: 10 },
    { id: 'B', pos: [0, 0, 0], radius: 10 },
    { id: 'C', pos: [0, 0, 60], radius: 10 },
  ],
  supplyZones: [
    { pos: [0, 0, 0], types: ['repair', 'armor', 'damage', 'nitro'] },
    { pos: [-85, 0, -100], types: ['repair', 'mine'] },
    { pos: [85, 0, 100], types: ['repair', 'mine'] },
    { pos: [0, 0, 100], types: ['damage'] },
    { pos: [0, 0, -100], types: ['armor'] },
  ],
  goldBoxZones: [
    [0, 0, 0],
    [-85, 0, 100],
    [85, 0, -100],
  ],
  props: [
    ...perimeter(half.x, half.z, 30),
    // Central plaza with a low fountain wall.
    box(-10, 0, 3, 3, 20),
    box(10, 0, 3, 3, 20),
    ...side,
    ...mirrorX(side),
  ],
};
