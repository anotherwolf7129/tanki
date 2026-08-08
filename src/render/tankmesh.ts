import * as THREE from 'three';
import type * as CANNON from 'cannon-es';
import type { HullDef, TeamId, TurretDef } from '../data/schema';
import { barrelReach } from '../data';
import {
  accentMaterial,
  armourBlockMaterial,
  glowMaterial,
  gunmetalMaterial,
  lampMaterial,
  opticMaterial,
  paintMaterial,
  rubberMaterial,
  schemeFor,
  trackMaterial,
  trimMaterial,
} from './materials';

export interface TankMesh {
  root: THREE.Group;
  turret: THREE.Group;
  barrel: THREE.Group;
  setShield(on: boolean): void;
  setBeam(target: CANNON.Vec3 | null, colour: number): void;
  setStream(on: boolean, colour: number): void;
  setCarrying(team: TeamId | null): void;
  /** Lights the engine fire once the hull is badly hurt. */
  setHealth(fraction: number): void;
  /** Recoil recovery, track scroll and flame flicker. */
  animate(dt: number, speedAlong: number): void;
  /** Kicks the gun back in its mantlet. Called when the weapon fires. */
  kick(strength: number): void;
  /** Every transient overlay off, for death and respawn. */
  resetOverlays(): void;
  dispose(): void;
}

/**
 * Material buckets. Every static part of a tank is authored as a primitive,
 * transformed into place, then merged into one geometry per bucket — so a hull
 * built from ~150 authored pieces still costs about ten draw calls. The merged
 * result is cached per hull/turret/role, which means a twelve-bot battle
 * uploads each silhouette exactly once.
 */
type Bucket = 'paint' | 'accent' | 'trim' | 'gunmetal' | 'rubber' | 'track' | 'era' | 'lamp' | 'optic' | 'glow';

const BUCKETS: Bucket[] = ['paint', 'accent', 'trim', 'gunmetal', 'rubber', 'track', 'era', 'lamp', 'optic', 'glow'];

interface Place {
  pos?: [number, number, number];
  rot?: [number, number, number];
}

/**
 * Metres per texture tile on a tank's surfaces. Primitive UVs run 0..1 per face
 * regardless of the primitive's size, so without rescaling a 4 m hull side and a
 * 0.2 m grab handle wear the same stretched sheet, and panel lines and camo lose
 * any consistent scale across the model.
 */
const PAINT_TILE = 3.2;

class PartSet {
  private readonly buckets = new Map<Bucket, THREE.BufferGeometry[]>();
  private readonly matrix = new THREE.Matrix4();
  private readonly euler = new THREE.Euler();
  private readonly quat = new THREE.Quaternion();
  private readonly vec = new THREE.Vector3();
  private readonly unit = new THREE.Vector3(1, 1, 1);

  add(bucket: Bucket, geo: THREE.BufferGeometry, place: Place = {}): void {
    if (bucket === 'paint') scaleUvToSize(geo, PAINT_TILE);
    if (place.pos || place.rot) {
      const p = place.pos ?? [0, 0, 0];
      const r = place.rot ?? [0, 0, 0];
      this.euler.set(r[0], r[1], r[2]);
      this.quat.setFromEuler(this.euler);
      this.vec.set(p[0], p[1], p[2]);
      this.matrix.compose(this.vec, this.quat, this.unit);
      geo.applyMatrix4(this.matrix);
    }
    let list = this.buckets.get(bucket);
    if (!list) {
      list = [];
      this.buckets.set(bucket, list);
    }
    list.push(geo);
  }

  /** Mirrored pair, for anything that exists on both sides of the hull. */
  addPair(bucket: Bucket, make: () => THREE.BufferGeometry, place: (sx: number) => Place): void {
    for (const sx of [-1, 1]) this.add(bucket, make(), place(sx));
  }

  merge(): Map<Bucket, THREE.BufferGeometry> {
    const out = new Map<Bucket, THREE.BufferGeometry>();
    for (const bucket of BUCKETS) {
      const list = this.buckets.get(bucket);
      if (!list?.length) continue;
      out.set(bucket, mergeGeometries(list));
      for (const g of list) g.dispose();
    }
    this.buckets.clear();
    return out;
  }
}

/**
 * Rescales a geometry's UVs from the 0..1-per-face default so one texture tile
 * always covers `tile` metres, using the part's own two largest extents. Called
 * before the part is transformed, so the extents are the primitive's own size.
 */
function scaleUvToSize(geo: THREE.BufferGeometry, tile: number): void {
  const uv = geo.getAttribute('uv');
  if (!uv) return;
  geo.computeBoundingBox();
  const box = geo.boundingBox;
  if (!box) return;
  const extents = [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z].sort((a, b) => b - a);
  const u = Math.max(0.06, extents[0] / tile);
  const v = Math.max(0.06, extents[1] / tile);
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * u, uv.getY(i) * v);
  uv.needsUpdate = true;
}

/**
 * Minimal geometry merge. Only position/normal/uv are needed here, so doing it
 * inline beats pulling the whole examples bundle in for thirty lines of copy.
 */
function mergeGeometries(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat: THREE.BufferGeometry[] = [];
  const temporary: THREE.BufferGeometry[] = [];
  for (const g of list) {
    if (g.index) {
      const nonIndexed = g.toNonIndexed();
      temporary.push(nonIndexed);
      flat.push(nonIndexed);
    } else {
      flat.push(g);
    }
  }

  let count = 0;
  for (const g of flat) count += g.getAttribute('position').count;

  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  let offset = 0;
  for (const g of flat) {
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const t = g.getAttribute('uv');
    position.set(p.array as Float32Array, offset * 3);
    if (n) normal.set(n.array as Float32Array, offset * 3);
    if (t) uv.set(t.array as Float32Array, offset * 2);
    offset += p.count;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.computeBoundingSphere();
  for (const g of temporary) g.dispose();
  return geo;
}

interface Chassis {
  hull: Map<Bucket, THREE.BufferGeometry>;
  turret: Map<Bucket, THREE.BufferGeometry>;
  barrel: Map<Bucket, THREE.BufferGeometry>;
  /** Local Y of the turret ring. */
  ringHeight: number;
}

const chassisCache = new Map<string, Chassis>();

/** Silhouette rules per hull class, so a Wasp never reads like a Mammoth. */
interface Style {
  /** Road wheels per side. */
  wheels: number;
  /** Upper hull inset from the lower hull, as a fraction of width. */
  taper: number;
  /** Fighting-compartment height, as a fraction of hull height. */
  deck: number;
  /** Turret facets: light hulls get a rounder cast turret, heavies a slab one. */
  facets: number;
  /** Stowage baskets, bins and spare-track racks. */
  stowage: boolean;
}

function styleFor(hull: HullDef): Style {
  switch (hull.class) {
    case 'light':
      return { wheels: 4, taper: 0.1, deck: 0.34, facets: 16, stowage: false };
    case 'medium':
      return { wheels: 5, taper: 0.08, deck: 0.4, facets: 10, stowage: true };
    case 'heavy':
      return { wheels: 6, taper: 0.05, deck: 0.46, facets: 8, stowage: true };
    default:
      return { wheels: 6, taper: 0.04, deck: 0.52, facets: 6, stowage: true };
  }
}

export function buildTankMesh(
  hull: HullDef,
  turretDef: TurretDef,
  team: TeamId,
  isPlayer: boolean,
): TankMesh {
  const scheme = schemeFor(team, isPlayer);
  const chassis = getChassis(hull, turretDef, isPlayer);
  const [w, h, d] = hull.size;

  const owned: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];

  // The tread scrolls to sell motion, and `Texture.offset` lives on the texture
  // rather than the material — so each tank needs its own view of the shared
  // tread sheet. Cloning a texture reuses the same `source`, so this costs one
  // small object per tank and no extra GPU upload.
  const sharedTrack = trackMaterial();
  const trackMat = sharedTrack.clone();
  if (sharedTrack.map) {
    trackMat.map = sharedTrack.map.clone();
    owned.push(trackMat.map);
  }
  owned.push(trackMat);

  const materials: Record<Bucket, THREE.Material> = {
    paint: paintMaterial(scheme, 'hull'),
    accent: accentMaterial(scheme),
    trim: trimMaterial(scheme),
    gunmetal: gunmetalMaterial(),
    rubber: rubberMaterial(),
    track: trackMat,
    era: armourBlockMaterial(),
    lamp: lampMaterial(),
    optic: opticMaterial(),
    glow: glowMaterial(scheme.accent),
  };
  const turretPaint = paintMaterial(scheme, 'turret');

  const root = new THREE.Group();

  const body = new THREE.Group();
  root.add(body);
  addBuckets(body, chassis.hull, materials, materials.paint);

  const turret = new THREE.Group();
  turret.position.y = chassis.ringHeight;
  if (!hull.centredTurret) turret.position.z = -d * 0.06;
  root.add(turret);
  addBuckets(turret, chassis.turret, materials, turretPaint);

  const barrel = new THREE.Group();
  turret.add(barrel);
  addBuckets(barrel, chassis.barrel, materials, turretPaint);

  // ---- overlays --------------------------------------------------------
  const reach = Math.max(w, d);

  // Spawn/dome protection bubble. Only the far side of the shell is drawn
  // (`BackSide`), so the bubble haloes the tank instead of frosting over it —
  // a two-sided dome at any readable opacity buries the hull inside itself,
  // which is the opposite of useful during your own spawn. Low facet count so
  // it reads as faceted energy rather than as a smooth grey ball.
  const shieldGeo = new THREE.IcosahedronGeometry(reach * 0.78, 1);
  const shieldMat = new THREE.MeshBasicMaterial({
    color: 0x7dd3fc,
    transparent: true,
    opacity: 0.2,
    side: THREE.BackSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  owned.push(shieldGeo, shieldMat);
  const shield = new THREE.Mesh(shieldGeo, shieldMat);
  shield.visible = false;
  shield.position.y = h * 0.25;
  root.add(shield);

  const beamMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.75,
    toneMapped: false,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const beamGeo = new THREE.CylinderGeometry(0.11, 0.11, 1, 7, 1, true);
  owned.push(beamGeo, beamMat);
  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.visible = false;
  root.add(beam);

  const streamMat = new THREE.MeshBasicMaterial({
    color: 0xff7a2f,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const coneRange = turretDef.cone?.range ?? 14;
  const coneRadius = Math.tan(((turretDef.cone?.angleDeg ?? 30) * 0.5 * Math.PI) / 180) * coneRange;
  const streamGeo = new THREE.ConeGeometry(coneRadius, coneRange, 14, 3, true);
  owned.push(streamGeo, streamMat);
  const stream = new THREE.Mesh(streamGeo, streamMat);
  stream.rotation.x = Math.PI / 2;
  stream.position.z = coneRange / 2;
  stream.visible = false;
  barrel.add(stream);

  // Captured flag, flown from the turret roof.
  const flagPoleGeo = new THREE.CylinderGeometry(0.07, 0.07, 2.6, 6);
  const flagClothGeo = new THREE.PlaneGeometry(1.7, 1.05);
  const flagMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  owned.push(flagPoleGeo, flagClothGeo, flagMat);
  const flagGroup = new THREE.Group();
  const flagPole = new THREE.Mesh(flagPoleGeo, materials.trim);
  flagPole.position.y = 1.3;
  const cloth = new THREE.Mesh(flagClothGeo, flagMat);
  cloth.position.set(0.87, 2.05, 0);
  flagGroup.add(flagPole, cloth);
  flagGroup.position.y = h * 0.3;
  flagGroup.visible = false;
  turret.add(flagGroup);

  // Engine fire, lit once the hull is badly hurt. A tank about to die should
  // look like it — for the player's own dashboard and for target priority.
  const fireGeo = new THREE.IcosahedronGeometry(0.4, 1);
  const fireMat = new THREE.MeshBasicMaterial({
    color: 0xffa040,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  owned.push(fireGeo, fireMat);
  const fire = new THREE.Mesh(fireGeo, fireMat);
  fire.position.set(0, h * 0.6, -d * 0.3);
  fire.visible = false;
  body.add(fire);

  // The player's own tank gets a faint ground ring in its accent colour, so it
  // is never lost behind cover or in a six-tank pile-up.
  let marker: THREE.Mesh | null = null;
  let markerMat: THREE.MeshBasicMaterial | null = null;
  if (isPlayer) {
    const ringGeo = new THREE.RingGeometry(reach * 0.86, reach * 0.94, 44);
    markerMat = new THREE.MeshBasicMaterial({
      color: scheme.accent,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
      depthWrite: false,
      toneMapped: false,
    });
    owned.push(ringGeo, markerMat);
    marker = new THREE.Mesh(ringGeo, markerMat);
    marker.rotation.x = -Math.PI / 2;
    marker.position.y = -h * 0.5 + 0.08;
    root.add(marker);
  }

  const beamStart = new THREE.Vector3();
  const beamEnd = new THREE.Vector3();
  const beamDir = new THREE.Vector3();
  const beamUp = new THREE.Vector3(0, 1, 0);

  let recoil = 0;
  let treadOffset = 0;
  let clock = Math.random() * 10;
  let health = 1;

  return {
    root,
    turret,
    barrel,

    setShield(on: boolean) {
      shield.visible = on;
    },

    setBeam(target: CANNON.Vec3 | null, colour: number) {
      if (!target) {
        beam.visible = false;
        return;
      }
      beamEnd.set(target.x, target.y, target.z);
      root.worldToLocal(beamEnd);
      beamStart.set(turret.position.x, turret.position.y + h * 0.1, turret.position.z);
      beamDir.copy(beamEnd).sub(beamStart);
      const len = beamDir.length();
      if (len < 0.05) {
        beam.visible = false;
        return;
      }
      beam.visible = true;
      beamMat.color.setHex(colour);
      beam.position.copy(beamStart).addScaledVector(beamDir, 0.5);
      beam.scale.set(1, len, 1);
      beam.quaternion.setFromUnitVectors(beamUp, beamDir.normalize());
    },

    setStream(on: boolean, colour: number) {
      stream.visible = on;
      if (on) streamMat.color.setHex(colour);
    },

    setCarrying(carried: TeamId | null) {
      flagGroup.visible = carried !== null;
      if (carried) flagMat.color.setHex(carried === 'red' ? 0xe0483c : 0x3c7ce0);
    },

    setHealth(fraction: number) {
      health = fraction;
      fire.visible = fraction > 0 && fraction < 0.34;
    },

    kick(strength: number) {
      recoil = Math.min(0.6, recoil + strength);
    },

    animate(dt: number, speedAlong: number) {
      clock += dt;

      // Recoil: the gun slides back in the mantlet and returns, and the turret
      // rocks a little with it. Cheap, and it is most of what makes a shot feel
      // like it actually left the barrel.
      if (recoil > 0.0005) {
        recoil = Math.max(0, recoil - dt * 2.6);
        barrel.position.z = -recoil;
        turret.rotation.x = recoil * 0.05;
      } else if (barrel.position.z !== 0) {
        barrel.position.z = 0;
        turret.rotation.x = 0;
      }

      if (trackMat.map) {
        // Wrapped, so a long match never drifts into float precision loss.
        treadOffset = (treadOffset + speedAlong * dt * 0.5) % 1;
        trackMat.map.offset.y = -treadOffset;
      }

      if (fire.visible) {
        const flicker = 0.78 + Math.sin(clock * 17) * 0.16 + Math.sin(clock * 41) * 0.08;
        fire.scale.setScalar(flicker * (1 + (0.34 - health) * 2.2));
        fireMat.opacity = 0.5 + flicker * 0.32;
      }

      // A slow breath on the player's ring: findable without being a beacon.
      if (markerMat) markerMat.opacity = 0.18 + Math.sin(clock * 1.8) * 0.06;
    },

    resetOverlays() {
      shield.visible = false;
      beam.visible = false;
      stream.visible = false;
      flagGroup.visible = false;
      fire.visible = false;
      recoil = 0;
      barrel.position.z = 0;
      turret.rotation.x = 0;
    },

    dispose() {
      for (const o of owned) o.dispose();
    },
  };
}

function addBuckets(
  parent: THREE.Group,
  geometries: Map<Bucket, THREE.BufferGeometry>,
  materials: Record<Bucket, THREE.Material>,
  paintOverride: THREE.Material,
): void {
  for (const [bucket, geo] of geometries) {
    const unlit = bucket === 'glow' || bucket === 'lamp';
    const mesh = new THREE.Mesh(geo, bucket === 'paint' ? paintOverride : materials[bucket]);
    mesh.castShadow = !unlit;
    mesh.receiveShadow = !unlit;
    parent.add(mesh);
  }
}

// ---- chassis construction -------------------------------------------------

function getChassis(hull: HullDef, turretDef: TurretDef, isPlayer: boolean): Chassis {
  const key = `${hull.id}:${turretDef.id}:${isPlayer ? 'p' : 'b'}`;
  const hit = chassisCache.get(key);
  if (hit) return hit;
  const built = buildChassis(hull, turretDef, isPlayer);
  chassisCache.set(key, built);
  return built;
}

/** Frees every cached silhouette. For a full renderer teardown. */
export function disposeChassisCache(): void {
  for (const chassis of chassisCache.values()) {
    for (const map of [chassis.hull, chassis.turret, chassis.barrel]) {
      for (const geo of map.values()) geo.dispose();
    }
  }
  chassisCache.clear();
}

/** How many distinct silhouettes to keep between battles. */
const CHASSIS_BUDGET = 40;

/**
 * Drops the silhouette cache once it has grown past its budget. Safe only
 * between battles, when no mesh references the cached geometry any more — a
 * player cycling loadouts in the garage would otherwise accumulate a merged
 * hull, turret and barrel for every combination they ever tried.
 */
export function pruneChassisCache(): void {
  if (chassisCache.size > CHASSIS_BUDGET) disposeChassisCache();
}

/** Track geometry the hull and the running gear both have to agree on. */
interface Gear {
  /** Road wheel radius. */
  roadR: number;
  /** Sprocket, idler and tread-drum radius. */
  endR: number;
  /** Centre height of the whole running gear. */
  axleY: number;
  /** Distance between sprocket and idler centres. */
  span: number;
  /** Lateral offset of each track's centreline. */
  trackX: number;
  /** Track width. */
  trackW: number;
}

function gearFor(hull: HullDef, style: Style): Gear {
  const [w, h, d] = hull.size;
  const span = d * 0.72;
  const usable = span * 0.86;
  const spacing = usable / Math.max(1, style.wheels - 1);
  const roadR = Math.min(h * 0.3, spacing * 0.52);
  const endR = roadR * 1.25;
  // Sit the bottom of the loop just below the collider, so the tracks read as
  // pressing into the ground rather than hovering over it.
  const axleY = -h * 0.52 + endR * 1.28;
  return { roadR, endR, axleY, span, trackX: w * 0.5 + w * 0.06, trackW: w * 0.23 };
}

function buildChassis(hull: HullDef, turretDef: TurretDef, isPlayer: boolean): Chassis {
  const style = styleFor(hull);
  const gear = gearFor(hull, style);
  const parts = new PartSet();

  buildLowerHull(parts, hull, style, gear);
  buildDeck(parts, hull, style);
  if (hull.hover) buildHoverPods(parts, hull);
  else buildRunningGear(parts, hull, style, gear);
  buildFittings(parts, hull, style, isPlayer);

  const turretParts = new PartSet();
  buildTurret(turretParts, hull, turretDef, style, isPlayer);

  const barrelParts = new PartSet();
  buildBarrel(barrelParts, hull, turretDef);

  return {
    hull: parts.merge(),
    turret: turretParts.merge(),
    barrel: barrelParts.merge(),
    ringHeight: hull.turretMountHeight * 0.6,
  };
}

/**
 * Lower hull: a tub with a sloped glacis at the front and a cut-back plate at
 * the rear, rather than a single box. The slope is what stops a tank reading as
 * a crate — a flat vertical front has no direction to it.
 */
function buildLowerHull(parts: PartSet, hull: HullDef, style: Style, gear: Gear): void {
  const [w, h, d] = hull.size;

  // Tub.
  parts.add('paint', new THREE.BoxGeometry(w, h * 0.7, d * 0.94), { pos: [0, -h * 0.12, 0] });

  // Belly plate, narrower, so the hull sides read as sponsons over the tracks.
  parts.add('gunmetal', new THREE.BoxGeometry(w * 0.84, h * 0.16, d * 0.9), { pos: [0, -h * 0.44, 0] });

  // Glacis: a long sloped plate, with a short nose beak beneath it.
  parts.add('paint', new THREE.BoxGeometry(w * 0.98, h * 0.18, d * 0.3), {
    pos: [0, h * 0.11, d * 0.4],
    rot: [-0.62, 0, 0],
  });
  parts.add('paint', new THREE.BoxGeometry(w * 0.94, h * 0.34, d * 0.1), {
    pos: [0, -h * 0.26, d * 0.45],
    rot: [0.42, 0, 0],
  });

  // Rear plate, cut back the other way, with an engine access hatch above it.
  parts.add('paint', new THREE.BoxGeometry(w * 0.96, h * 0.5, d * 0.12), {
    pos: [0, -h * 0.04, -d * 0.47],
    rot: [0.28, 0, 0],
  });
  parts.add('gunmetal', new THREE.BoxGeometry(w * 0.42, h * 0.06, d * 0.18), { pos: [0, h * 0.2, -d * 0.33] });

  if (hull.hover) return;

  // Sponson skirts over the tracks: proper spaced plates on a heavy hull, thin
  // fenders on a light one.
  const skirtDrop = style.wheels >= 6 ? h * 0.46 : h * 0.32;
  parts.addPair(
    'paint',
    () => new THREE.BoxGeometry(w * 0.05, skirtDrop, d * 0.84),
    (sx) => ({ pos: [sx * (gear.trackX + gear.trackW * 0.5), h * 0.06 - skirtDrop * 0.5, 0] }),
  );
  // Mudflaps at both ends of each skirt.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.add('rubber', new THREE.BoxGeometry(gear.trackW, h * 0.36, 0.06), {
        pos: [sx * gear.trackX, gear.axleY + gear.endR * 0.5, sz * (gear.span * 0.5 + gear.endR + 0.1)],
      });
    }
  }
}

/** Fighting compartment, engine deck, cooling louvres and exhausts. */
function buildDeck(parts: PartSet, hull: HullDef, style: Style): void {
  const [w, h, d] = hull.size;
  const inset = w * style.taper;
  const deckH = h * style.deck;
  const deckY = h * 0.35 + deckH * 0.5;
  const deckTop = h * 0.35 + deckH;

  // Superstructure, sitting forward of centre and leaving a lower engine deck.
  parts.add('paint', new THREE.BoxGeometry(w - inset * 2, deckH, d * 0.56), { pos: [0, deckY, d * 0.12] });
  // Chamfered shoulders, so the deck is not a second crate stacked on the first.
  parts.addPair(
    'paint',
    () => new THREE.BoxGeometry(w * 0.16, deckH * 0.86, d * 0.56),
    (sx) => ({ pos: [sx * (w * 0.5 - inset - w * 0.05), deckY, d * 0.12], rot: [0, 0, sx * 0.55] }),
  );

  // Engine deck: lower, louvred, with a radiator grille.
  const engineY = h * 0.35 + deckH * 0.22;
  parts.add('paint', new THREE.BoxGeometry(w * 0.9, deckH * 0.44, d * 0.3), { pos: [0, engineY, -d * 0.3] });
  for (let i = 0; i < 5; i++) {
    parts.add('gunmetal', new THREE.BoxGeometry(w * 0.7, 0.05, d * 0.025), {
      pos: [0, engineY + deckH * 0.23, -d * 0.38 + i * d * 0.04],
    });
  }
  // Exhaust stacks over the rear fenders, with soot rings at the tips.
  parts.addPair(
    'gunmetal',
    () => new THREE.CylinderGeometry(w * 0.05, w * 0.06, d * 0.2, 8),
    (sx) => ({ pos: [sx * w * 0.4, engineY + deckH * 0.3, -d * 0.38], rot: [Math.PI / 2, 0, sx * 0.16] }),
  );
  parts.addPair(
    'rubber',
    () => new THREE.TorusGeometry(w * 0.058, w * 0.014, 6, 10),
    (sx) => ({ pos: [sx * w * 0.4, engineY + deckH * 0.3, -d * 0.47] }),
  );

  // Driver's hatch and vision block on the glacis roof.
  parts.add('gunmetal', new THREE.CylinderGeometry(w * 0.12, w * 0.12, h * 0.06, 10), {
    pos: [-w * 0.22, deckTop, d * 0.34],
  });
  parts.add('optic', new THREE.BoxGeometry(w * 0.15, h * 0.07, 0.06), {
    pos: [-w * 0.22, deckTop + h * 0.04, d * 0.4],
  });

  if (style.stowage) {
    // Sponson bins: the clutter that makes a tank read as crewed, not machined.
    parts.addPair(
      'gunmetal',
      () => new THREE.BoxGeometry(w * 0.1, h * 0.24, d * 0.22),
      (sx) => ({ pos: [sx * (w * 0.5 - w * 0.01), h * 0.42, -d * 0.06] }),
    );
    parts.addPair(
      'trim',
      () => new THREE.BoxGeometry(w * 0.03, h * 0.05, d * 0.2),
      (sx) => ({ pos: [sx * (w * 0.54), h * 0.54, -d * 0.06] }),
    );
  }
}

/** Tracks, sprockets, idlers, road wheels and return rollers. */
function buildRunningGear(parts: PartSet, hull: HullDef, style: Style, gear: Gear): void {
  const [w, h, d] = hull.size;
  const { roadR, endR, axleY, span, trackX, trackW } = gear;
  const runT = endR * 0.24;

  for (const sx of [-1, 1]) {
    // A real closed band: bottom run, top run and a tread drum at each end. The
    // gap between the runs is visible under the sponson, and that gap is a
    // large part of why a tracked hull reads as tracked.
    parts.add('track', new THREE.BoxGeometry(trackW, runT, span), {
      pos: [sx * trackX, axleY - endR - runT * 0.5, 0],
    });
    parts.add('track', new THREE.BoxGeometry(trackW, runT, span), {
      pos: [sx * trackX, axleY + endR + runT * 0.5, 0],
    });

    for (const sz of [-1, 1]) {
      const z = (sz * span) / 2;
      // Open-ended tube, so the sprocket inside stays visible from the side.
      parts.add('track', new THREE.CylinderGeometry(endR + runT * 0.5, endR + runT * 0.5, trackW, 18, 1, true), {
        pos: [sx * trackX, axleY, z],
        rot: [0, 0, Math.PI / 2],
      });
      // Sprocket at the rear, idler at the front.
      parts.add('trim', new THREE.CylinderGeometry(endR * 0.78, endR * 0.78, trackW * 0.7, 14), {
        pos: [sx * trackX, axleY, z],
        rot: [0, 0, Math.PI / 2],
      });
      parts.add('gunmetal', new THREE.CylinderGeometry(endR * 0.26, endR * 0.26, trackW * 1.1, 10), {
        pos: [sx * trackX, axleY, z],
        rot: [0, 0, Math.PI / 2],
      });
      // Lightening holes, drawn as recessed dark discs on the wheel face.
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        parts.add('rubber', new THREE.CylinderGeometry(endR * 0.16, endR * 0.16, trackW * 0.76, 8), {
          pos: [sx * trackX, axleY + Math.sin(a) * endR * 0.48, z + Math.cos(a) * endR * 0.48],
          rot: [0, 0, Math.PI / 2],
        });
      }
    }

    // Road wheels along the bottom run.
    const usable = span * 0.86;
    for (let i = 0; i < style.wheels; i++) {
      const t = style.wheels === 1 ? 0.5 : i / (style.wheels - 1);
      const z = -usable / 2 + usable * t;
      parts.add('rubber', new THREE.CylinderGeometry(roadR, roadR, trackW * 0.82, 14), {
        pos: [sx * trackX, axleY - endR + roadR, z],
        rot: [0, 0, Math.PI / 2],
      });
      parts.add('trim', new THREE.CylinderGeometry(roadR * 0.42, roadR * 0.42, trackW * 0.9, 10), {
        pos: [sx * trackX, axleY - endR + roadR, z],
        rot: [0, 0, Math.PI / 2],
      });
      // Suspension arm back to the hull side.
      parts.add('gunmetal', new THREE.BoxGeometry(trackW * 0.2, roadR * 0.34, roadR * 0.9), {
        pos: [sx * (trackX - trackW * 0.4), axleY - endR + roadR * 1.3, z],
        rot: [0.4, 0, 0],
      });
    }

    // Return rollers riding under the top run.
    for (let i = 0; i < 3; i++) {
      const z = -span * 0.3 + i * span * 0.3;
      parts.add('rubber', new THREE.CylinderGeometry(roadR * 0.34, roadR * 0.34, trackW * 0.6, 10), {
        pos: [sx * trackX, axleY + endR - roadR * 0.34, z],
        rot: [0, 0, Math.PI / 2],
      });
    }
  }

  if (style.stowage) {
    // Spare track links bolted to the glacis. Pure silhouette, but it is the
    // single most recognisable piece of tank clutter there is.
    for (let i = 0; i < 4; i++) {
      parts.add('track', new THREE.BoxGeometry(w * 0.17, h * 0.06, d * 0.045), {
        pos: [-w * 0.24 + i * w * 0.16, h * 0.19, d * 0.47],
        rot: [-0.5, 0, 0],
      });
    }
  }
}

/** Hover hulls get thruster nacelles and lift vents instead of running gear. */
function buildHoverPods(parts: PartSet, hull: HullDef): void {
  const [w, h, d] = hull.size;
  const podR = w * 0.17;
  const podLen = d * 0.72;
  const podY = -h * 0.28;

  parts.addPair(
    'paint',
    () => new THREE.CylinderGeometry(podR, podR, podLen, 14),
    (sx) => ({ pos: [sx * w * 0.52, podY, 0], rot: [Math.PI / 2, 0, 0] }),
  );
  // Tapered nose and a flared exhaust bell, so the pods have a front and a back.
  parts.addPair(
    'paint',
    () => new THREE.ConeGeometry(podR, podLen * 0.26, 14),
    (sx) => ({ pos: [sx * w * 0.52, podY, podLen * 0.62], rot: [Math.PI / 2, 0, 0] }),
  );
  parts.addPair(
    'gunmetal',
    () => new THREE.CylinderGeometry(podR * 1.1, podR * 0.85, podLen * 0.2, 14, 1, true),
    (sx) => ({ pos: [sx * w * 0.52, podY, -podLen * 0.58], rot: [Math.PI / 2, 0, 0] }),
  );
  // Intake and exhaust rings, lit in the tank's accent colour.
  parts.addPair(
    'glow',
    () => new THREE.TorusGeometry(podR * 0.74, podR * 0.13, 8, 18),
    (sx) => ({ pos: [sx * w * 0.52, podY, podLen * 0.4] }),
  );
  parts.addPair(
    'glow',
    () => new THREE.TorusGeometry(podR * 0.62, podR * 0.11, 8, 18),
    (sx) => ({ pos: [sx * w * 0.52, podY, -podLen * 0.46] }),
  );
  // Downward lift vents either side of the keel.
  parts.addPair(
    'glow',
    () => new THREE.PlaneGeometry(w * 0.2, d * 0.5),
    (sx) => ({ pos: [sx * w * 0.28, -h * 0.53, 0], rot: [Math.PI / 2, 0, 0] }),
  );
  // Pylons joining the pods to the hull, and stabiliser fins aft.
  parts.addPair(
    'gunmetal',
    () => new THREE.BoxGeometry(w * 0.1, h * 0.26, d * 0.2),
    (sx) => ({ pos: [sx * w * 0.46, podY + h * 0.2, d * 0.05] }),
  );
  parts.addPair(
    'accent',
    () => new THREE.BoxGeometry(0.07, h * 0.3, d * 0.18),
    (sx) => ({ pos: [sx * w * 0.52, podY + h * 0.24, -d * 0.32] }),
  );
}

/** Lights, handrails, aerials, team bands and the player's bolt-on armour. */
function buildFittings(parts: PartSet, hull: HullDef, style: Style, isPlayer: boolean): void {
  const [w, h, d] = hull.size;
  const deckTop = h * 0.35 + h * style.deck;

  // Headlights with brush guards.
  for (const sx of [-1, 1]) {
    parts.add('lamp', new THREE.CylinderGeometry(w * 0.045, w * 0.045, 0.07, 10), {
      pos: [sx * w * 0.35, h * 0.3, d * 0.5],
      rot: [Math.PI / 2, 0, 0],
    });
    parts.add('gunmetal', new THREE.TorusGeometry(w * 0.06, 0.028, 5, 10), {
      pos: [sx * w * 0.35, h * 0.3, d * 0.51],
    });
  }

  // Tow shackles, front and rear.
  for (const sx of [-1, 1]) {
    parts.add('trim', new THREE.TorusGeometry(w * 0.05, 0.025, 5, 10), {
      pos: [sx * w * 0.26, -h * 0.32, d * 0.52],
      rot: [Math.PI / 2, 0, 0],
    });
    parts.add('trim', new THREE.TorusGeometry(w * 0.05, 0.025, 5, 10), {
      pos: [sx * w * 0.26, -h * 0.18, -d * 0.52],
      rot: [Math.PI / 2, 0, 0],
    });
  }

  // Grab handles down each side of the superstructure.
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      parts.add('trim', new THREE.TorusGeometry(w * 0.035, 0.018, 4, 8, Math.PI), {
        pos: [sx * (w * 0.5 - w * 0.01), h * 0.56, d * 0.28 - i * d * 0.14],
        rot: [0, sx * Math.PI * 0.5, 0],
      });
    }
  }

  // Identification flashes: a short bar on each side of the nose, and a roof
  // panel so the tank stays readable from a chase camera looking down on it.
  // Short bars rather than a full-width band, which read as painted markings
  // instead of a stripe of trim wrapped round the hull.
  for (const sx of [-1, 1]) {
    parts.add('accent', new THREE.BoxGeometry(w * 0.18, h * 0.09, d * 0.04), {
      pos: [sx * w * 0.19, -h * 0.05, d * 0.49],
    });
    parts.add('accent', new THREE.BoxGeometry(0.04, h * 0.3, d * 0.1), {
      pos: [sx * (w * 0.5 + w * 0.03), h * 0.14, -d * 0.3],
    });
  }
  parts.add('accent', new THREE.BoxGeometry(w * 0.32, 0.04, d * 0.13), {
    pos: [w * 0.24, deckTop + 0.03, d * 0.02],
  });

  if (!isPlayer) return;

  // ---- the player's protection package --------------------------------
  // Explosive reactive armour across the glacis, laid out as a real brick
  // array — a single thicker plate would just read as a bigger box.
  const cols = 5;
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < cols; c++) {
      const x = -w * 0.35 + (c * (w * 0.7)) / (cols - 1);
      parts.add('era', new THREE.BoxGeometry(w * 0.14, h * 0.1, d * 0.1), {
        pos: [x, h * 0.02 + r * h * 0.18, d * 0.46 - r * d * 0.035],
        rot: [-0.62, 0, 0],
      });
    }
  }

  // Spaced armour outboard of the hull. On a tracked hull that is slat armour —
  // bars with visible gaps, the classic "up-armoured" silhouette cue. A hover
  // hull already has its nacelles out there, so it gets appliqué belly plates
  // over the lift vents instead of a cage it has no room for.
  if (hull.hover) {
    for (const sx of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        parts.add('era', new THREE.BoxGeometry(w * 0.22, h * 0.1, d * 0.2), {
          pos: [sx * w * 0.26, -h * 0.5, -d * 0.24 + i * d * 0.24],
        });
      }
    }
  } else {
    for (const sx of [-1, 1]) {
      for (let i = 0; i < 6; i++) {
        parts.add('era', new THREE.BoxGeometry(0.07, h * 0.4, d * 0.1), {
          pos: [sx * (w * 0.5 + w * 0.22), -h * 0.14, -d * 0.34 + i * d * 0.135],
        });
      }
      for (const y of [h * 0.08, -h * 0.36]) {
        parts.add('trim', new THREE.BoxGeometry(0.06, 0.07, d * 0.8), {
          pos: [sx * (w * 0.5 + w * 0.22), y, 0],
        });
      }
    }
  }

  // Commander's aerial with a pennant, so you can find yourself over cover.
  parts.add('gunmetal', new THREE.CylinderGeometry(0.035, 0.02, h * 2.4, 5), {
    pos: [-w * 0.42, deckTop + h * 1.2, -d * 0.28],
  });
  parts.add('accent', new THREE.PlaneGeometry(w * 0.3, h * 0.26), {
    pos: [-w * 0.42 + w * 0.15, deckTop + h * 2.2, -d * 0.28],
  });
}

/**
 * Turret. Faceted rather than a plain drum, with a mantlet, cupola, vision
 * blocks, smoke launchers and a rear stowage basket. The player additionally
 * gets cheek armour, roof bricks and a slat cage on the basket.
 */
function buildTurret(
  parts: PartSet,
  hull: HullDef,
  turretDef: TurretDef,
  style: Style,
  isPlayer: boolean,
): void {
  const [w, h, d] = hull.size;
  const ringR = w * 0.36;
  const bodyH = h * 0.62;

  // Ring the turret sits in.
  parts.add('gunmetal', new THREE.CylinderGeometry(ringR * 1.1, ringR * 1.14, h * 0.1, style.facets), {
    pos: [0, -bodyH * 0.55, 0],
  });

  // Main shell: two stacked frusta, so the sides slope in toward the roof.
  parts.add('paint', new THREE.CylinderGeometry(ringR * 0.96, ringR * 1.06, bodyH * 0.62, style.facets), {
    pos: [0, -bodyH * 0.12, 0],
  });
  parts.add('paint', new THREE.CylinderGeometry(ringR * 0.74, ringR * 0.96, bodyH * 0.42, style.facets), {
    pos: [0, bodyH * 0.32, 0],
  });
  parts.add('paint', new THREE.CylinderGeometry(ringR * 0.76, ringR * 0.76, h * 0.05, style.facets), {
    pos: [0, bodyH * 0.54, 0],
  });

  // Front cheeks: a wedge either side of the gun. This is the turret's face.
  for (const sx of [-1, 1]) {
    parts.add('paint', new THREE.BoxGeometry(ringR * 0.5, bodyH * 0.6, ringR * 0.7), {
      pos: [sx * ringR * 0.5, -bodyH * 0.02, ringR * 0.6],
      rot: [0, sx * 0.42, 0],
    });
  }

  // Mantlet: the rounded block the barrel actually leaves through. A long-range
  // gun needs a heavier one, which is a free extra cue about what you are
  // looking at before it fires.
  const mantlet = turretDef.class === 'long-range' ? 0.44 : turretDef.class === 'short-range' ? 0.32 : 0.38;
  parts.add('gunmetal', new THREE.CylinderGeometry(bodyH * mantlet * 0.92, bodyH * mantlet, ringR * 0.62, 12), {
    pos: [0, 0, ringR * 0.92],
    rot: [Math.PI / 2, 0, 0],
  });

  // Commander's cupola: hatch on top, ring of vision blocks around it.
  const cupR = ringR * 0.3;
  parts.add('paint', new THREE.CylinderGeometry(cupR, cupR * 1.05, h * 0.22, 12), {
    pos: [-ringR * 0.34, bodyH * 0.64, -ringR * 0.2],
  });
  parts.add('gunmetal', new THREE.CylinderGeometry(cupR * 0.88, cupR * 0.88, h * 0.05, 12), {
    pos: [-ringR * 0.34, bodyH * 0.77, -ringR * 0.2],
  });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    parts.add('optic', new THREE.BoxGeometry(cupR * 0.34, h * 0.07, 0.05), {
      pos: [-ringR * 0.34 + Math.sin(a) * cupR, bodyH * 0.66, -ringR * 0.2 + Math.cos(a) * cupR],
      rot: [0, a, 0],
    });
  }
  // Loader's hatch on the other side.
  parts.add('gunmetal', new THREE.CylinderGeometry(cupR * 0.85, cupR * 0.85, h * 0.05, 10), {
    pos: [ringR * 0.34, bodyH * 0.57, -ringR * 0.16],
  });

  // Gunner's sight, forward and offset.
  parts.add('gunmetal', new THREE.BoxGeometry(ringR * 0.26, h * 0.15, ringR * 0.3), {
    pos: [ringR * 0.42, bodyH * 0.6, ringR * 0.3],
  });
  parts.add('optic', new THREE.PlaneGeometry(ringR * 0.2, h * 0.09), {
    pos: [ringR * 0.42, bodyH * 0.6, ringR * 0.46],
  });

  // Coaxial machine gun alongside the main armament — but energy turrets carry
  // a radiator fin bank there instead of a second powder gun.
  if (turretDef.fireMode === 'beam' || turretDef.fireMode === 'chain') {
    for (let i = 0; i < 4; i++) {
      parts.add('trim', new THREE.BoxGeometry(ringR * 0.5, h * 0.02, ringR * 0.36), {
        pos: [ringR * 0.42, bodyH * 0.36 + i * h * 0.045, ringR * 0.2],
      });
    }
  } else {
    parts.add('gunmetal', new THREE.CylinderGeometry(0.05, 0.06, d * 0.28, 6), {
      pos: [ringR * 0.4, -bodyH * 0.06, ringR * 1.2],
      rot: [Math.PI / 2, 0, 0],
    });
  }

  // Smoke grenade launchers, three per side.
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      parts.add('gunmetal', new THREE.CylinderGeometry(0.07, 0.07, 0.26, 8), {
        pos: [sx * ringR * 0.78, bodyH * 0.2, ringR * 0.48 - i * 0.2],
        rot: [Math.PI / 2 - 0.5, 0, 0],
      });
    }
  }

  // Rear stowage basket: floor, bar cage, and a rolled tarp inside it.
  parts.add('gunmetal', new THREE.BoxGeometry(ringR * 1.3, 0.05, ringR * 0.6), {
    pos: [0, -bodyH * 0.1, -ringR * 1.15],
  });
  for (let i = 0; i < 5; i++) {
    parts.add('trim', new THREE.BoxGeometry(0.05, ringR * 0.5, 0.05), {
      pos: [-ringR * 0.6 + i * ringR * 0.3, bodyH * 0.12, -ringR * 1.4],
    });
  }
  parts.add('trim', new THREE.BoxGeometry(ringR * 1.3, 0.05, 0.05), {
    pos: [0, bodyH * 0.36, -ringR * 1.4],
  });
  parts.add('rubber', new THREE.CylinderGeometry(ringR * 0.19, ringR * 0.19, ringR * 1.0, 8), {
    pos: [0, bodyH * 0.05, -ringR * 1.1],
    rot: [0, 0, Math.PI / 2],
  });

  // Identification band around the turret, readable from any bearing.
  parts.add('accent', new THREE.CylinderGeometry(ringR * 1.01, ringR * 1.04, h * 0.09, style.facets, 1, true), {
    pos: [0, -bodyH * 0.3, 0],
  });

  if (!isPlayer) return;

  // Cheek armour, roof bricks and a slat cage over the basket.
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      parts.add('era', new THREE.BoxGeometry(ringR * 0.16, bodyH * 0.34, ringR * 0.3), {
        pos: [sx * (ringR * 0.7 + i * ringR * 0.04), -bodyH * 0.02, ringR * 0.7 - i * ringR * 0.28],
        rot: [0, sx * 0.42, 0],
      });
    }
  }
  for (let i = 0; i < 4; i++) {
    parts.add('era', new THREE.BoxGeometry(ringR * 0.28, h * 0.07, ringR * 0.24), {
      pos: [
        (i % 2) * ringR * 0.32 - ringR * 0.16,
        bodyH * 0.58,
        ringR * 0.4 - Math.floor(i / 2) * ringR * 0.3,
      ],
    });
  }
  for (let i = 0; i < 6; i++) {
    parts.add('era', new THREE.BoxGeometry(0.06, ringR * 0.5, 0.06), {
      pos: [-ringR * 0.66 + i * ringR * 0.26, bodyH * 0.12, -ringR * 1.52],
    });
  }
}

/**
 * Barrel assemblies, one per firing archetype. Every one gets a breech, a
 * sleeve and a muzzle device, so the gun reads as a gun at any range instead of
 * as a stick.
 */
function buildBarrel(parts: PartSet, hull: HullDef, def: TurretDef): void {
  // The gun is modelled to exactly the distance shots leave from, so the muzzle
  // flash sits on the end of the barrel instead of floating in front of it — or,
  // as it did before, hiding inside the glacis. The turret group is set back on
  // hulls without a centred ring, so add that back.
  const len = barrelReach(hull, def) + (hull.centredTurret ? 0 : hull.size[2] * 0.06);
  const tube = (geo: THREE.BufferGeometry, x: number, y: number, z: number, bucket: Bucket = 'gunmetal') =>
    parts.add(bucket, geo, { pos: [x, y, z], rot: [Math.PI / 2, 0, 0] });

  // Breech block, common to every gun, sitting behind the mantlet.
  tube(new THREE.BoxGeometry(0.44, 0.4, 0.5), 0, 0, -0.1);

  switch (def.fireMode) {
    case 'sustained':
      for (const sx of [-0.42, 0.42]) {
        tube(new THREE.CylinderGeometry(0.115, 0.135, len, 10), sx, 0, len / 2);
        tube(new THREE.CylinderGeometry(0.155, 0.155, len * 0.3, 10), sx, 0, len * 0.24);
        tube(new THREE.CylinderGeometry(0.15, 0.16, 0.24, 10), sx, 0, len * 0.97);
      }
      parts.add('trim', new THREE.BoxGeometry(1.06, 0.12, 0.16), { pos: [0, 0, len * 0.55] });
      break;

    case 'minigun': {
      const barrels = 6;
      for (let i = 0; i < barrels; i++) {
        const a = (i / barrels) * Math.PI * 2;
        tube(new THREE.CylinderGeometry(0.075, 0.075, len, 6), Math.cos(a) * 0.23, Math.sin(a) * 0.23, len / 2);
      }
      // Rotor housing, cooling shroud, and the clamp holding the cluster true.
      tube(new THREE.CylinderGeometry(0.4, 0.42, len * 0.34, 14), 0, 0, len * 0.17);
      parts.add('trim', new THREE.TorusGeometry(0.28, 0.05, 6, 16), { pos: [0, 0, len * 0.95] });
      parts.add('trim', new THREE.TorusGeometry(0.3, 0.05, 6, 16), { pos: [0, 0, len * 0.42] });
      // Ammunition chute feeding in from the right.
      parts.add('gunmetal', new THREE.BoxGeometry(0.22, 0.3, 0.7), { pos: [0.42, -0.12, 0.18] });
      break;
    }

    case 'cone': {
      // Projector: wide nozzle, pilot ring, and a pressure tank strapped along
      // the side with a feed line running forward.
      tube(new THREE.CylinderGeometry(0.2, 0.15, len * 0.8, 12), 0, 0, len * 0.4);
      tube(new THREE.CylinderGeometry(0.34, 0.2, len * 0.28, 14), 0, 0, len * 0.87);
      parts.add('trim', new THREE.TorusGeometry(0.3, 0.045, 6, 16), { pos: [0, 0, len * 0.95] });
      parts.add('gunmetal', new THREE.CylinderGeometry(0.17, 0.17, len * 0.5, 10), {
        pos: [0.4, -0.18, len * 0.3],
        rot: [Math.PI / 2, 0, 0],
      });
      parts.add('trim', new THREE.CylinderGeometry(0.05, 0.05, 0.5, 6), {
        pos: [0.28, -0.18, len * 0.6],
        rot: [Math.PI / 2, 0, -0.5],
      });
      break;
    }

    case 'beam':
    case 'chain': {
      // Emitter: a stack of focusing rings down a slim waveguide, capacitor
      // banks either side, and a lit tip.
      tube(new THREE.CylinderGeometry(0.13, 0.24, len, 12), 0, 0, len / 2);
      for (let i = 0; i < 4; i++) {
        parts.add('trim', new THREE.TorusGeometry(0.2 - i * 0.02, 0.05, 6, 14), {
          pos: [0, 0, len * (0.4 + i * 0.18)],
        });
      }
      parts.add('glow', new THREE.SphereGeometry(0.11, 10, 8), { pos: [0, 0, len] });
      for (const sx of [-1, 1]) {
        parts.add('gunmetal', new THREE.BoxGeometry(0.18, 0.3, len * 0.36), {
          pos: [sx * 0.36, 0.02, len * 0.26],
        });
      }
      break;
    }

    case 'shotgun': {
      tube(new THREE.CylinderGeometry(0.26, 0.3, len, 12), 0, 0, len / 2);
      tube(new THREE.CylinderGeometry(0.38, 0.27, len * 0.22, 12), 0, 0, len * 0.91);
      for (let i = 0; i < 3; i++) {
        parts.add('trim', new THREE.TorusGeometry(0.31, 0.04, 6, 14), { pos: [0, 0, len * (0.3 + i * 0.2)] });
      }
      break;
    }

    case 'sniper': {
      tube(new THREE.CylinderGeometry(0.1, 0.13, len, 10), 0, 0, len / 2);
      tube(new THREE.CylinderGeometry(0.16, 0.16, len * 0.45, 10), 0, 0, len * 0.3);
      tube(new THREE.CylinderGeometry(0.19, 0.19, len * 0.16, 10), 0, 0, len * 0.93);
      for (const sx of [-1, 1]) {
        parts.add('gunmetal', new THREE.BoxGeometry(0.06, 0.24, len * 0.1), { pos: [sx * 0.16, 0, len * 0.93] });
      }
      // Scope mounted over the breech.
      parts.add('gunmetal', new THREE.CylinderGeometry(0.11, 0.11, len * 0.34, 10), {
        pos: [0, 0.32, len * 0.28],
        rot: [Math.PI / 2, 0, 0],
      });
      parts.add('optic', new THREE.CylinderGeometry(0.1, 0.1, 0.04, 10), {
        pos: [0, 0.32, len * 0.45],
        rot: [Math.PI / 2, 0, 0],
      });
      parts.add('trim', new THREE.BoxGeometry(0.06, 0.16, 0.06), { pos: [0, 0.2, len * 0.14] });
      break;
    }

    case 'ballistic': {
      // Mortar: short and fat, on a recoil cradle with a counterweight.
      tube(new THREE.CylinderGeometry(0.3, 0.36, len * 0.72, 12), 0, 0.06, len * 0.36);
      tube(new THREE.CylinderGeometry(0.4, 0.4, len * 0.14, 12), 0, 0.06, len * 0.67);
      parts.add('trim', new THREE.TorusGeometry(0.37, 0.06, 6, 16), { pos: [0, 0.06, len * 0.34] });
      parts.add('gunmetal', new THREE.BoxGeometry(0.7, 0.28, 0.4), { pos: [0, -0.2, -0.2] });
      for (const sx of [-1, 1]) {
        parts.add('gunmetal', new THREE.CylinderGeometry(0.08, 0.08, len * 0.4, 8), {
          pos: [sx * 0.3, -0.16, len * 0.24],
          rot: [Math.PI / 2, 0, 0],
        });
      }
      break;
    }

    case 'guided': {
      // Missile box launcher: a cell block with visible tubes and blast covers.
      parts.add('paint', new THREE.BoxGeometry(1.0, 0.62, len * 0.66), { pos: [0, 0.1, len * 0.33] });
      for (let r = 0; r < 2; r++) {
        for (let c = 0; c < 3; c++) {
          parts.add('gunmetal', new THREE.CylinderGeometry(0.12, 0.12, len * 0.7, 8), {
            pos: [-0.3 + c * 0.3, -0.06 + r * 0.3, len * 0.34],
            rot: [Math.PI / 2, 0, 0],
          });
          parts.add('accent', new THREE.CylinderGeometry(0.13, 0.13, 0.04, 8), {
            pos: [-0.3 + c * 0.3, -0.06 + r * 0.3, len * 0.68],
            rot: [Math.PI / 2, 0, 0],
          });
        }
      }
      // Tracker head on top of the box.
      parts.add('gunmetal', new THREE.BoxGeometry(0.3, 0.22, 0.3), { pos: [0, 0.5, len * 0.2] });
      parts.add('optic', new THREE.PlaneGeometry(0.24, 0.16), { pos: [0, 0.5, len * 0.36] });
      break;
    }

    case 'hitscan': {
      // Railgun: twin rails on a heavy frame, ringed with capacitor coils.
      for (const sx of [-1, 1]) {
        parts.add('trim', new THREE.BoxGeometry(0.11, 0.2, len), { pos: [sx * 0.19, 0, len / 2] });
      }
      tube(new THREE.CylinderGeometry(0.2, 0.26, len * 0.5, 10), 0, 0, len * 0.2);
      for (let i = 0; i < 5; i++) {
        parts.add('gunmetal', new THREE.TorusGeometry(0.27, 0.06, 6, 14), {
          pos: [0, 0, len * (0.16 + i * 0.19)],
        });
      }
      parts.add('glow', new THREE.TorusGeometry(0.2, 0.045, 6, 16), { pos: [0, 0, len] });
      break;
    }

    case 'dual': {
      // Coaxial pair: a heavy lower tube and a light upper one.
      tube(new THREE.CylinderGeometry(0.2, 0.25, len, 12), 0, -0.1, len / 2);
      tube(new THREE.CylinderGeometry(0.11, 0.13, len * 0.86, 10), 0, 0.26, len * 0.43);
      tube(new THREE.CylinderGeometry(0.29, 0.24, len * 0.16, 12), 0, -0.1, len * 0.93);
      parts.add('trim', new THREE.BoxGeometry(0.4, 0.5, 0.14), { pos: [0, 0.08, len * 0.3] });
      parts.add('trim', new THREE.TorusGeometry(0.24, 0.045, 6, 14), { pos: [0, -0.1, len * 0.62] });
      break;
    }

    default: {
      // Conventional rifled gun: thermal sleeve, bore evacuator, muzzle brake.
      tube(new THREE.CylinderGeometry(0.17, 0.23, len, 12), 0, 0, len / 2);
      tube(new THREE.CylinderGeometry(0.26, 0.26, len * 0.36, 12), 0, 0, len * 0.24);
      parts.add('gunmetal', new THREE.SphereGeometry(0.22, 10, 8), { pos: [0, 0.02, len * 0.56] });
      tube(new THREE.CylinderGeometry(0.27, 0.27, len * 0.14, 12), 0, 0, len * 0.94);
      for (const sx of [-1, 1]) {
        parts.add('gunmetal', new THREE.BoxGeometry(0.07, 0.3, len * 0.09), { pos: [sx * 0.22, 0, len * 0.94] });
      }
      break;
    }
  }
}

