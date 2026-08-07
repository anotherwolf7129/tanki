import * as THREE from 'three';
import type * as CANNON from 'cannon-es';

interface Timed {
  obj: THREE.Object3D;
  life: number;
  maxLife: number;
  kind: 'fade' | 'expand' | 'tracer';
  scaleTo?: number;
}

/**
 * Pooled transient visuals. Everything is additive and unlit so effects read
 * clearly against any map theme, and nothing here allocates per-frame once the
 * pools are warm.
 */
export class Effects {
  private readonly active: Timed[] = [];
  private readonly pool: THREE.Mesh[] = [];

  private readonly sphere = new THREE.SphereGeometry(1, 10, 8);
  private readonly cylinder = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
  private readonly ring = new THREE.RingGeometry(0.75, 1, 22);

  readonly damageNumbers: { text: string; world: THREE.Vector3; life: number; colour: string }[] = [];
  /** Screen-shake amplitude, consumed by the camera. */
  shake = 0;

  constructor(private readonly scene: THREE.Scene) {}

  muzzleFlash(pos: CANNON.Vec3, dir: CANNON.Vec3, colour: number): void {
    const m = this.take(this.sphere, colour, 0.85);
    m.position.set(pos.x + dir.x * 0.4, pos.y + dir.y * 0.4, pos.z + dir.z * 0.4);
    m.scale.setScalar(0.55);
    this.push(m, 0.07, 'fade');
  }

  impact(pos: CANNON.Vec3, normal: CANNON.Vec3, colour: number, scale = 1): void {
    const m = this.take(this.sphere, colour, 0.9);
    m.position.set(pos.x, pos.y, pos.z);
    m.scale.setScalar(0.35 * scale);
    this.push(m, 0.16, 'expand', 1.9 * scale);

    const r = this.take(this.ring, colour, 0.55);
    r.position.set(pos.x + normal.x * 0.05, pos.y + normal.y * 0.05, pos.z + normal.z * 0.05);
    r.lookAt(pos.x + normal.x, pos.y + normal.y, pos.z + normal.z);
    r.scale.setScalar(0.6 * scale);
    this.push(r, 0.22, 'expand', 2.6 * scale);
  }

  explosion(pos: CANNON.Vec3, radius: number, colour: number): void {
    const core = this.take(this.sphere, colour, 0.75);
    core.position.set(pos.x, pos.y, pos.z);
    core.scale.setScalar(radius * 0.3);
    this.push(core, 0.3, 'expand', 2.2);

    const shock = this.take(this.ring, 0xffffff, 0.45);
    shock.position.set(pos.x, pos.y + 0.2, pos.z);
    shock.rotation.x = -Math.PI / 2;
    shock.scale.setScalar(radius * 0.4);
    this.push(shock, 0.4, 'expand', 2.6);

    this.shake = Math.min(1.6, this.shake + radius * 0.05);
  }

  tracer(from: CANNON.Vec3, to: CANNON.Vec3, colour: number, radius = 0.08, life = 0.12): void {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.01) return;
    const m = this.take(this.cylinder, colour, 0.8);
    m.position.set(from.x + dx / 2, from.y + dy / 2, from.z + dz / 2);
    m.scale.set(radius, len, radius);
    m.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(dx / len, dy / len, dz / len),
    );
    this.push(m, life, 'tracer');
  }

  chain(from: CANNON.Vec3, points: CANNON.Vec3[], colour: number): void {
    let prev = from;
    for (const p of points) {
      this.tracer(prev, p, colour, 0.09, 0.1);
      prev = p;
    }
  }

  supplyBurst(pos: CANNON.Vec3, colour: number, scale = 1): void {
    const r = this.take(this.ring, colour, 0.7);
    r.position.set(pos.x, pos.y + 0.6, pos.z);
    r.rotation.x = -Math.PI / 2;
    r.scale.setScalar(1.4 * scale);
    this.push(r, 0.45, 'expand', 3.2);
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
      const mat = (t.obj as THREE.Mesh).material as THREE.MeshBasicMaterial;
      if (t.kind === 'expand' && t.scaleTo) {
        const grow = 1 + (t.scaleTo - 1) * (1 - k);
        t.obj.scale.setScalar((t.obj.userData.baseScale as number) * grow);
      }
      mat.opacity = (t.obj.userData.baseOpacity as number) * (t.kind === 'tracer' ? k * k : k);
      if (t.life <= 0) {
        this.scene.remove(t.obj);
        this.pool.push(t.obj as THREE.Mesh);
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
      this.pool.push(t.obj as THREE.Mesh);
    }
    this.active.length = 0;
    this.damageNumbers.length = 0;
  }

  private take(geo: THREE.BufferGeometry, colour: number, opacity: number): THREE.Mesh {
    const mesh = this.pool.pop();
    if (mesh) {
      mesh.geometry = geo;
      const mat = mesh.material as THREE.MeshBasicMaterial;
      mat.color.setHex(colour);
      mat.opacity = opacity;
      mesh.userData.baseOpacity = opacity;
      mesh.visible = true;
      mesh.rotation.set(0, 0, 0);
      mesh.quaternion.identity();
      return mesh;
    }
    const mat = new THREE.MeshBasicMaterial({
      color: colour,
      transparent: true,
      opacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const m = new THREE.Mesh(geo, mat);
    m.userData.baseOpacity = opacity;
    return m;
  }

  private push(obj: THREE.Mesh, life: number, kind: Timed['kind'], scaleTo?: number): void {
    obj.userData.baseScale = obj.scale.x;
    this.scene.add(obj);
    this.active.push({ obj, life, maxLife: life, kind, scaleTo });
  }

  dispose(): void {
    this.clear();
    this.sphere.dispose();
    this.cylinder.dispose();
    this.ring.dispose();
    for (const m of this.pool) (m.material as THREE.Material).dispose();
    this.pool.length = 0;
  }
}
