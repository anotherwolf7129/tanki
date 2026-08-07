import * as CANNON from 'cannon-es';
import { DEG } from '../core/mathx';
import type { Arena } from '../game/types';
import type { Tank } from '../entities/tank';

export interface PerceptionConfig {
  fovDegrees: number;
  viewDistance: number;
  reactionDelayMs: number;
  memoryDurationMs: number;
  losCheck: boolean;
  hearsGunfireRadius: number;
}

export interface Track {
  tank: Tank;
  /** Where the bot believes the target is. Goes stale once contact is lost. */
  lastKnown: CANNON.Vec3;
  lastSeen: number;
  firstSeen: number;
  visible: boolean;
  /** Seconds of unbroken visual contact, which drives aim convergence. */
  timeOnTarget: number;
  actionable: boolean;
}

/**
 * Bots never read world state directly. Everything they know arrives through
 * here, which means difficulty is tuned at the sensor — reaction delay, field
 * of view, memory — rather than by nerfing their aim after the fact.
 */
export class Perception {
  private readonly tracks = new Map<number, Track>();
  private readonly origin = new CANNON.Vec3();
  private readonly delta = new CANNON.Vec3();

  constructor(
    private readonly self: Tank,
    readonly config: PerceptionConfig,
  ) {}

  update(arena: Arena, now: number): void {
    const cosFov = Math.cos(this.config.fovDegrees * 0.5 * DEG);
    this.self.turretOrigin(this.origin);
    const facing = this.self.aimDirection(new CANNON.Vec3());

    for (const other of arena.tanks) {
      if (other === this.self || !arena.areEnemies(this.self, other)) continue;

      let track = this.tracks.get(other.id);
      const centre = other.centre();
      other.centre(this.delta);
      this.delta.vsub(this.origin, this.delta);
      const dist = this.delta.length();

      let visible = other.alive && dist <= this.config.viewDistance;
      if (visible && dist > 0.01) {
        const dot = this.delta.scale(1 / dist).dot(facing);
        // Peripheral blindness is deliberate: flanking must always work.
        if (dot < cosFov) visible = false;
      }
      if (visible && this.config.losCheck) {
        visible = arena.phys.lineOfSight(this.origin, centre, this.self.vehicle.body);
      }
      // Hornet's sonar overrides every sensor limit for its duration.
      if (other.status.has('reveal')) visible = other.alive;
      // Gunfire nearby gives away a position even outside the view cone.
      if (!visible && other.alive && dist < this.config.hearsGunfireRadius && other.weapon.intent.fire) {
        visible = true;
      }

      if (!track) {
        if (!visible) continue;
        track = {
          tank: other,
          lastKnown: centre.clone(),
          lastSeen: now,
          firstSeen: now,
          visible: true,
          timeOnTarget: 0,
          actionable: false,
        };
        this.tracks.set(other.id, track);
      }

      if (visible) {
        if (!track.visible) track.firstSeen = now;
        track.visible = true;
        track.lastSeen = now;
        track.lastKnown.copy(centre);
        track.timeOnTarget += 1 / 10;
        // Reaction delay is the single biggest contributor to the felt skill gap.
        track.actionable = (now - track.firstSeen) * 1000 >= this.config.reactionDelayMs;
      } else {
        track.visible = false;
        track.timeOnTarget = 0;
        track.actionable = false;
        if ((now - track.lastSeen) * 1000 > this.config.memoryDurationMs) {
          this.tracks.delete(other.id);
        }
      }
    }

    for (const [id, track] of this.tracks) {
      if (!track.tank.alive) this.tracks.delete(id);
    }
  }

  get(id: number): Track | undefined {
    return this.tracks.get(id);
  }

  /** Targets the bot may act on right now — past its reaction delay. */
  actionable(): Track[] {
    const out: Track[] = [];
    for (const t of this.tracks.values()) if (t.actionable && t.tank.alive) out.push(t);
    return out;
  }

  remembered(): Track[] {
    return [...this.tracks.values()].filter((t) => t.tank.alive);
  }

  forget(id: number): void {
    this.tracks.delete(id);
  }
}
