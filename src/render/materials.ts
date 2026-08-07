import * as THREE from 'three';
import type { TeamId } from '../data/schema';

export const TEAM_COLOURS: Record<TeamId, number> = {
  red: 0xe0483c,
  blue: 0x3c7ce0,
  free: 0x9aa4b2,
};

export const PLAYER_COLOUR = 0x2ee6a8;

const cache = new Map<string, THREE.Material>();

function memo<T extends THREE.Material>(key: string, make: () => T): T {
  let m = cache.get(key) as T | undefined;
  if (!m) {
    m = make();
    cache.set(key, m);
  }
  return m;
}

export function propMaterial(kind: string | undefined): THREE.MeshStandardMaterial {
  const k = kind ?? 'concrete';
  return memo(`prop:${k}`, () => {
    switch (k) {
      case 'metal':
        return new THREE.MeshStandardMaterial({ color: 0x6f7885, roughness: 0.42, metalness: 0.75 });
      case 'sand':
        return new THREE.MeshStandardMaterial({ color: 0xc2a878, roughness: 0.95, metalness: 0.02 });
      case 'glass':
        return new THREE.MeshStandardMaterial({
          color: 0x86c5e6,
          roughness: 0.1,
          metalness: 0.1,
          transparent: true,
          opacity: 0.35,
        });
      case 'hazard':
        return new THREE.MeshStandardMaterial({ color: 0xd9a441, roughness: 0.6, metalness: 0.3 });
      default:
        return new THREE.MeshStandardMaterial({ color: 0x8b8f96, roughness: 0.85, metalness: 0.05 });
    }
  });
}

export function groundMaterial(theme: string): THREE.MeshStandardMaterial {
  return memo(`ground:${theme}`, () => {
    const colour =
      theme === 'winter' ? 0xdfe7ef : theme === 'urban' ? 0x4a4f57 : theme === 'space' ? 0x2b2f45 : 0x6f7c4f;
    return new THREE.MeshStandardMaterial({ color: colour, roughness: 0.98, metalness: 0.0 });
  });
}

export function skyColour(theme: string): number {
  switch (theme) {
    case 'winter':
      return 0xc7d6e5;
    case 'urban':
      return 0x8fa3b8;
    case 'space':
      return 0x0a0b16;
    default:
      return 0x8fb6d8;
  }
}

export function hullMaterial(team: TeamId, isPlayer: boolean): THREE.MeshStandardMaterial {
  const key = `hull:${team}:${isPlayer}`;
  return memo(key, () => {
    const base = isPlayer ? PLAYER_COLOUR : TEAM_COLOURS[team];
    return new THREE.MeshStandardMaterial({ color: base, roughness: 0.55, metalness: 0.45 });
  });
}

export const trackMaterial = () =>
  memo('track', () => new THREE.MeshStandardMaterial({ color: 0x24262b, roughness: 0.9, metalness: 0.1 }));

export const turretMaterial = (team: TeamId, isPlayer: boolean) =>
  memo(`turret:${team}:${isPlayer}`, () => {
    const base = isPlayer ? PLAYER_COLOUR : TEAM_COLOURS[team];
    const c = new THREE.Color(base).multiplyScalar(0.75);
    return new THREE.MeshStandardMaterial({ color: c, roughness: 0.45, metalness: 0.6 });
  });

export function disposeMaterialCache(): void {
  for (const m of cache.values()) m.dispose();
  cache.clear();
}
