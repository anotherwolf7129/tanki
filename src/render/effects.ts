import * as THREE from 'three';
import type * as CANNON from 'cannon-es';

type Blend = 'additive' | 'normal';

interface Timed {
  obj: THREE.Mesh;
  life: number;
  maxLife: number;
  kind: 'fade' | 'expand' | 'tracer';
  blend: Blend;
  scaleTo?: number;
  /** Metres per second of drift, for smoke and debris. */
  drift?: THREE.Vector3;
  spin?: number;
}

/**
 * Pooled transient visuals. Bright effects are additive so they read against
 * any map theme; smoke and debris are normally blended, because additive black
 * is invisible. Nothing here allocates per-frame once the pools are warm.
 */
export class Effects {
  private readonly active: Timed[] = [];
  private readonly pools: Record<Blend, THREE.Mesh[]> = { additive: [], normal: [] };

  private readonly sphere = new THREE.SphereGeometry(1, 10, 8);
  private readonly cylinder = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
  private readonly ring = new THREE.RingGeometry(0.75, 1, 22);
  private readonly puff = new THREE.IcosahedronGeometry(1, 1);
  private readonly shard = new THREE.TetrahedronGeometry(1, 0);

  readonly damageNumbers: { text: string; world: THREE.Vector3; life: number; colour: string }[] = [];
  /** Screen-shake amplitude, consumed by the camera. */
  shake = 0;

  constructor(private readonly scene: THREE.Scene) {}

  muzzleFlash(pos: CANNON.Vec3, dir: CANNON.Vec3, colour: number): void {
    // Core flash.
    const m = this.take(this.sphere, colour, 0.9, 'additive');
    m.position.set(pos.x + dir.x * 0.4, pos.y + dir.y * 0.4, pos.z + dir.z * 0.4);
    m.scale.set(0.42, 0.42, 0.85);
    this.push(m, 0.07, 'fade', 'additive');

    // Blast ring facing down the barrel — reads as a real muzzle brake blast.
    const r = this.take(this.ring, colour, 0.55, 'additive');
    r.position.set(pos.x + dir.x * 0.6, pos.y + dir.y * 0.6, pos.z + dir.z * 0.6);
    r.lookAt(pos.x + dir.x * 2, pos.y + dir.y * 2, pos.z + dir.z * 2);
    r.scale.setScalar(0.35);
    this.push(r, 0.11, 'expand', 'additive', 3.2);

    // A wisp of propellant smoke that lingers after the flash is gone.
    this.smoke(pos, 0.5, 0.5, { x: dir.x * 2.2, y: 0.8, z: dir.z * 2.2 });
  }

  impact(pos: CANNON.Vec3, normal: CANNON.Vec3, colour: number, scale = 1): void {
    const m = this.take(this.sphere, colour, 0.9, 'additive');
    m.position.set(pos.x, pos.y, pos.z);
    m.scale.setScalar(0.35 * scale);
    this.push(m, 0.16, 'expand', 'additive', 1.9 * scale);

    const r = this.take(this.ring, colour, 0.55, 'additive');
    r.position.set(pos.x + normal.x * 0.05, pos.y + normal.y * 0.05, pos.z + normal.z * 0.05);
    r.lookAt(pos.x + normal.x, pos.y + normal.y, pos.z + normal.z);
    r.scale.setScalar(0.6 * scale);
    this.push(r, 0.22, 'expand', 'additive', 2.6 * scale);

    // Sparks kicked off along the surface normal.
    const sparks = scale > 0.8 ? 4 : 2;
    for (let i = 0; i < sparks; i++) {
      const s = this.take(this.shard, colour, 0.85, 'additive');
      s.position.set(pos.x, pos.y, pos.z);
      s.scale.setScalar(0.07 * scale);
      this.push(s, 0.2 + Math.random() * 0.2, 'fade', 'additive', undefined, {
        x: normal.x * 4 + (Math.random() - 0.5) * 7,
        y: normal.y * 4 + Math.random() * 5,
        z: normal.z * 4 + (Math.random() - 0.5) * 7,
      });
    }
  }

  explosion(pos: CANNON.Vec3, radius: number, colour: number): void {
    const core = this.take(this.sphere, colour, 0.8, 'additive');
    core.position.set(pos.x, pos.y, pos.z);
    core.scale.setScalar(radius * 0.3);
    this.push(core, 0.3, 'expand', 'additive', 2.2);

    const shock = this.take(this.ring, 0xffffff, 0.45, 'additive');
    shock.position.set(pos.x, pos.y + 0.2, pos.z);
    shock.rotation.x = -Math.PI / 2;
    shock.scale.setScalar(radius * 0.4);
    this.push(shock, 0.4, 'expand', 'additive', 2.6);

    // Rolling smoke ball, then debris. Without these an explosion is a flash
    // that vanishes, and nothing on screen remembers it happened.
    const puffs = Math.min(8, 3 + Math.round(radius * 0.4));
    for (let i = 0; i < puffs; i++) {
      const a = (i / puffs) * Math.PI * 2 + Math.random();
      this.smoke(pos, radius * 0.28, 1.1 + Math.random() * 0.6, {
        x: Math.cos(a) * radius * 0.5,
        y: 1.5 + Math.random() * radius * 0.25,
        z: Math.sin(a) * radius * 0.5,
      });
    }
    for (let i = 0; i < 8; i++) {
      const s = this.take(this.shard, 0x3b3f45, 1, 'normal');
      s.position.set(pos.x, pos.y + 0.3, pos.z);
      s.scale.setScalar(0.12 + Math.random() * 0.22);
      this.push(s, 0.7 + Math.random() * 0.5, 'fade', 'normal', undefined, {
        x: (Math.random() - 0.5) * radius * 1.4,
        y: 4 + Math.random() * radius * 0.7,
        z: (Math.random() - 0.5) * radius * 1.4,
      }, 6);
    }

    this.shake = Math.min(1.6, this.shake + radius * 0.05);
  }

  /** Grey-brown smoke puff that rises, spreads and fades. */
  smoke(pos: CANNON.Vec3 | THREE.Vector3, scale: number, life: number, drift?: { x: number; y: number; z: number }): void {
    const shade = 0x3c3a38 + Math.round(Math.random() * 0x1c) * 0x010101;
    const m = this.take(this.puff, shade, 0.2 + Math.random() * 0.1, 'normal');
    m.position.set(pos.x, pos.y, pos.z);
    m.scale.setScalar(Math.max(0.15, scale) * (0.7 + Math.random() * 0.6));
    m.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    const d = drift ?? { x: 0, y: 1.2, z: 0 };
    // A little lateral wander, so a column of puffs is a plume rather than a
    // stack of identical balls.
    this.push(m, life, 'expand', 'normal', 2.6, { x: d.x + (Math.random() - 0.5) * 1.6, y: d.y, z: d.z + (Math.random() - 0.5) * 1.6 }, 0.5);
  }

  tracer(from: CANNON.Vec3, to: CANNON.Vec3, colour: number, radius = 0.08, life = 0.12): void {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.01) return;
    const m = this.take(this.cylinder, colour, 0.8, 'additive');
    m.position.set(from.x + dx / 2, from.y + dy / 2, from.z + dz / 2);
    m.scale.set(radius, len, radius);
    m.quaternion.setFromUnitVectors(UP, TMP_DIR.set(dx / len, dy / len, dz / len));
    this.push(m, life, 'tracer', 'additive');
  }

  chain(from: CANNON.Vec3, points: CANNON.Vec3[], colour: number): void {
    let prev = from;
    for (const p of points) {
      this.tracer(prev, p, colour, 0.09, 0.1);
      prev = p;
    }
  }

  supplyBurst(pos: CANNON.Vec3, colour: number, scale = 1): void {
    const r = this.take(this.ring, colour, 0.7, 'additive');
    r.position.set(pos.x, pos.y + 0.6, pos.z);
    r.rotation.x = -Math.PI / 2;
    r.scale.setScalar(1.4 * scale);
    this.push(r, 0.45, 'expand', 'additive', 3.2);

    const core = this.take(this.sphere, colour, 0.45, 'additive');
    core.position.set(pos.x, pos.y + 0.8, pos.z);
    core.scale.setScalar(0.5 * scale);
    this.push(core, 0.35, 'expand', 'additive', 2.4);
  }

  damageNumber(pos: CANNON.Vec3, amount: number, colour: string): void {
    if (amount < 1) return;
    this.damageNumbers.push({
      text: String(Math.round(amount)),
      world: new THREE.Vector3(pos.x, pos.y + 1.4, pos.z),
      life: 1.1,
      colour,
    });
    if (this.damageNumbers.length > 40) this.damageNumbers.shift();
  }

  update(dt: number): void {
    this.shake = Math.max(0, this.shake - dt * 3.2);
    for (let i = this.active.length - 1; i >= 0; i--) {
      const t = this.active[i];
      t.life -= dt;
      const k = Math.max(0, t.life / t.maxLife);
      const mat = t.obj.material as THREE.MeshBasicMaterial;
      if (t.kind === 'expand' && t.scaleTo) {
        const grow = 1 + (t.scaleTo - 1) * (1 - k);
        t.obj.scale.setScalar((t.obj.userData.baseScale as number) * grow);
      }
      if (t.drift) {
        t.obj.position.addScaledVector(t.drift, dt);
        if (t.kind === 'expand') {
          // Smoke sheds its momentum as it billows out.
          t.drift.multiplyScalar(1 - Math.min(0.9, dt * 1.8));
        } else {
          // Sparks and debris keep their momentum and fall.
          t.drift.y -= dt * 16;
        }
      }
      if (t.spin) t.obj.rotation.y += t.spin * dt;
      mat.opacity = (t.obj.userData.baseOpacity as number) * (t.kind === 'tracer' ? k * k : k);
      if (t.life <= 0) {
        this.scene.remove(t.obj);
        this.pools[t.blend].push(t.obj);
        this.active.splice(i, 1);
      }
    }

    for (let i = this.damageNumbers.length - 1; i >= 0; i--) {
      const n = this.damageNumbers[i];
      n.life -= dt;
      n.world.y += dt * 1.6;
      if (n.life <= 0) this.damageNumbers.splice(i, 1);
    }
  }

  clear(): void {
    for (const t of this.active) {
      this.scene.remove(t.obj);
      this.pools[t.blend].push(t.obj);
    }
    this.active.length = 0;
    this.damageNumbers.length = 0;
  }

  private take(geo: THREE.BufferGeometry, colour: number, opacity: number, blend: Blend): THREE.Mesh {
    const mesh = this.pools[blend].pop();
    if (mesh) {
      mesh.geometry = geo;
      const mat = mesh.material as THREE.MeshBasicMaterial;
      mat.color.setHex(colour);
      mat.opacity = opacity;
      mesh.userData.baseOpacity = opacity;
      mesh.visible = true;
      mesh.rotation.set(0, 0, 0);
      mesh.quaternion.identity();
      mesh.scale.setScalar(1);
      return mesh;
    }
    const mat = new THREE.MeshBasicMaterial({
      color: colour,
      transparent: true,
      opacity,
      depthWrite: false,
      blending: blend === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
      toneMapped: blend !== 'additive',
    });
    const m = new THREE.Mesh(geo, mat);
    m.userData.baseOpacity = opacity;
    return m;
  }

  private push(
    obj: THREE.Mesh,
    life: number,
    kind: Timed['kind'],
    blend: Blend,
    scaleTo?: number,
    drift?: { x: number; y: number; z: number },
    spin?: number,
  ): void {
    obj.userData.baseScale = obj.scale.x;
    this.scene.add(obj);
    this.active.push({
      obj,
      life,
      maxLife: life,
      kind,
      blend,
      scaleTo,
      drift: drift ? new THREE.Vector3(drift.x, drift.y, drift.z) : undefined,
      spin,
    });
  }

  dispose(): void {
    this.clear();
    this.sphere.dispose();
    this.cylinder.dispose();
    this.ring.dispose();
    this.puff.dispose();
    this.shard.dispose();
    for (const pool of Object.values(this.pools)) {
      for (const m of pool) (m.material as THREE.Material).dispose();
      pool.length = 0;
    }
  }
}

const UP = new THREE.Vector3(0, 1, 0);
const TMP_DIR = new THREE.Vector3();
