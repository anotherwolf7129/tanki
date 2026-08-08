import * as CANNON from 'cannon-es';
import type { MapDef, PropDef } from '../data/schema';
import { DEG } from '../core/mathx';

export const LAYER = {
  GROUND: 1,
  PROP: 2,
  TANK: 4,
  PROJECTILE: 8,
  PICKUP: 16,
} as const;

/** Everything a shot can be stopped by. */
export const SHOT_MASK = LAYER.GROUND | LAYER.PROP | LAYER.TANK;
export const WORLD_MASK = LAYER.GROUND | LAYER.PROP;

/** Ground plus one body per entry in `MapDef.props`, in the same order. */
export interface MapBodies {
  ground: CANNON.Body;
  props: CANNON.Body[];
}

export interface RayHit {
  body: CANNON.Body;
  point: CANNON.Vec3;
  normal: CANNON.Vec3;
  distance: number;
}

export class PhysicsWorld {
  readonly world: CANNON.World;
  readonly defaultMaterial = new CANNON.Material('default');
  readonly slickMaterial = new CANNON.Material('slick');
  readonly tankMaterial = new CANNON.Material('tank');

  constructor(gravityScale = 1) {
    this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -19.62 * gravityScale, 0) });
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    this.world.allowSleep = true;
    (this.world.solver as CANNON.GSSolver).iterations = 8;

    this.world.defaultContactMaterial.friction = 0.5;
    this.world.defaultContactMaterial.restitution = 0.05;
    this.world.addContactMaterial(
      new CANNON.ContactMaterial(this.defaultMaterial, this.defaultMaterial, {
        friction: 0.6,
        restitution: 0.05,
      }),
    );
    // Tanks carry no contact friction at all. The solver's friction equations
    // are strong enough to erase a whole frame of drive velocity even at a
    // coefficient of 0.08, so traction, braking and lateral grip are all
    // synthesised in VehicleController instead, where they are tunable per hull.
    this.world.addContactMaterial(
      new CANNON.ContactMaterial(this.tankMaterial, this.defaultMaterial, {
        friction: 0,
        restitution: 0.02,
      }),
    );
    this.world.addContactMaterial(
      new CANNON.ContactMaterial(this.tankMaterial, this.tankMaterial, {
        friction: 0,
        restitution: 0.15,
      }),
    );
    // Hover hulls: no ground friction at all, which is why they climb freely.
    this.world.addContactMaterial(
      new CANNON.ContactMaterial(this.slickMaterial, this.defaultMaterial, {
        friction: 0.0,
        restitution: 0.0,
      }),
    );
    this.world.addContactMaterial(
      new CANNON.ContactMaterial(this.slickMaterial, this.tankMaterial, {
        friction: 0.0,
        restitution: 0.05,
      }),
    );
  }

  step(dt: number): void {
    this.world.step(1 / 60, dt, 4);
  }

  addStatic(shape: CANNON.Shape, pos: CANNON.Vec3, quat: CANNON.Quaternion, layer: number): CANNON.Body {
    const body = new CANNON.Body({
      mass: 0,
      shape,
      position: pos,
      quaternion: quat,
      material: this.defaultMaterial,
      collisionFilterGroup: layer,
      collisionFilterMask: -1,
    });
    this.world.addBody(body);
    return body;
  }

  /**
   * Builds static colliders for a map's prop list plus its ground.
   *
   * The ground is a thick finite box rather than `CANNON.Plane`: an infinite
   * plane reports raycast hits inconsistently (it silently misses half the
   * arena), and since every raycast in the game — ground probes, navgrid
   * sampling, line of sight, shots — depends on hitting the floor, that is not
   * a quirk worth living with. A box also gives the broadphase a real AABB.
   */
  buildMap(def: MapDef): MapBodies {
    const w = def.bounds.x * 2 + 120;
    const d = def.bounds.z * 2 + 120;
    const thickness = 40;
    const ground = new CANNON.Body({
      mass: 0,
      shape: new CANNON.Box(new CANNON.Vec3(w / 2, thickness / 2, d / 2)),
      position: new CANNON.Vec3(0, -thickness / 2, 0),
      material: this.defaultMaterial,
      collisionFilterGroup: LAYER.GROUND,
      collisionFilterMask: -1,
    });
    this.world.addBody(ground);

    // Prop bodies come back index-aligned with `def.props`, which is what lets
    // Boss Raid's demolition find the collider behind a given prop — and the
    // mesh, which `createScene` hands back on the same indices.
    return { ground, props: def.props.map((p) => this.addProp(p)) };
  }

  remove(body: CANNON.Body): void {
    this.world.removeBody(body);
  }

  addProp(p: PropDef): CANNON.Body {
    const [w, h, d] = p.size;
    const quat = new CANNON.Quaternion();
    quat.setFromEuler(0, (p.rot ?? 0) * DEG, 0);
    const pos = new CANNON.Vec3(p.pos[0], p.pos[1], p.pos[2]);

    let shape: CANNON.Shape;
    if (p.kind === 'ramp') {
      shape = rampShape(w, h, d);
    } else if (p.kind === 'cylinder') {
      shape = new CANNON.Cylinder(w / 2, w / 2, h, 12);
    } else {
      shape = new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2));
    }
    return this.addStatic(shape, pos, quat, LAYER.PROP);
  }

  raycast(from: CANNON.Vec3, to: CANNON.Vec3, mask: number, skip?: CANNON.Body): RayHit | null {
    const result = new CANNON.RaycastResult();
    let best: RayHit | null = null;
    this.world.raycastAll(
      from,
      to,
      { collisionFilterMask: mask, skipBackfaces: false },
      (hit: CANNON.RaycastResult) => {
        if (!hit.hasHit || !hit.body) return;
        if (skip && hit.body === skip) return;
        if (best && hit.distance >= best.distance) return;
        best = {
          body: hit.body,
          point: hit.hitPointWorld.clone(),
          normal: hit.hitNormalWorld.clone(),
          distance: hit.distance,
        };
      },
    );
    result.reset();
    return best;
  }

  /** Every body along a ray, nearest first. Used by piercing weapons. */
  raycastAll(from: CANNON.Vec3, to: CANNON.Vec3, mask: number, skip?: CANNON.Body): RayHit[] {
    const hits: RayHit[] = [];
    this.world.raycastAll(from, to, { collisionFilterMask: mask, skipBackfaces: false }, (hit) => {
      if (!hit.hasHit || !hit.body || (skip && hit.body === skip)) return;
      hits.push({
        body: hit.body,
        point: hit.hitPointWorld.clone(),
        normal: hit.hitNormalWorld.clone(),
        distance: hit.distance,
      });
    });
    hits.sort((a, b) => a.distance - b.distance);
    return hits;
  }

  /** True when nothing solid sits between the two points. */
  lineOfSight(from: CANNON.Vec3, to: CANNON.Vec3, skip?: CANNON.Body): boolean {
    return this.raycast(from, to, WORLD_MASK, skip) === null;
  }
}

/**
 * Right-triangular prism: the low edge sits at -Z and the slope climbs to the
 * full height at +Z, so a ramp with yaw 0 is driven up heading north. A convex
 * hull rather than a box, so tanks climb it instead of stalling against a face.
 *
 * Winding matters here — cannon derives face normals from vertex order, and an
 * inward-facing normal makes the collider behave like a hole.
 */
const RAMP_VERTS: [number, number, number][] = [
  [-1, -1, -1], // 0 back-bottom-left
  [1, -1, -1], // 1 back-bottom-right
  [1, -1, 1], // 2 front-bottom-right
  [-1, -1, 1], // 3 front-bottom-left
  [-1, 1, 1], // 4 front-top-left
  [1, 1, 1], // 5 front-top-right
];

// Each face listed counter-clockwise as seen from outside the solid.
const RAMP_FACES = [
  [0, 1, 2, 3], // bottom, -Y
  [3, 2, 5, 4], // front wall, +Z
  [0, 4, 5, 1], // slope, up and back
  [0, 3, 4], // left, -X
  [1, 5, 2], // right, +X
];

function rampShape(w: number, h: number, d: number): CANNON.ConvexPolyhedron {
  const s = [w / 2, h / 2, d / 2];
  const vertices = RAMP_VERTS.map((v) => new CANNON.Vec3(v[0] * s[0], v[1] * s[1], v[2] * s[2]));
  // Normals are supplied rather than derived. Cannon's derivation is correct
  // but its sanity check assumes the hull is centred on the origin, which a
  // wedge is not, so it warns on every ramp in the map.
  const slope = new CANNON.Vec3(0, d, -h);
  slope.normalize();
  const normals = [
    new CANNON.Vec3(0, -1, 0),
    new CANNON.Vec3(0, 0, 1),
    slope,
    new CANNON.Vec3(-1, 0, 0),
    new CANNON.Vec3(1, 0, 0),
  ];
  return new CANNON.ConvexPolyhedron({
    vertices,
    faces: RAMP_FACES.map((f) => [...f]),
    normals,
  });
}

export function rampMeshVertices(w: number, h: number, d: number): Float32Array {
  const s = [w / 2, h / 2, d / 2];
  const v = RAMP_VERTS.map((p) => [p[0] * s[0], p[1] * s[1], p[2] * s[2]]);
  const tris: number[][] = [];
  for (const face of RAMP_FACES) {
    for (let i = 1; i < face.length - 1; i++) tris.push([face[0], face[i], face[i + 1]]);
  }
  const out = new Float32Array(tris.length * 9);
  let i = 0;
  for (const t of tris) {
    for (const idx of t) {
      out.set(v[idx], i);
      i += 3;
    }
  }
  return out;
}
