import type { MapDef } from '../schema';
import { box, mirrorZ, perimeter, platform, ramp } from './kit';

const half = { x: 110, z: 110 };

// The bank platform occupies z -80..-40 and stands 10 m over the canyon floor.
// Everything on top of it has to stay inside that strip, and everything that
// climbs it has to finish flush with its edge.
const BANK_NEAR = -40;
const BANK_FAR = -80;

const bank = [
  platform(0, (BANK_NEAR + BANK_FAR) / 2, 200, BANK_NEAR - BANK_FAR, 10, 'sand'),
  // 22 m of run for the 10 m climb: gentle enough for a heavy hull and inside
  // the navgrid's per-cell step limit. The high edge lands exactly on the rim.
  ramp(-70, BANK_NEAR + 11, 20, 22, 10, 180, 'sand'),
  ramp(70, BANK_NEAR + 11, 20, 22, 10, 180, 'sand'),
  // Parapet along the rim, clear of both ramp mouths and the bridge mouth.
  box(-45, BANK_NEAR - 2, 30, 2.5, 2, { y: 10, material: 'metal' }),
  box(45, BANK_NEAR - 2, 30, 2.5, 2, { y: 10, material: 'metal' }),
  // Cover on top of the bank.
  box(-40, -70, 12, 4, 12, { y: 10 }),
  box(40, -70, 12, 4, 12, { y: 10 }),
  box(0, -76, 20, 5, 8, { y: 10 }),
];

export const kungur: MapDef = {
  id: 'kungur',
  displayName: 'Kungur',
  size: 'medium',
  maxPlayers: 24,
  modes: ['DM', 'TDM', 'CTF', 'CP', 'RAID'],
  gravityScale: 1.0,
  theme: 'summer',
  bounds: half,
  spawns: {
    red: [
      { pos: [-40, 10, -62], yaw: 180 },
      { pos: [0, 10, -66], yaw: 180 },
      { pos: [40, 10, -62], yaw: 180 },
      { pos: [-70, 10, -55], yaw: 180 },
      { pos: [70, 10, -55], yaw: 180 },
    ],
    blue: [
      { pos: [-40, 10, 62], yaw: 0 },
      { pos: [0, 10, 66], yaw: 0 },
      { pos: [40, 10, 62], yaw: 0 },
      { pos: [-70, 10, 55], yaw: 0 },
      { pos: [70, 10, 55], yaw: 0 },
    ],
    free: [
      { pos: [-90, 0, 0], yaw: 90 },
      { pos: [90, 0, 0], yaw: 270 },
      { pos: [0, 10, 0], yaw: 0 },
      { pos: [-40, 10, -62], yaw: 180 },
      { pos: [40, 10, 62], yaw: 0 },
      { pos: [-60, 0, 20], yaw: 90 },
      { pos: [60, 0, -20], yaw: 270 },
      { pos: [0, 10, 30], yaw: 180 },
    ],
  },
  flags: { red: [0, 10, -68], blue: [0, 10, 68] },
  controlPoints: [
    { id: 'A', pos: [0, 10, 0], radius: 11 },
    { id: 'B', pos: [-72, 0, 0], radius: 9 },
    { id: 'C', pos: [72, 0, 0], radius: 9 },
  ],
  supplyZones: [
    { pos: [0, 10, 0], types: ['repair', 'armor', 'damage'] },
    { pos: [-80, 0, -20], types: ['nitro', 'mine'] },
    { pos: [80, 0, 20], types: ['nitro', 'mine'] },
    { pos: [0, 10, -58], types: ['repair'] },
    { pos: [0, 10, 58], types: ['repair'] },
  ],
  goldBoxZones: [
    [0, 10, 0],
    [-80, 0, 0],
    [80, 0, 0],
  ],
  props: [
    ...perimeter(half.x, half.z, 20),
    // The bridge: the map's whole point is the height advantage it grants.
    // Its deck top sits at 10 m, flush with both banks, so tanks drive straight on.
    box(0, 0, 22, 1, 84, { y: 9, material: 'metal' }),
    box(-11, 0, 1, 3, 84, { y: 10, material: 'metal' }),
    box(11, 0, 1, 3, 84, { y: 10, material: 'metal' }),
    // Canyon floor cover, under the bridge and around it.
    box(-30, 0, 10, 5, 10),
    box(30, 0, 10, 5, 10),
    box(0, -26, 14, 4, 8),
    box(0, 26, 14, 4, 8),
    ...bank,
    ...mirrorZ(bank),
  ],
};
