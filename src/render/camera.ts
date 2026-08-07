import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { clamp, damp } from '../core/mathx';
import { WORLD_MASK, type PhysicsWorld } from '../physics/world';
import type { Tank } from '../entities/tank';

const BASE_FOV = 72;

/**
 * Third-person chase camera, matching the reference. It orbits the aim yaw
 * rather than the hull yaw, so the turret always points at screen centre —
 * that coupling is what makes mouse aim feel direct despite the turret
 * physically lagging behind.
 */
export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;
  private distance = 13;
  private targetDistance = 13;
  private boomDistance = 13;
  private elevation = 0.32;
  private readonly smoothed = new THREE.Vector3();
  private firstPerson = false;
  private shakeSeed = Math.random() * 100;

  constructor(
    aspect: number,
    private readonly phys: PhysicsWorld,
  ) {
    this.camera = new THREE.PerspectiveCamera(BASE_FOV, aspect, 0.2, 2000);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  toggleFirstPerson(): boolean {
    this.firstPerson = !this.firstPerson;
    return this.firstPerson;
  }

  get isFirstPerson(): boolean {
    return this.firstPerson;
  }

  zoom(delta: number): void {
    this.targetDistance = clamp(this.targetDistance + delta * 1.6, 7, 26);
  }

  update(dt: number, tank: Tank, shake: number, scopeFov: number | null): void {
    const targetFov = scopeFov ?? (this.firstPerson ? BASE_FOV - 6 : BASE_FOV);
    if (Math.abs(this.camera.fov - targetFov) > 0.05) {
      this.camera.fov += (targetFov - this.camera.fov) * damp(scopeFov ? 14 : 9, dt);
      this.camera.updateProjectionMatrix();
    }

    const focus = new THREE.Vector3(tank.position.x, tank.position.y, tank.position.z);
    focus.y += tank.hull.turretMountHeight * 0.6 + 0.6;
    this.smoothed.lerp(focus, damp(18, dt));

    const yaw = tank.turretYaw;
    const pitch = tank.turretPitch;

    if (this.firstPerson || scopeFov != null) {
      // Sit at the mantlet looking down the barrel.
      const dir = new THREE.Vector3(
        Math.sin(yaw) * Math.cos(pitch),
        Math.sin(pitch),
        Math.cos(yaw) * Math.cos(pitch),
      );
      const eye = this.smoothed.clone().addScaledVector(dir, 1.1);
      eye.y += 0.35;
      this.camera.position.copy(eye);
      this.camera.lookAt(eye.clone().add(dir));
    } else {
      this.distance += (this.targetDistance - this.distance) * damp(6, dt);
      const baseElevation = clamp(0.32 - pitch * 0.75, 0.06, 1.05);

      // When geometry blocks the chase position, climb over it rather than
      // jamming the camera into the hull. Simply shortening the boom until it
      // clears fills the screen with your own tank on any map with cover; only
      // if every elevation is blocked do we fall back to pulling in.
      const from = new CANNON.Vec3(this.smoothed.x, this.smoothed.y, this.smoothed.z);
      const back = new THREE.Vector3();
      let dist = this.distance;
      let bestDist = 0;
      let bestElevation = baseElevation;

      for (let i = 0; i < 4; i++) {
        const elevation = Math.min(1.1, baseElevation + i * 0.18);
        setBoom(back, yaw, elevation);
        const to = new CANNON.Vec3(
          this.smoothed.x + back.x * dist,
          this.smoothed.y + back.y * dist,
          this.smoothed.z + back.z * dist,
        );
        const hit = this.phys.raycast(from, to, WORLD_MASK, tank.vehicle.body);
        if (!hit) {
          bestDist = dist;
          bestElevation = elevation;
          break;
        }
        const clear = hit.distance - 0.7;
        if (clear > bestDist) {
          bestDist = clear;
          bestElevation = elevation;
        }
      }

      // Ease into the chosen boom. Snapping between elevations as cover comes
      // and goes reads as the camera flinching; easing reads as a crane.
      this.elevation += (bestElevation - this.elevation) * damp(7, dt);
      this.boomDistance += (Math.max(3.2, bestDist) - this.boomDistance) * damp(14, dt);

      setBoom(back, yaw, this.elevation);
      this.camera.position.copy(this.smoothed).addScaledVector(back, this.boomDistance);
      this.camera.lookAt(this.smoothed.x, this.smoothed.y + 0.6, this.smoothed.z);
    }

    if (shake > 0.001) {
      this.shakeSeed += dt * 45;
      const a = shake * 0.35;
      this.camera.position.x += Math.sin(this.shakeSeed * 1.7) * a;
      this.camera.position.y += Math.sin(this.shakeSeed * 2.3) * a;
      this.camera.position.z += Math.cos(this.shakeSeed * 1.9) * a;
    }
  }

  /** Where the player is aiming, resolved against world geometry. */
  aimPoint(tank: Tank, maxRange = 400): CANNON.Vec3 {
    const origin = tank.muzzle(new CANNON.Vec3());
    const dir = tank.aimDirection(new CANNON.Vec3());
    const to = origin.vadd(dir.scale(maxRange));
    const hit = this.phys.raycast(origin, to, WORLD_MASK, tank.vehicle.body);
    return hit ? hit.point : to;
  }
}

/** Unit vector from the focus point back to the camera, for a yaw and elevation. */
function setBoom(out: THREE.Vector3, yaw: number, elevation: number): void {
  const c = Math.cos(elevation);
  out.set(-Math.sin(yaw) * c, Math.sin(elevation), -Math.cos(yaw) * c);
}
