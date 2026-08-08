import * as CANNON from 'cannon-es';
import * as THREE from 'three';
import { SHOT_MASK } from '../physics/world';
import { damageAtRange } from './weapon';
import type { Arena, ProjectileSpawn } from '../game/types';

const MAX_LIFE = 6;

/**
 * Shells are ray-marched rather than simulated as rigid bodies: at 400 m/s a
 * physics body would tunnel through walls at any sane step size, and a swept
 * ray is both cheaper and exact. Range falloff is measured along the path
 * actually flown, so a ricochet that travels 90 m does 90 m worth of damage.
 */
export class Projectile {
  readonly spec: ProjectileSpawn;
  readonly pos: CANNON.Vec3;
  readonly vel: CANNON.Vec3;
  /** Position at the start of this step, so the renderer can draw a streak. */
  readonly previous: CANNON.Vec3;
  alive = true;
  travelled = 0;
  private life: number;
  private bounces: number;
  private readonly gravity: number;

  constructor(spec: ProjectileSpawn) {
    this.spec = spec;
    this.pos = spec.position.clone();
    this.previous = spec.position.clone();
    this.vel = spec.direction.clone();
    this.vel.normalize();
    this.vel.scale(spec.speed, this.vel);
    this.life = spec.maxLife ?? MAX_LIFE;
    this.bounces = spec.bounces ?? 0;
    this.gravity = spec.gravity ?? 0;
  }

  update(dt: number, arena: Arena): void {
    this.previous.copy(this.pos);
    this.life -= dt;
    if (this.life <= 0) {
      this.detonate(arena, this.pos.clone(), new CANNON.Vec3(0, 1, 0), null);
      return;
    }

    if (this.spec.homing) this.steer(dt);
    if (this.gravity) this.vel.y -= this.gravity * dt;

    let remaining = dt;
    let guard = 0;
    while (remaining > 1e-5 && this.alive && guard++ < 6) {
      const from = this.pos.clone();
      const step = this.vel.scale(remaining);
      const to = from.vadd(step);
      const hit = arena.phys.raycast(from, to, SHOT_MASK, this.spec.owner.vehicle.body);

      if (!hit) {
        this.travelled += step.length();
        this.pos.copy(to);
        return;
      }

      const target = arena.tankForBody(hit.body);
      this.travelled += hit.distance;

      if (target) {
        const friendly = !arena.areEnemies(this.spec.owner, target);
        const isOwner = target === this.spec.owner;
        const passThrough =
          (isOwner && !this.spec.selfDamage) ||
          (friendly && !isOwner && !arena.settings.friendlyFire && !this.spec.splash);
        if (passThrough) {
          // Nudge past the body and keep flying.
          this.pos.copy(hit.point);
          this.pos.vadd(this.vel.scale(0.05 / Math.max(1, this.vel.length())), this.pos);
          remaining -= hit.distance / Math.max(1e-4, this.vel.length());
          continue;
        }
        this.pos.copy(hit.point);
        this.detonate(arena, hit.point, hit.normal, target);
        return;
      }

      // World geometry: bounce if the shell has bounces left.
      if (this.bounces > 0) {
        this.bounces -= 1;
        this.pos.copy(hit.point);
        this.pos.vadd(hit.normal.scale(0.15), this.pos);
        const vn = hit.normal.scale(2 * this.vel.dot(hit.normal));
        this.vel.vsub(vn, this.vel);
        arena.fx.impact(hit.point, hit.normal, this.spec.colour, 0.5);
        remaining -= hit.distance / Math.max(1e-4, this.vel.length());
        continue;
      }

      this.pos.copy(hit.point);
      this.detonate(arena, hit.point, hit.normal, null);
      return;
    }
  }

  private steer(dt: number): void {
    const h = this.spec.homing!;
    if (!h.target.alive) return;
    const desired = h.target.centre().vsub(this.pos);
    const dist = desired.length();
    if (dist < 0.01) return;
    desired.scale(1 / dist, desired);

    const speed = this.vel.length();
    const dir = this.vel.scale(1 / Math.max(1e-4, speed));
    const maxTurn = h.turnRate * (Math.PI / 180) * dt;
    const dot = Math.min(1, Math.max(-1, dir.dot(desired)));
    const angle = Math.acos(dot);
    const t = angle > 1e-4 ? Math.min(1, maxTurn / angle) : 1;

    dir.lerp(desired, t, dir);
    dir.normalize();
    // Missiles accelerate rather than launching at full speed.
    const newSpeed = Math.min(h.maxSpeed, speed + h.acceleration * dt);
    dir.scale(newSpeed, this.vel);
  }

  private detonate(arena: Arena, point: CANNON.Vec3, normal: CANNON.Vec3, direct: Tank_ | null): void {
    this.alive = false;
    const s = this.spec;

    if (direct) {
      const dmg = damageAtRange(s.turret, s.damage, s.weakDamage, this.travelled);
      if (dmg > 0) {
        arena.damage(direct, dmg, s.owner, { kind: 'direct', critical: s.critical, at: point });
        const dir = this.vel.clone();
        dir.normalize();
        direct.vehicle.applyImpulse(dir, s.impactForce);
      }
    }

    if (s.splash) {
      const centreDamage = s.splash.damageMax ?? s.damage;
      arena.splash(point, s.splash.radius, centreDamage, s.splash.damageMin, s.owner, {
        selfDamage: s.selfDamage,
        impactForce: s.impactForce * 0.6,
        turret: s.turret,
      });
      arena.fx.explosion(point, s.splash.radius, s.colour);
    } else {
      arena.fx.impact(point, normal, s.colour);
    }
  }
}

// Structural alias to avoid a runtime import cycle with tank.ts.
type Tank_ = import('./tank').Tank;

/** Owns projectile simulation and their render proxies. */
export class ProjectileSystem {
  private readonly list: Projectile[] = [];
  private readonly meshes = new Map<Projectile, THREE.Mesh>();
  private readonly geometry = new THREE.SphereGeometry(1, 8, 6);
  private readonly materials = new Map<number, THREE.MeshBasicMaterial>();

  constructor(private readonly scene: THREE.Scene) {}

  spawn(spec: ProjectileSpawn): void {
    const p = new Projectile(spec);
    this.list.push(p);
    const mesh = new THREE.Mesh(this.geometry, this.material(spec.colour));
    mesh.scale.setScalar(spec.radius);
    mesh.position.set(p.pos.x, p.pos.y, p.pos.z);
    this.scene.add(mesh);
    this.meshes.set(p, mesh);
  }

  update(dt: number, arena: Arena): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.update(dt, arena);
      const mesh = this.meshes.get(p);
      if (!p.alive) {
        if (mesh) this.scene.remove(mesh);
        this.meshes.delete(p);
        this.list.splice(i, 1);
        continue;
      }
      if (mesh) mesh.position.set(p.pos.x, p.pos.y, p.pos.z);
      // A shell moving at 400 m/s covers seven metres a frame, so a bare sphere
      // reads as a stutter of dots. The streak between last frame's position and
      // this one is what makes a shot legible — and it is what the `trail` flag
      // on the spawn spec has always been asking for.
      if (p.spec.trail) {
        arena.fx.tracer(p.previous, p.pos, p.spec.colour, p.spec.radius * 0.75, 0.07);
        if (p.spec.homing || p.spec.gravity || p.spec.smokeTrail) {
          // Missiles and mortar bombs leave exhaust behind them.
          this.smokeTimer -= dt;
          if (this.smokeTimer <= 0) {
            this.smokeTimer = 0.045;
            arena.fx.smoke(p.pos, 0.3, 0.55, { x: 0, y: 1.4, z: 0 });
          }
        }
      }
    }
  }

  private smokeTimer = 0;

  get count(): number {
    return this.list.length;
  }

  clear(): void {
    for (const mesh of this.meshes.values()) this.scene.remove(mesh);
    this.meshes.clear();
    this.list.length = 0;
  }

  private material(colour: number): THREE.MeshBasicMaterial {
    let m = this.materials.get(colour);
    if (!m) {
      m = new THREE.MeshBasicMaterial({ color: colour, toneMapped: false });
      this.materials.set(colour, m);
    }
    return m;
  }

  dispose(): void {
    this.clear();
    this.geometry.dispose();
    for (const m of this.materials.values()) m.dispose();
  }
}
