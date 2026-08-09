import * as CANNON from 'cannon-es';
import * as THREE from 'three';
import {
  CRATER_MAX,
  DECK_FLATNESS,
  DECK_FOOTPRINT_MAX,
  TERRAIN_FOOTPRINT,
  CRATER_GROWTH,
  CRATER_GROWTH_MAX,
  CRATER_MERGE,
  CRATER_MIN_POWER,
  CRATER_RADIUS_PER_POWER,
  CRATER_ROUGHNESS,
  CRATER_SURFACE_REACH,
  DEMOLITION_POWER_SCALE,
  ELEVATED_BASE,
  RUBBLE_HEIGHT,
  RUBBLE_SLOPE_RUN,
  STRUCTURE_INTEGRITY_MAX,
  STRUCTURE_INTEGRITY_MIN,
  STRUCTURE_INTEGRITY_PER_M3,
  STRUCTURE_TOUGHNESS,
  TOPPLE_CRUSH_DAMAGE,
  TOPPLE_CRUSH_IMPULSE,
  TOPPLE_RATIO,
  TOPPLE_TIME,
} from '../data/raid';
import type { MapDef, PropDef } from '../data/schema';
import type { NavGrid } from '../ai/navgrid';
import { LAYER, moundShape, type PhysicsWorld } from '../physics/world';
import type { Arena } from './types';

/**
 * Arena demolition — the Overseer taking the map apart while it fights on it.
 *
 * Every other boss escalation in this mode happens to the *boss*: it gets
 * faster, it hits harder, it fans more shells out of the barrel. This is the
 * one that happens to the *arena*, and it is the only one the raid cannot
 * un-learn or out-position, because it is subtractive. The wall you fought the
 * first phase from is not there in the third.
 *
 * Three rules keep it a mechanic rather than a light show:
 *
 * - **Only the Overseer's ordnance does this.** Raiders hitting a wall with a
 *   Thunder shell leave it standing. Cover is the raid's resource and the boss
 *   is the only thing that can spend it, so "the map is flatter than it was" is
 *   always a sentence about what the boss has done to you.
 * - **What falls never comes back and never blocks a shot again.** A toppled
 *   building becomes a rubble field a metre high: still something you bump
 *   over, no longer something you hide behind. There is no rebuilt cover, and
 *   no rubble tall enough to fight from, because the whole point of the system
 *   is that the arena only ever gets more open.
 * - **The perimeter and the ramps are exempt.** Ramps are how the map connects
 *   to itself and the perimeter is the edge of the world; a boss that can leave
 *   the raid stranded on unreachable ground, or blow a hole in the fence, is a
 *   boss that broke the map rather than the fight.
 *
 * Elevated decks are the exception that earns its own branch: shoot the floor
 * out from under a raider sniping off a platform and it does not become
 * rubble — it becomes a *hole*, they fall through it, and the high ground is
 * gone for the rest of the fight.
 */

const UP = new THREE.Vector3(0, 1, 0);

type State = 'standing' | 'falling' | 'down';

interface Structure {
  def: PropDef;
  body: CANNON.Body | null;
  mesh: THREE.Mesh | null;
  integrity: number;
  maxIntegrity: number;
  /** World centre and half-extents of the standing prop. */
  centre: THREE.Vector3;
  half: THREE.Vector3;
  /** Base height — where the rubble ends up. */
  baseY: number;
  /** Tall and thin enough to come down sideways rather than sit down. */
  topples: boolean;
  /** A floor rather than a building: it falls away and leaves a gap. */
  deck: boolean;
  /** How much of the map's cover this prop is, for the HUD's readout. */
  coverValue: number;
  state: State;
  /** Fall animation, live only while `state` is 'falling'. */
  fall: {
    elapsed: number;
    pivot: THREE.Vector3;
    axis: THREE.Vector3;
    dir: THREE.Vector3;
    startPos: THREE.Vector3;
    startQuat: THREE.Quaternion;
  } | null;
}

interface Crater {
  x: number;
  z: number;
  y: number;
  radius: number;
  /** Scorched floor, darker core and raised rim — three flat discs, no pit. */
  mesh: THREE.Mesh;
  core: THREE.Mesh;
  rim: THREE.Mesh;
}

export interface DemolitionDeps {
  arena: Arena;
  scene: THREE.Scene;
  phys: PhysicsWorld;
  nav: NavGrid;
  /**
   * Ground the raid should not be standing on, published as it becomes
   * dangerous — the footprint a building is about to fall across. The squad
   * reads these the same way it reads the boss's telegraphs.
   */
  warn: (x: number, z: number, radius: number, seconds: number, label: string) => void;
}

export class Demolition {
  private readonly structures: Structure[] = [];
  private readonly craters: Crater[] = [];
  private readonly falling: Structure[] = [];

  /** Total cover value on the map at the start, for the "COVER −n%" readout. */
  private readonly coverTotal: number;
  private coverDown = 0;
  private downed = 0;

  private readonly rubbleGeo = new THREE.BoxGeometry(1, 1, 1);
  private readonly discGeo = new THREE.CircleGeometry(1, 22);
  private readonly ringGeo = new THREE.RingGeometry(0.82, 1.06, 24);
  private readonly rubbleMat = new THREE.MeshStandardMaterial({ color: 0x5a5750, roughness: 0.98, metalness: 0.02 });
  private readonly scorchMat = new THREE.MeshStandardMaterial({
    color: 0x2b2724,
    roughness: 1,
    metalness: 0,
    transparent: true,
    // Scorched, not a void. At full strength a crater field reads as a hole in
    // the map rather than as ground that has been shelled.
    opacity: 0.6,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  /**
   * The inner shadow. A flat disc reads as a stain; the same disc with a
   * darker middle and a lighter rim reads as a bowl, which is as close to a
   * pit as a floor made of one collider is ever going to get.
   */
  private readonly coreMat = new THREE.MeshStandardMaterial({
    color: 0x14120f,
    roughness: 1,
    metalness: 0,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
  });
  private readonly rimMat = new THREE.MeshStandardMaterial({
    color: 0x4a463f,
    roughness: 1,
    metalness: 0,
    transparent: true,
    opacity: 0.65,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -3,
  });

  private readonly rubble: THREE.Mesh[] = [];

  constructor(
    def: MapDef,
    bodies: CANNON.Body[],
    meshes: THREE.Mesh[],
    private readonly deps: DemolitionDeps,
  ) {
    let total = 0;
    for (let i = 0; i < def.props.length; i++) {
      const p = def.props[i];
      const s = this.build(p, bodies[i] ?? null, meshes[i] ?? null);
      if (s) {
        this.structures.push(s);
        total += s.coverValue;
      }
    }
    this.coverTotal = Math.max(1, total);
  }

  /**
   * What can be brought down, and how hard it is. Integrity is volume times a
   * material toughness rather than an authored number per prop, so a map author
   * never has to think about demolition at all — a big concrete block is simply
   * harder to level than a glass box, which is what anyone would assume.
   */
  private build(p: PropDef, body: CANNON.Body | null, mesh: THREE.Mesh | null): Structure | null {
    if (p.structural || p.kind === 'ramp' || !body || !mesh) return null;

    const [w, h, d] = p.size;
    const footprint = Math.max(w, d);
    const area = w * d;
    const baseHeight = p.pos[1] - h / 2;
    const elevated = baseHeight > ELEVATED_BASE;
    const deck = elevated && h <= Math.min(w, d) * DECK_FLATNESS;

    // Terrain, not cover. Maps are built from the same kit as the buildings, so
    // the only thing separating "a wall" from "the ground half the map stands
    // on" is its footprint — and levelling the second one takes the spawns and
    // the ramps with it.
    if (area > (deck ? DECK_FOOTPRINT_MAX : TERRAIN_FOOTPRINT)) return null;

    const volume = p.kind === 'cylinder' ? Math.PI * (w / 2) * (w / 2) * h : w * h * d;
    const tough = STRUCTURE_TOUGHNESS[p.material ?? 'concrete'] ?? 1;
    const integrity = Math.min(
      STRUCTURE_INTEGRITY_MAX,
      Math.max(STRUCTURE_INTEGRITY_MIN, volume * STRUCTURE_INTEGRITY_PER_M3 * tough),
    );

    return {
      def: p,
      body,
      mesh,
      integrity,
      maxIntegrity: integrity,
      centre: new THREE.Vector3(p.pos[0], p.pos[1], p.pos[2]),
      half: new THREE.Vector3(w / 2, h / 2, d / 2),
      baseY: baseHeight,
      topples: h >= footprint * TOPPLE_RATIO && h >= 4,
      deck,
      // Cover is footprint times how much of a tank's silhouette it hides, so a
      // knee-high kerb counts for almost nothing and a three-storey block counts
      // for all of it. This is the number the HUD's percentage is a share of.
      coverValue: w * d * Math.min(1, h / 4),
      state: 'standing',
      fall: null,
    };
  }

  // ---- readouts ---------------------------------------------------------

  /** Share of the map's cover the Overseer has taken away, 0..1. */
  get coverLost(): number {
    return this.coverDown / this.coverTotal;
  }

  get structuresDown(): number {
    return this.downed;
  }

  get craterCount(): number {
    return this.craters.length;
  }

  // ---- taking the map apart ---------------------------------------------

  /**
   * One blast, against the map. `power` is the blast's centre damage, so a
   * meteor is worth several times what a main-gun shell is and the raid can
   * read which of the Overseer's tools is doing the demolishing.
   */
  blast(centre: CANNON.Vec3, radius: number, power: number): void {
    const p = power * DEMOLITION_POWER_SCALE;
    if (p <= 0 || radius <= 0) return;

    for (const s of this.structures) {
      if (s.state !== 'standing') continue;
      const gap = this.distanceTo(s, centre);
      if (gap > radius) continue;
      s.integrity -= p * (1 - gap / radius);
      if (s.integrity <= 0) this.collapse(s);
    }

    this.crater(centre, radius, power);
  }

  /**
   * Six tonnes arriving at speed. The Overseer stops going round raiders once
   * it is at siege speed; this is what stops it going round *buildings* at the
   * same time, which is the moment the demolition stops reading as ordnance
   * and starts reading as the thing itself.
   */
  ram(at: CANNON.Vec3, reach: number, power: number): void {
    const p = power * DEMOLITION_POWER_SCALE;
    for (const s of this.structures) {
      if (s.state !== 'standing') continue;
      if (this.distanceTo(s, at) > reach) continue;
      s.integrity -= p;
      if (s.integrity <= 0) this.collapse(s);
    }
  }

  /** Distance from a point to the prop's box, zero inside it. */
  private distanceTo(s: Structure, at: CANNON.Vec3): number {
    const dx = Math.max(0, Math.abs(at.x - s.centre.x) - s.half.x);
    const dy = Math.max(0, Math.abs(at.y - s.centre.y) - s.half.y);
    const dz = Math.max(0, Math.abs(at.z - s.centre.z) - s.half.z);
    return Math.hypot(dx, dy, dz);
  }

  /**
   * A structure gives way. A deck simply goes, and whoever was standing on it
   * discovers that the floor was a target; anything tall enough goes over
   * sideways, which takes about a second and is announced as ground to be off.
   */
  private collapse(s: Structure): void {
    const arena = this.deps.arena;
    s.integrity = 0;

    if (s.deck) {
      // No rubble: the point of a deck coming down is the gap it leaves.
      this.removeBody(s);
      this.removeMesh(s);
      s.state = 'down';
      this.retire(s);
      arena.fx.explosion(new CANNON.Vec3(s.centre.x, s.centre.y, s.centre.z), Math.max(6, s.half.x + s.half.z), 0xb0a89a);
      arena.notify('A deck just went — the high ground with it', 'warning');
      this.resampleAround(s, Math.max(s.half.x, s.half.z) + 4);
      return;
    }

    if (!s.topples) {
      // Wide and low: it sits down where it stood, keeping its own yaw.
      this.pile(s, s.centre.x, s.centre.z, (s.def.rot ?? 0) * Math.PI / 180, s.half.z, s.half.x);
      this.deps.arena.fx.explosion(
        new CANNON.Vec3(s.centre.x, s.baseY + 1, s.centre.z),
        Math.max(6, s.half.x + s.half.z),
        0xa89f92,
      );
      return;
    }

    // Which way it goes over. Away from the arena's centre of mass would be
    // arbitrary; away from whatever knocked it down is what it looks like it
    // should do, and the blast that finished it is the last thing that touched
    // it — so it falls away from the Overseer.
    const boss = arena.tanks.find((t) => t.isBoss);
    const dir = new THREE.Vector3(1, 0, 0);
    if (boss) {
      dir.set(s.centre.x - boss.position.x, 0, s.centre.z - boss.position.z);
      if (dir.lengthSq() < 1e-4) dir.set(1, 0, 0);
      dir.normalize();
    }

    const reach = Math.abs(dir.x) * s.half.x + Math.abs(dir.z) * s.half.z;
    const pivot = new THREE.Vector3(
      s.centre.x + dir.x * reach,
      s.baseY,
      s.centre.z + dir.z * reach,
    );
    s.state = 'falling';
    s.fall = {
      elapsed: 0,
      pivot,
      axis: new THREE.Vector3(dir.z, 0, -dir.x).normalize(),
      dir,
      startPos: s.centre.clone(),
      startQuat: s.mesh ? s.mesh.quaternion.clone() : new THREE.Quaternion(),
    };
    this.falling.push(s);

    // Everything a falling building is about to land on, published before it
    // lands on it. The squad reads this as a zone to be out of; the player
    // reads the building leaning over.
    const span = s.half.y;
    this.deps.warn(
      s.centre.x + dir.x * span * 0.6,
      s.centre.z + dir.z * span * 0.6,
      span * 0.8 + Math.max(s.half.x, s.half.z),
      TOPPLE_TIME,
      'falling structure',
    );
    arena.notify('Structure coming down — get out from under it', 'warning');
  }

  /** Advances anything mid-fall, and lands it. */
  update(dt: number): void {
    for (let i = this.falling.length - 1; i >= 0; i--) {
      const s = this.falling[i];
      const f = s.fall!;
      f.elapsed += dt;
      // Eased so it hangs for a beat and then goes over — a linear topple reads
      // like a door swinging, not like a building losing an argument.
      const k = Math.min(1, f.elapsed / TOPPLE_TIME);
      const angle = (Math.PI / 2) * k * k;

      if (s.mesh) {
        const q = new THREE.Quaternion().setFromAxisAngle(f.axis, angle);
        const offset = f.startPos.clone().sub(f.pivot).applyQuaternion(q);
        s.mesh.position.copy(f.pivot).add(offset);
        s.mesh.quaternion.copy(q).multiply(f.startQuat);
      }

      if (k < 1) continue;
      this.falling.splice(i, 1);
      this.land(s, f.dir);
    }
  }

  /** The moment a falling structure hits the ground. */
  private land(s: Structure, dir: THREE.Vector3): void {
    const arena = this.deps.arena;
    // It pivoted on its leading base edge, so the slab now lies from that edge
    // outward for its own former height.
    const pivotReach = Math.abs(dir.x) * s.half.x + Math.abs(dir.z) * s.half.z;
    const halfLength = s.half.y;
    const halfWidth = Math.abs(dir.z) * s.half.x + Math.abs(dir.x) * s.half.z;
    const length = halfLength * 2;
    const width = halfWidth * 2;
    const centre = new CANNON.Vec3(
      s.centre.x + dir.x * (pivotReach + halfLength),
      s.baseY,
      s.centre.z + dir.z * (pivotReach + halfLength),
    );

    // Anything under it is crushed. It is a slow, telegraphed, announced,
    // visibly-leaning building: being under it is a decision.
    for (const t of arena.tanks) {
      if (!t.alive) continue;
      const along = (t.position.x - centre.x) * dir.x + (t.position.z - centre.z) * dir.z;
      const across = (t.position.x - centre.x) * -dir.z + (t.position.z - centre.z) * dir.x;
      if (Math.abs(along) > length / 2 + 2 || Math.abs(across) > width / 2 + 2) continue;
      arena.damage(t, TOPPLE_CRUSH_DAMAGE, null, { kind: 'contact', at: t.centre() });
      t.vehicle.applyImpulse(new CANNON.Vec3(dir.x * 0.4, 1, dir.z * 0.4), TOPPLE_CRUSH_IMPULSE);
    }

    this.pile(s, centre.x, centre.z, Math.atan2(dir.x, dir.z), halfLength, halfWidth);
    arena.fx.explosion(centre, Math.max(8, length * 0.5), 0xa89f92);
    arena.fx.shake = Math.min(1.6, arena.fx.shake + 0.5);
  }

  /**
   * What is left: a rubble field a metre high, and — this is the part that took
   * two goes — one a tank can actually get over.
   *
   * The collider is a mound with sloped shoulders rather than a slab, because a
   * hull with no wheels and no contact friction parks against a vertical face
   * of *any* height rather than climbing it. Sloped, it drives over the pile on
   * the same physics that carries it up a map ramp, and rolls as it goes: the
   * body is a real rigid box on a real incline, so clipping the shoulder of a
   * pile lifts one side and leans the tank over exactly as far as the debris
   * under that track is high.
   *
   * The rubble is still low enough to be no cover at all, which was always the
   * point — a levelled building has to stay levelled.
   */
  private pile(
    s: Structure,
    x: number,
    z: number,
    yaw: number,
    halfLength: number,
    halfWidth: number,
  ): void {
    const centre = new CANNON.Vec3(x, s.baseY + RUBBLE_HEIGHT / 2, z);
    // Along the pile's own axis, which is +Z before the yaw is applied.
    const ax = Math.sin(yaw);
    const az = Math.cos(yaw);

    this.removeBody(s);
    this.removeMesh(s);

    const quat = new CANNON.Quaternion();
    quat.setFromEuler(0, yaw, 0);
    s.body = this.deps.phys.addStatic(
      moundShape(halfWidth, RUBBLE_HEIGHT / 2, halfLength, RUBBLE_SLOPE_RUN),
      centre,
      quat,
      LAYER.PROP,
    );

    // Debris to match the collider: blocks across the crest, then a skirt of
    // flatter pieces lying on the slopes. A slab-shaped pile of rubble sitting
    // on a mound-shaped collider is the kind of mismatch a player reads as the
    // tank climbing thin air.
    const place = (
      along: number,
      across: number,
      y: number,
      sx: number,
      sy: number,
      sz: number,
      tilt: THREE.Euler,
    ): void => {
      const m = new THREE.Mesh(this.rubbleGeo, this.rubbleMat);
      m.position.set(x + ax * along + az * across, y, z + az * along - ax * across);
      m.quaternion.setFromAxisAngle(UP, yaw).multiply(new THREE.Quaternion().setFromEuler(tilt));
      m.scale.set(sx, sy, sz);
      m.castShadow = true;
      m.receiveShadow = true;
      this.deps.scene.add(m);
      this.rubble.push(m);
    };

    const chunks = Math.min(7, 3 + Math.round(halfLength / 4));
    const spread = (halfLength * 2) / chunks;
    for (let i = 0; i < chunks; i++) {
      const t = (i / Math.max(1, chunks - 1) - 0.5) * 2 * halfLength;
      place(
        t,
        (Math.random() - 0.5) * halfWidth,
        s.baseY + RUBBLE_HEIGHT * (0.3 + Math.random() * 0.35),
        halfWidth * (0.9 + Math.random() * 0.7),
        RUBBLE_HEIGHT * (0.7 + Math.random() * 0.6),
        spread * 1.4,
        new THREE.Euler((Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.3),
      );
    }

    // The skirt: two pieces lying along each of the four slopes, pitched to sit
    // flat on them, so the drivable ramp is something you can see before you
    // are on it.
    const pitch = Math.atan2(RUBBLE_HEIGHT, RUBBLE_SLOPE_RUN);
    const skirt = RUBBLE_SLOPE_RUN * 1.15;
    for (const end of [-1, 1]) {
      for (let i = 0; i < 2; i++) {
        const across = (i - 0.5) * halfWidth;
        place(
          end * (halfLength + RUBBLE_SLOPE_RUN * 0.5),
          across,
          s.baseY + RUBBLE_HEIGHT * 0.28,
          halfWidth * (0.7 + Math.random() * 0.4),
          RUBBLE_HEIGHT * 0.42,
          skirt,
          new THREE.Euler(end * pitch, (Math.random() - 0.5) * 0.3, 0),
        );
        const along = (i - 0.5) * halfLength;
        place(
          along,
          end * (halfWidth + RUBBLE_SLOPE_RUN * 0.5),
          s.baseY + RUBBLE_HEIGHT * 0.28,
          skirt,
          RUBBLE_HEIGHT * 0.42,
          halfLength * (0.5 + Math.random() * 0.4),
          new THREE.Euler(0, (Math.random() - 0.5) * 0.3, -end * pitch),
        );
      }
    }

    s.state = 'down';
    this.retire(s);
    this.deps.nav.roughen(x, z, halfLength + 2, CRATER_ROUGHNESS);
    this.resampleAround(s, halfLength + RUBBLE_SLOPE_RUN + 4);
  }

  private retire(s: Structure): void {
    this.downed += 1;
    this.coverDown += s.coverValue;
  }

  private removeBody(s: Structure): void {
    if (!s.body) return;
    this.deps.phys.remove(s.body);
    s.body = null;
  }

  private removeMesh(s: Structure): void {
    if (!s.mesh) return;
    this.deps.scene.remove(s.mesh);
    s.mesh = null;
  }

  private resampleAround(s: Structure, pad: number): void {
    const reach = Math.max(s.half.x, s.half.z, s.half.y) + pad;
    this.deps.nav.resample(
      this.deps.phys,
      s.centre.x - reach,
      s.centre.z - reach,
      s.centre.x + reach,
      s.centre.z + reach,
    );
  }

  // ---- craters ----------------------------------------------------------

  /**
   * The ground keeping score.
   *
   * The arena floor is a single collider, so this is honest about what it is:
   * a crater here is a scar and a churned-up rim, not a pit you can fall into.
   * What it buys is the thing craters are actually for — a raid that can see,
   * without looking at a health bar, how long this fight has been going and
   * how much of it happened right here.
   */
  private crater(centre: CANNON.Vec3, radius: number, power: number): void {
    if (power < CRATER_MIN_POWER) return;
    const surface = this.deps.nav.surfaceHeight(centre.x, centre.z);
    // Airbursts and shells that went off against a wall do not dig.
    if (Math.abs(centre.y - surface) > CRATER_SURFACE_REACH) return;

    const want = Math.min(radius * 0.9, CRATER_RADIUS_PER_POWER * Math.sqrt(power));

    for (const c of this.craters) {
      if (Math.hypot(c.x - centre.x, c.z - centre.z) > CRATER_MERGE) continue;
      // Overlapping strikes deepen and widen one crater rather than stacking
      // forty discs on the ground the storm walked over.
      const grown = Math.min(c.radius + want * CRATER_GROWTH, want + CRATER_GROWTH_MAX);
      if (grown <= c.radius) return;
      c.radius = grown;
      c.mesh.scale.setScalar(grown);
      c.core.scale.setScalar(grown * 0.55);
      c.rim.scale.setScalar(grown * 1.08);
      this.deps.nav.roughen(c.x, c.z, grown, CRATER_ROUGHNESS * 0.5);
      return;
    }

    if (this.craters.length >= CRATER_MAX) {
      // The oldest scar gives up its meshes. Geometry and materials are shared,
      // so this costs two scene removals: the map stays marked where it matters
      // and the scene stays bounded.
      const oldest = this.craters.shift()!;
      this.deps.scene.remove(oldest.mesh);
      this.deps.scene.remove(oldest.core);
      this.deps.scene.remove(oldest.rim);
    }

    const disc = new THREE.Mesh(this.discGeo, this.scorchMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(centre.x, surface + 0.04, centre.z);
    disc.scale.setScalar(want);
    disc.receiveShadow = true;

    const core = new THREE.Mesh(this.discGeo, this.coreMat);
    core.rotation.x = -Math.PI / 2;
    core.position.set(centre.x, surface + 0.05, centre.z);
    core.scale.setScalar(want * 0.55);

    const rim = new THREE.Mesh(this.ringGeo, this.rimMat);
    rim.rotation.x = -Math.PI / 2;
    rim.position.set(centre.x, surface + 0.06, centre.z);
    rim.scale.setScalar(want * 1.08);

    this.deps.scene.add(disc);
    this.deps.scene.add(core);
    this.deps.scene.add(rim);
    this.craters.push({ x: centre.x, z: centre.z, y: surface, radius: want, mesh: disc, core, rim });
    this.deps.nav.roughen(centre.x, centre.z, want, CRATER_ROUGHNESS);
  }

  dispose(): void {
    for (const c of this.craters) {
      this.deps.scene.remove(c.mesh);
      this.deps.scene.remove(c.core);
      this.deps.scene.remove(c.rim);
    }
    this.craters.length = 0;
    for (const m of this.rubble) this.deps.scene.remove(m);
    this.rubble.length = 0;
    this.structures.length = 0;
    this.falling.length = 0;
    this.rubbleGeo.dispose();
    this.discGeo.dispose();
    this.ringGeo.dispose();
    this.rubbleMat.dispose();
    this.scorchMat.dispose();
    this.coreMat.dispose();
    this.rimMat.dispose();
  }
}
