import * as THREE from 'three';
import type { TeamId } from '../data/schema';
import { armourTexture, chevronTexture, disposeTextureCache, groundTexture, skyTexture, surfaceTexture, treadTexture } from './textures';

export const TEAM_COLOURS: Record<TeamId, number> = {
  red: 0xe0483c,
  blue: 0x3c7ce0,
  free: 0x9aa4b2,
};

export const PLAYER_COLOUR = 0x2ee6a8;

/**
 * A tank's livery. The player runs a hand-painted scheme with a bright accent
 * and gold trim; bots run flat team paint under disruptive camo. That contrast
 * is intentional — at a glance you should be able to find yourself in a scrum
 * of twelve tanks without reading the minimap.
 */
export interface PaintScheme {
  id: string;
  /** Hull paint tint. */
  hull: number;
  /** Turret paint tint, a shade off the hull so the two read as separate. */
  turret: number;
  /** Identification bands, chevrons and glowing trim. */
  accent: number;
  /** Bare metal fittings: grab handles, tow hooks, barrel collars. */
  trim: number;
  /** Disruptive camo on the paint sheet. */
  camo: boolean;
}

const PLAYER_SCHEME: PaintScheme = {
  id: 'player',
  hull: 0x1d6d5b,
  turret: 0x175748,
  accent: PLAYER_COLOUR,
  trim: 0xe8c877,
  camo: false,
};

const TEAM_SCHEMES: Record<TeamId, PaintScheme> = {
  red: { id: 'red', hull: 0xc04434, turret: 0xa1362a, accent: TEAM_COLOURS.red, trim: 0xc9ced6, camo: true },
  blue: { id: 'blue', hull: 0x3a6cb8, turret: 0x2e5a9d, accent: TEAM_COLOURS.blue, trim: 0xc9ced6, camo: true },
  free: { id: 'free', hull: 0x8b929e, turret: 0x757c88, accent: TEAM_COLOURS.free, trim: 0xc9ced6, camo: true },
};

export function schemeFor(team: TeamId, isPlayer: boolean): PaintScheme {
  return isPlayer ? PLAYER_SCHEME : TEAM_SCHEMES[team];
}

const cache = new Map<string, THREE.Material>();

function memo<T extends THREE.Material>(key: string, make: () => T): T {
  let m = cache.get(key) as T | undefined;
  if (!m) {
    m = make();
    cache.set(key, m);
  }
  return m;
}

function hex(c: number): string {
  return `#${c.toString(16).padStart(6, '0')}`;
}

// ---- props and terrain ---------------------------------------------------

export function propMaterial(kind: string | undefined): THREE.MeshStandardMaterial {
  const k = kind ?? 'concrete';
  return memo(`prop:${k}`, () => {
    const map = surfaceTexture(k);
    switch (k) {
      case 'metal':
        return new THREE.MeshStandardMaterial({ map, color: 0x7e8794, roughness: 0.42, metalness: 0.7 });
      case 'sand':
        return new THREE.MeshStandardMaterial({ map, color: 0xcbb188, roughness: 0.95, metalness: 0.02 });
      case 'glass':
        return new THREE.MeshStandardMaterial({
          map,
          color: 0x86c5e6,
          roughness: 0.08,
          metalness: 0.15,
          transparent: true,
          opacity: 0.34,
        });
      case 'hazard':
        return new THREE.MeshStandardMaterial({ map, color: 0xe0b060, roughness: 0.55, metalness: 0.3 });
      default:
        return new THREE.MeshStandardMaterial({ map, color: 0x9a9ea5, roughness: 0.88, metalness: 0.04 });
    }
  });
}

export function groundMaterial(theme: string): THREE.MeshStandardMaterial {
  return memo(`ground:${theme}`, () => {
    const tint =
      theme === 'winter' ? 0xf2f6fa : theme === 'urban' ? 0xa8adb6 : theme === 'space' ? 0x9aa2c0 : 0xb9c39c;
    return new THREE.MeshStandardMaterial({
      map: groundTexture(theme),
      color: tint,
      roughness: 0.96,
      metalness: 0.02,
    });
  });
}

export function skyMaterialTexture(theme: string): THREE.Texture {
  return skyTexture(theme);
}

/** Fog colour: the horizon band of the sky, so distant geometry dissolves into it. */
export function hazeColour(theme: string): number {
  switch (theme) {
    case 'winter':
      return 0xe4edf4;
    case 'urban':
      return 0xc3ced9;
    case 'space':
      return 0x141a30;
    default:
      return 0xcadeec;
  }
}

// ---- tank surfaces -------------------------------------------------------

/** Painted armour. Tinted per scheme off one shared greyscale plate sheet. */
export function paintMaterial(scheme: PaintScheme, part: 'hull' | 'turret'): THREE.MeshStandardMaterial {
  return memo(`paint:${scheme.id}:${part}`, () => {
    const map = armourTexture(scheme.camo);
    return new THREE.MeshStandardMaterial({
      map,
      color: part === 'hull' ? scheme.hull : scheme.turret,
      roughness: 0.62,
      metalness: 0.32,
    });
  });
}

/**
 * Identification bands. Chevroned for the player, flat team colour for
 * everyone else. Double-sided because several of the parts wearing it are open
 * cylinders and single-quad pennants.
 */
export function accentMaterial(scheme: PaintScheme): THREE.MeshStandardMaterial {
  return memo(`accent:${scheme.id}`, () =>
    new THREE.MeshStandardMaterial({
      map: scheme.camo ? null : chevronTexture(hex(scheme.accent), '#10201c'),
      color: scheme.camo ? scheme.accent : 0xffffff,
      emissive: scheme.accent,
      emissiveIntensity: scheme.camo ? 0.1 : 0.18,
      roughness: 0.5,
      metalness: 0.25,
      side: THREE.DoubleSide,
    }),
  );
}

/** Bare metal fittings: handrails, tow shackles, barrel collars. */
export function trimMaterial(scheme: PaintScheme): THREE.MeshStandardMaterial {
  return memo(`trim:${scheme.id}`, () =>
    new THREE.MeshStandardMaterial({
      color: scheme.trim,
      roughness: 0.34,
      metalness: 0.85,
      side: THREE.DoubleSide,
    }),
  );
}

/** Gun steel, hatches, exhaust shrouds — everything unpainted and dark. */
export const gunmetalMaterial = (): THREE.MeshStandardMaterial =>
  memo('gunmetal', () =>
    new THREE.MeshStandardMaterial({ color: 0x33373d, roughness: 0.42, metalness: 0.82, side: THREE.DoubleSide }),
  );

/** Road wheel tyres, mudflaps, bumpers. */
export const rubberMaterial = (): THREE.MeshStandardMaterial =>
  memo('rubber', () => new THREE.MeshStandardMaterial({ color: 0x171a1e, roughness: 0.95, metalness: 0.04 }));

export const trackMaterial = (): THREE.MeshStandardMaterial =>
  memo('track', () =>
    new THREE.MeshStandardMaterial({ map: treadTexture(), color: 0x8a8f96, roughness: 0.72, metalness: 0.55 }),
  );

/**
 * Bolt-on protection: explosive reactive armour bricks and slat cages. Only the
 * player's tank carries these, so "better protected" is something you can see
 * on the model rather than only in the garage stat block.
 */
export const armourBlockMaterial = (): THREE.MeshStandardMaterial =>
  memo('era', () => new THREE.MeshStandardMaterial({ color: 0x2b3128, roughness: 0.9, metalness: 0.12 }));

/** Headlights and optics. */
export const lampMaterial = (): THREE.MeshStandardMaterial =>
  memo('lamp', () =>
    new THREE.MeshStandardMaterial({
      color: 0xd8cfb4,
      emissive: 0xffe9b0,
      emissiveIntensity: 0.45,
      roughness: 0.15,
      metalness: 0.1,
    }),
  );

/** Periscopes and vision blocks. */
export const opticMaterial = (): THREE.MeshStandardMaterial =>
  memo('optic', () =>
    new THREE.MeshStandardMaterial({ color: 0x16212b, roughness: 0.08, metalness: 0.5, side: THREE.DoubleSide }),
  );

/** Hover intakes, emitter tips, engine glow. */
export function glowMaterial(colour: number): THREE.MeshBasicMaterial {
  return memo(
    `glow:${colour}`,
    () => new THREE.MeshBasicMaterial({ color: colour, toneMapped: false, side: THREE.DoubleSide }),
  ) as THREE.MeshBasicMaterial;
}

export function disposeMaterialCache(): void {
  for (const m of cache.values()) m.dispose();
  cache.clear();
  disposeTextureCache();
}
