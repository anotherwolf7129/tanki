import * as CANNON from 'cannon-es';
import type { HullDef } from '../data/schema';
import { clamp } from '../core/mathx';
import { LAYER, PhysicsWorld, WORLD_MASK } from './world';

export interface DriveCommand {
  /** -1 reverse .. +1 forward */
  forward: number;
  /** -1 left .. +1 right */
  turn: number;
  /** Multiplier on top speed and acceleration, from nitro/overdrive/freeze. */
  speedScale: number;
  /** Set while a scoped weapon locks the hull in place. */
  locked: boolean;
}

const UP = new CANNON.Vec3(0, 1, 0);
const SELF_RIGHT_DELAY = 3.0;

/**
 * Arcade tank controller. The body is a genuine rigid box, so tanks flip,
 * get shoved by impact force and kicked by recoil — the three things the
 * reference feel depends on. Drive authority is applied as forces at the
 * centre of mass rather than per-wheel, which is stable at 60 Hz and needs
 * no suspension tuning.
 */
export class VehicleController {
  readonly body: CANNON.Body;
  private groundNormal = new CANNON.Vec3(0, 1, 0);
  private grounded = false;
  private invertedFor = 0;
  private readonly halfHeight: number;

  constructor(
    private readonly phys: PhysicsWorld,
    readonly hull: HullDef,
    position: CANNON.Vec3,
    yaw: number,
  ) {
    const [w, h, d] = hull.size;
    this.halfHeight = h / 2;
    const shape = new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2));
    this.body = new CANNON.Body({
      mass: hull.mass,
      shape,
      position: position.clone(),
      material: hull.hover ? phys.slickMaterial : phys.tankMaterial,
      linearDamping: hull.hover ? 0.25 : 0.08,
      angularDamping: hull.hover ? 0.85 : 0.45,
      collisionFilterGroup: LAYER.TANK,
      collisionFilterMask: -1,
      allowSleep: false,
    });
    this.body.quaternion.setFromEuler(0, yaw, 0);
    // A tank is far harder to spin than a uniform box of the same mass.
    this.body.updateMassProperties();
    this.body.inertia.scale(2.2, this.body.inertia);
    this.body.invInertia.scale(1 / 2.2, this.body.invInertia);
    this.body.updateInertiaWorld(true);
    phys.world.addBody(this.body);
  }

  dispose(): void {
    this.phys.world.removeBody(this.body);
  }

  get isGrounded(): boolean {
    return this.grounded;
  }

  get position(): CANNON.Vec3 {
    return this.body.position;
  }

  get speed(): number {
    return this.body.velocity.length();
  }

  forwardVector(out = new CANNON.Vec3()): CANNON.Vec3 {
    return this.body.quaternion.vmult(new CANNON.Vec3(0, 0, 1), out);
  }

  rightVector(out = new CANNON.Vec3()): CANNON.Vec3 {
    return this.body.quaternion.vmult(new CANNON.Vec3(1, 0, 0), out);
  }

  upVector(out = new CANNON.Vec3()): CANNON.Vec3 {
    return this.body.quaternion.vmult(new CANNON.Vec3(0, 1, 0), out);
  }

  get yaw(): number {
    const f = this.forwardVector();
    return Math.atan2(f.x, f.z);
  }

  /** Roof-down for long enough that the driver has lost control. */
  get isInverted(): boolean {
    return this.upVector().dot(UP) < 0.15;
  }

  teleport(pos: CANNON.Vec3, yaw: number): void {
    this.body.position.copy(pos);
    this.body.velocity.setZero();
    this.body.angularVelocity.setZero();
    this.body.quaternion.setFromEuler(0, yaw, 0);
    this.body.wakeUp();
    this.invertedFor = 0;
  }

  applyImpulse(dir: CANNON.Vec3, magnitude: number): void {
    const scale = this.hull.recoilResistance != null ? 1 - this.hull.recoilResistance * 0.6 : 1;
    // Impulses are authored in "per tonne" units so light hulls really do flip.
    const impulse = dir.scale(magnitude * scale * 1000);
    // Applied slightly above centre so a hard hit rolls the tank rather than
    // sliding it, which is what makes Railgun and Shaft read as heavy.
    const offset = new CANNON.Vec3(0, this.halfHeight * 0.6, 0);
    this.body.applyImpulse(impulse, offset);
    this.body.wakeUp();
  }

  /**
   * Traction is synthesised rather than simulated. The body still resolves
   * collisions, gravity, recoil impulses and flipping as a real rigid body, but
   * drive, braking and turning act directly on velocity, rate-limited by the
   * hull's acceleration figures. That is the only way a box-on-a-plane tank
   * moves at all: a force at the centre of mass loses to contact friction long
   * before it reaches a usable magnitude.
   */
  update(dt: number, cmd: DriveCommand): void {
    this.probeGround();
    this.handleInversion(dt, false);

    if (this.hull.hover) this.updateHover(dt);

    const speedScale = Math.max(0.05, cmd.speedScale);
    const boosted = speedScale > 1.05;
    const topSpeed = this.hull.topSpeed * speedScale;

    const fwd = this.forwardVector();
    if (!this.hull.hover) {
      // Project drive onto the surface so slopes are climbed, not fought.
      fwd.vsub(this.groundNormal.scale(fwd.dot(this.groundNormal)), fwd);
      if (fwd.lengthSquared() > 1e-6) fwd.normalize();
    } else {
      fwd.y = 0;
      if (fwd.lengthSquared() > 1e-6) fwd.normalize();
    }

    const canDrive = (this.grounded || this.hull.hover) && !cmd.locked && !this.isInverted;
    const vel = this.body.velocity;
    const alongSpeed = vel.dot(fwd);

    if (canDrive) {
      const target = cmd.forward * topSpeed;
      let rate: number;
      if (cmd.forward === 0) {
        // Engine braking: releasing the stick should stop you, not coast.
        rate = this.hull.acceleration * 0.85;
      } else if (Math.sign(target) !== Math.sign(alongSpeed) && Math.abs(alongSpeed) > 0.3) {
        // Anti-inertial braking when reversing direction.
        rate = this.hull.reverseAcceleration;
      } else {
        rate = boosted ? this.hull.nitroAcceleration : this.hull.acceleration;
      }
      const budget = rate * dt;
      const delta = clamp(target - alongSpeed, -budget, budget);
      vel.vadd(fwd.scale(delta), vel);
    }

    if (canDrive) {
      const turnRate = this.hull.turnSpeed * (Math.PI / 180) * speedScale;
      // Tracked vehicles turn hardest when nearly stopped.
      const authority = 1 - 0.35 * clamp(Math.abs(alongSpeed) / this.hull.topSpeed, 0, 1);
      const target = cmd.turn * turnRate * authority;
      const current = this.body.angularVelocity.y;
      const budget = turnRate * 5 * dt;
      this.body.angularVelocity.y = current + clamp(target - current, -budget, budget);
    } else if (this.grounded || this.hull.hover) {
      this.body.angularVelocity.y *= 1 - Math.min(1, dt * 6);
    }

    if (canDrive || this.grounded) this.applyLateralGrip(dt, speedScale);
    if (canDrive && !this.hull.hover) this.applySlopeGrip(dt);
    this.clampTopSpeed(topSpeed);
    this.body.wakeUp();
  }

  /**
   * Cancels the downhill component of gravity while the tracks are on a
   * drivable surface. Without it, zero contact friction means every hull slides
   * off ramps and the heavier ones cannot climb at all — their acceleration is
   * lower than gravity's pull along a 25° slope.
   */
  private applySlopeGrip(dt: number): void {
    const n = this.groundNormal;
    if (n.y < 0.5) return; // near-vertical faces are not climbable
    const g = this.phys.world.gravity;
    const tangential = g.vsub(n.scale(g.dot(n)));
    this.body.velocity.vsub(tangential.scale(Math.min(dt, 0.05)), this.body.velocity);
  }

  /** Manual flip key: an upward kick plus roll torque, as in the original. */
  requestFlip(): boolean {
    if (!this.isInverted && this.upVector().dot(UP) > 0.55) return false;
    this.body.applyImpulse(new CANNON.Vec3(0, this.body.mass * 5.5, 0));
    const roll = this.forwardVector().scale(this.body.mass * 4.5);
    this.body.angularVelocity.vadd(roll.scale(1 / this.body.mass), this.body.angularVelocity);
    this.invertedFor = 0;
    return true;
  }

  private handleInversion(dt: number, force: boolean): void {
    if (!this.isInverted && !force) {
      this.invertedFor = 0;
      return;
    }
    this.invertedFor += dt;
    if (this.invertedFor >= SELF_RIGHT_DELAY) {
      // Recovery, not a physics puzzle: put the hull back on its tracks.
      const yaw = this.yaw;
      this.body.quaternion.setFromEuler(0, yaw, 0);
      this.body.position.y += this.halfHeight + 0.3;
      this.body.angularVelocity.setZero();
      this.body.velocity.scale(0.2, this.body.velocity);
      this.invertedFor = 0;
    }
  }

  private probeGround(): void {
    const from = this.body.position.clone();
    const reach = this.halfHeight + (this.hull.hover ? (this.hull.hoverHeight ?? 1.2) + 0.6 : 0.45);
    const to = new CANNON.Vec3(from.x, from.y - reach, from.z);
    const hit = this.phys.raycast(from, to, WORLD_MASK, this.body);
    this.grounded = hit !== null;
    this.groundNormal = hit ? hit.normal.clone() : new CANNON.Vec3(0, 1, 0);
    if (this.groundNormal.y < 0) this.groundNormal.negate(this.groundNormal);
  }

  /** Raycast suspension: holds the hull at a fixed altitude over any terrain. */
  private updateHover(dt: number): void {
    const target = this.hull.hoverHeight ?? 1.2;
    const from = this.body.position.clone();
    const to = new CANNON.Vec3(from.x, from.y - (this.halfHeight + target + 1.2), from.z);
    const hit = this.phys.raycast(from, to, WORLD_MASK, this.body);
    if (hit) {
      const gap = hit.distance - this.halfHeight;
      const error = target - gap;
      const spring = error * 55 - this.body.velocity.y * 9;
      this.body.applyForce(new CANNON.Vec3(0, clamp(spring, -30, 90) * this.body.mass * 0.35, 0));
    }
    // Hover hulls stay level; that is why they are stable gun platforms.
    const up = this.upVector();
    const correction = up.cross(UP).scale(this.body.mass * 0.9);
    this.body.angularVelocity.x += (correction.x / this.body.mass) * dt * 26;
    this.body.angularVelocity.z += (correction.z / this.body.mass) * dt * 26;
    this.body.angularVelocity.x *= 1 - Math.min(1, dt * 4);
    this.body.angularVelocity.z *= 1 - Math.min(1, dt * 4);
  }

  /**
   * Kills sideways velocity at a rate set by `lateralAcceleration`. Low values
   * leave the hull drifting, which is exactly what Hornet is supposed to do.
   */
  private applyLateralGrip(dt: number, speedScale: number): void {
    const right = this.rightVector();
    right.y = 0;
    if (right.lengthSquared() < 1e-6) return;
    right.normalize();
    const lateral = this.body.velocity.dot(right);
    if (Math.abs(lateral) < 0.01) return;
    const maxDelta = this.hull.lateralAcceleration * dt * speedScale;
    const delta = clamp(-lateral, -maxDelta, maxDelta);
    this.body.velocity.vadd(right.scale(delta), this.body.velocity);
  }

  private clampTopSpeed(topSpeed: number): void {
    const v = this.body.velocity;
    const horizontal = Math.hypot(v.x, v.z);
    const limit = topSpeed * 1.35; // headroom so impacts and ramps still launch you
    if (horizontal > limit) {
      const k = limit / horizontal;
      v.x *= k;
      v.z *= k;
    }
  }
}
