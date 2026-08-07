import * as CANNON from 'cannon-es';
import * as THREE from 'three';
import { SUPPLY_ORDER } from '../data/supplies';
import type { Arena } from './types';
import type { Tank } from '../entities/tank';

interface TimedBomb {
  owner: Tank;
  pos: CANNON.Vec3;
  timer: number;
  radius: number;
  damage: number;
  mesh: THREE.Mesh;
}

interface Dome {
  owner: Tank;
  pos: CANNON.Vec3;
  radius: number;
  remaining: number;
  reduction: number;
  mesh: THREE.Mesh;
}

interface Rampage {
  owner: Tank;
  remaining: number;
  damage: number;
  speed: number;
}

/**
 * The hull ultimates. Each is the biggest differentiator between hulls, so
 * they are implemented as real world effects rather than stat buffs wherever
 * the reference describes something spatial.
 */
export class OverdriveSystem {
  private readonly bombs: TimedBomb[] = [];
  private readonly domes: Dome[] = [];
  private readonly rampages: Rampage[] = [];
  private readonly bombGeo = new THREE.IcosahedronGeometry(1.3, 0);
  private readonly domeGeo = new THREE.SphereGeometry(1, 18, 12);

  constructor(private readonly scene: THREE.Scene) {}

  /** Returns false when the ultimate could not be used. */
  activate(tank: Tank, arena: Arena): boolean {
    if (!tank.alive || tank.overdriveCharge < 100) return false;
    const od = tank.hull.overdrive;
    tank.overdriveCharge = 0;
    tank.overdriveActive = od.duration ?? 1.5;
    arena.fx.supplyBurst(tank.position, 0xffffff, 2.6);
    if (tank.isPlayer) arena.notify(`${od.displayName}!`, 'info');

    switch (od.effect) {
      case 'timedBomb':
        this.placeBomb(tank, od.radius ?? 14, od.damage ?? 2600, od.delay ?? 3);
        break;
      case 'revealEnemies':
        for (const t of arena.tanks) {
          if (arena.areEnemies(tank, t)) t.status.apply('reveal', 1, od.duration ?? 12, tank.id);
        }
        arena.notify(`${tank.name} lit up the battlefield`, 'warning');
        break;
      case 'launchAndStun': {
        tank.vehicle.applyImpulse(new CANNON.Vec3(0, 1, 0), od.launchImpulse ?? 18);
        const radius = od.radius ?? 12;
        for (const t of arena.tanks) {
          if (t === tank || !t.alive || !arena.areEnemies(tank, t)) continue;
          if (t.position.distanceTo(tank.position) > radius) continue;
          arena.damage(t, od.damage ?? 500, tank, { kind: 'overdrive' });
          t.status.apply('stun', 1, od.duration ?? 2, tank.id);
          t.status.apply('burning', 40, 4, tank.id);
        }
        arena.fx.explosion(tank.position, radius, 0xff7a2f);
        break;
      }
      case 'disarm': {
        const radius = od.radius ?? 20;
        for (const t of arena.tanks) {
          if (!t.alive || !arena.areEnemies(tank, t)) continue;
          if (t.position.distanceTo(tank.position) > radius) continue;
          t.status.apply('emp', 1, od.duration ?? 4, tank.id);
        }
        arena.fx.supplyBurst(tank.position, 0x818cf8, radius * 0.5);
        break;
      }
      case 'piercingFreeze': {
        const dir = tank.aimDirection(new CANNON.Vec3());
        arena.spawnProjectile({
          owner: tank,
          turret: tank.turretDef,
          position: tank.muzzle(new CANNON.Vec3()),
          direction: dir,
          speed: 160,
          damage: od.damage ?? 900,
          weakDamage: od.damage ?? 900,
          impactForce: 1.4,
          selfDamage: false,
          colour: 0x7dd3fc,
          radius: 0.5,
          maxLife: 4,
        });
        // The freeze rides along with the shot: applied on contact below.
        this.pendingFreeze.push({ owner: tank, duration: od.duration ?? 5, until: arena.time + 4 });
        break;
      }
      case 'supercharge':
        tank.status.apply('supercharge', od.fireRateMultiplier ?? 2.4, od.duration ?? 10, tank.id);
        break;
      case 'grantAllSupplies': {
        const radius = od.radius ?? 24;
        for (const t of arena.tanks) {
          if (!t.alive || !arena.areAllies(tank, t)) continue;
          if (t.position.distanceTo(tank.position) > radius) continue;
          // Applies the effects without consuming anyone's actual supplies.
          for (const kind of SUPPLY_ORDER) {
            if (kind === 'mine') continue;
            t.applySupply(kind, arena);
          }
        }
        break;
      }
      case 'chainDamageHeal': {
        const radius = od.radius ?? 18;
        let jumps = od.jumps ?? 3;
        const hit = new Set<Tank>([tank]);
        let current: Tank = tank;
        const points: CANNON.Vec3[] = [];
        while (jumps-- > 0) {
          const next = arena.tanks
            .filter((t) => t.alive && !hit.has(t) && t.position.distanceTo(current.position) <= radius)
            .sort((a, b) => a.position.distanceTo(current.position) - b.position.distanceTo(current.position))[0];
          if (!next) break;
          hit.add(next);
          points.push(next.centre());
          if (arena.areEnemies(tank, next)) arena.damage(next, od.damage ?? 700, tank, { kind: 'overdrive' });
          else arena.heal(next, od.heal ?? 900, tank);
          current = next;
        }
        arena.fx.chain(tank.muzzle(), points, 0x93c5fd);
        break;
      }
      case 'protectiveDome':
        this.placeDome(tank, od.radius ?? 14, od.duration ?? 12, od.damageReduction ?? 0.6);
        break;
      case 'contactKillField':
        this.rampages.push({
          owner: tank,
          remaining: od.duration ?? 10,
          damage: od.contactDamage ?? 4000,
          speed: od.speedMultiplier ?? 1.7,
        });
        tank.status.apply('nitro', 1, od.duration ?? 10, tank.id);
        break;
      case 'healAndRepel': {
        arena.heal(tank, tank.maxHealth * (od.healFraction ?? 1), tank);
        const radius = od.radius ?? 24;
        for (const t of arena.tanks) {
          if (t === tank || !t.alive || !arena.areEnemies(tank, t)) continue;
          const delta = t.position.vsub(tank.position);
          const d = delta.length();
          if (d > radius || d < 0.01) continue;
          delta.scale(1 / d, delta);
          delta.y = 0.55;
          t.vehicle.applyImpulse(delta, od.launchImpulse ?? 24);
        }
        arena.fx.explosion(tank.position, radius, 0xfacc15);
        break;
      }
    }
    return true;
  }

  private readonly pendingFreeze: { owner: Tank; duration: number; until: number }[] = [];

  /** Called by the battle when a Crusader icicle connects. */
  freezeRiderFor(owner: Tank, now: number): number | null {
    const idx = this.pendingFreeze.findIndex((f) => f.owner === owner && f.until > now);
    if (idx < 0) return null;
    const duration = this.pendingFreeze[idx].duration;
    this.pendingFreeze.splice(idx, 1);
    return duration;
  }

  private placeBomb(owner: Tank, radius: number, damage: number, delay: number): void {
    const mat = new THREE.MeshStandardMaterial({ color: 0xff4d4d, emissive: 0xff4d4d, emissiveIntensity: 0.8 });
    const mesh = new THREE.Mesh(this.bombGeo, mat);
    const pos = owner.position.clone();
    pos.y += 0.4;
    mesh.position.set(pos.x, pos.y, pos.z);
    this.scene.add(mesh);
    this.bombs.push({ owner, pos, timer: delay, radius, damage, mesh });
  }

  private placeDome(owner: Tank, radius: number, duration: number, reduction: number): void {
    const mat = new THREE.MeshBasicMaterial({
      color: 0x7dd3fc,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(this.domeGeo, mat);
    mesh.scale.setScalar(radius);
    const pos = owner.position.clone();
    mesh.position.set(pos.x, pos.y, pos.z);
    this.scene.add(mesh);
    this.domes.push({ owner, pos, radius, remaining: duration, reduction, mesh });
  }

  update(dt: number, arena: Arena): void {
    for (let i = this.bombs.length - 1; i >= 0; i--) {
      const b = this.bombs[i];
      b.timer -= dt;
      const pulse = 1 + Math.sin(b.timer * 18) * 0.25;
      b.mesh.scale.setScalar(pulse);
      if (b.timer > 0) continue;
      arena.splash(b.pos, b.radius, b.damage, b.damage * 0.35, b.owner, {
        selfDamage: false,
        impactForce: 3.0,
      });
      arena.fx.explosion(b.pos, b.radius, 0xff4d4d);
      this.scene.remove(b.mesh);
      (b.mesh.material as THREE.Material).dispose();
      this.bombs.splice(i, 1);
    }

    // Domes reduce damage for their owner's team while inside.
    for (const t of arena.tanks) t.damageReduction = 0;
    for (let i = this.domes.length - 1; i >= 0; i--) {
      const d = this.domes[i];
      d.remaining -= dt;
      if (d.remaining <= 0) {
        this.scene.remove(d.mesh);
        (d.mesh.material as THREE.Material).dispose();
        this.domes.splice(i, 1);
        continue;
      }
      (d.mesh.material as THREE.MeshBasicMaterial).opacity = 0.1 + 0.08 * Math.sin(arena.time * 3);
      for (const t of arena.tanks) {
        if (!t.alive || !arena.areAllies(d.owner, t)) continue;
        if (t.position.distanceTo(d.pos) <= d.radius) t.damageReduction = Math.max(t.damageReduction, d.reduction);
      }
    }

    for (let i = this.rampages.length - 1; i >= 0; i--) {
      const r = this.rampages[i];
      r.remaining -= dt;
      r.owner.contactDamage = r.remaining > 0 ? r.damage : 0;
      if (r.remaining <= 0) {
        this.rampages.splice(i, 1);
        continue;
      }
      for (const t of arena.tanks) {
        if (t === r.owner || !t.alive || !arena.areEnemies(r.owner, t)) continue;
        const reach = (r.owner.hull.size[2] + t.hull.size[2]) * 0.6;
        if (r.owner.position.distanceTo(t.position) > reach) continue;
        arena.damage(t, r.damage, r.owner, { kind: 'contact' });
      }
    }
  }

  /** Rampage also drives through mines; the battle wires this to MineSystem. */
  activeRampages(): { pos: CANNON.Vec3; radius: number }[] {
    return this.rampages.map((r) => ({ pos: r.owner.position, radius: r.owner.hull.size[2] }));
  }

  clearFor(tank: Tank): void {
    for (let i = this.rampages.length - 1; i >= 0; i--) {
      if (this.rampages[i].owner === tank) {
        tank.contactDamage = 0;
        this.rampages.splice(i, 1);
      }
    }
  }

  dispose(): void {
    for (const b of this.bombs) {
      this.scene.remove(b.mesh);
      (b.mesh.material as THREE.Material).dispose();
    }
    for (const d of this.domes) {
      this.scene.remove(d.mesh);
      (d.mesh.material as THREE.Material).dispose();
    }
    this.bombs.length = 0;
    this.domes.length = 0;
    this.rampages.length = 0;
    this.bombGeo.dispose();
    this.domeGeo.dispose();
  }
}
