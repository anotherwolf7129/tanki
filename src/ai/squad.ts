import type * as CANNON from 'cannon-es';
import { CALL_GAP, CALL_TOPIC_GAP } from '../data/raid';
import type { Notification } from '../game/types';
import type { Tank } from '../entities/tank';

/**
 * The squad channel: shared, short-lived knowledge the raid can act on, plus
 * the radio traffic that makes acting on it legible.
 *
 * The team blackboard next door is deliberately shallow — claims and target
 * calls, enough to stop two bots racing for the same box — because in a line
 * battle emergent coordination reads better than scripted squad play. A boss
 * fight is the one place that is not true. Everything dangerous in a raid is a
 * *shared* problem on a timer: a ring on the ground everyone has to be out of
 * in 1.1 seconds, a hunt only somebody else can break, a building about to fall
 * across the street. None of that is discoverable by a bot looking at its own
 * perception, and a squad that cannot see it is a squad that stands in it.
 *
 * Two rules keep this from becoming a puppet show:
 *
 * - **Nothing here is knowledge the player does not also have.** Every zone in
 *   this channel is something already drawn on the ground or announced in the
 *   feed. The squad is not being told where the player is or what the boss will
 *   do next; it is being allowed to notice what the raid was already shown.
 * - **Every line is an action.** A squadmate says "moving" because it is
 *   moving and "breaking it off you" because four guns are turning round. Radio
 *   that narrates rather than commits is noise, and noise in the kill feed is
 *   worse than silence — it buries the boss's own warnings.
 */

export interface DangerZone {
  x: number;
  z: number;
  radius: number;
  /** Arena time at which this resolves, one way or the other. */
  until: number;
  label: string;
}

/** Where a bot should be instead. Consumed by the bot's evade steering. */
export interface Escape {
  x: number;
  z: number;
}

export class SquadChannel {
  private readonly zones: DangerZone[] = [];
  private readonly topicAt = new Map<string, number>();
  private lastCallAt = -99;

  /** The Overseer, so a rescuing squadmate knows what to shoot. */
  boss: Tank | null = null;
  /** An ally being hunted, who the rest of the squad can pull the boss off. */
  rescue: Tank | null = null;
  /** Calls made this battle — a harness number, and a cheap noise check. */
  calls = 0;

  constructor(
    private readonly now: () => number,
    private readonly emit: (text: string, kind: Notification['kind']) => void,
  ) {}

  // ---- danger -----------------------------------------------------------

  /**
   * Ground that is about to be hit. Zones are refreshed rather than stacked, so
   * a storm re-marking the same square for six seconds is one zone with a
   * moving deadline instead of eighteen overlapping ones.
   */
  warn(x: number, z: number, radius: number, seconds: number, label: string): void {
    const until = this.now() + seconds;
    for (const zone of this.zones) {
      if (zone.label !== label) continue;
      if (Math.hypot(zone.x - x, zone.z - z) > Math.max(4, radius * 0.5)) continue;
      zone.until = Math.max(zone.until, until);
      zone.radius = Math.max(zone.radius, radius);
      return;
    }
    this.zones.push({ x, z, radius, until, label });
  }

  update(): void {
    const now = this.now();
    for (let i = this.zones.length - 1; i >= 0; i--) {
      if (this.zones[i].until <= now) this.zones.splice(i, 1);
    }
  }

  /**
   * The zone this point is inside, worst first — worst meaning the one it is
   * deepest into, since a tank straddling two rings should run out of the one
   * it is least likely to clear by accident.
   */
  threatAt(pos: CANNON.Vec3, margin: number): DangerZone | null {
    let worst: DangerZone | null = null;
    let deepest = 0;
    for (const zone of this.zones) {
      const gap = Math.hypot(zone.x - pos.x, zone.z - pos.z);
      const depth = zone.radius + margin - gap;
      if (depth <= 0 || depth < deepest) continue;
      deepest = depth;
      worst = zone;
    }
    return worst;
  }

  /** Somewhere outside a zone, straight out from its centre. */
  escapeFrom(pos: CANNON.Vec3, zone: DangerZone, margin: number): Escape {
    let dx = pos.x - zone.x;
    let dz = pos.z - zone.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.5) {
      // Dead centre: any direction is as good as any other, and standing still
      // deciding is the one option that kills you.
      dx = 1;
      dz = 0;
    } else {
      dx /= len;
      dz /= len;
    }
    const reach = zone.radius + margin + 4;
    return { x: zone.x + dx * reach, z: zone.z + dz * reach };
  }

  get zoneCount(): number {
    return this.zones.length;
  }

  // ---- radio ------------------------------------------------------------

  /**
   * One line, from one raider, if the channel is free. Rate-limited twice over:
   * globally, so the feed never scrolls faster than it can be read, and per
   * topic, so four squadmates evacuating the same ring produce one call rather
   * than four.
   *
   * Returns whether it was actually said, which callers use to decide whether
   * to bother computing a follow-up.
   */
  say(speaker: Tank, topic: string, text: string, kind: Notification['kind'] = 'squad'): boolean {
    const now = this.now();
    if (now - this.lastCallAt < CALL_GAP) return false;
    if (now - (this.topicAt.get(topic) ?? -99) < CALL_TOPIC_GAP) return false;
    this.lastCallAt = now;
    this.topicAt.set(topic, now);
    this.calls += 1;
    this.emit(`${speaker.name}: ${text}`, kind);
    return true;
  }

  /** Picks one of a set of lines, so a raid does not have four stock phrases. */
  static line(lines: string[], seed: number): string {
    return lines[Math.abs(Math.round(seed)) % lines.length];
  }
}

/**
 * What the squad says. Grouped by topic rather than by speaker: a raid reads as
 * a unit that is handling something, not as four personalities taking turns.
 */
export const SQUAD_LINES = {
  evacuate: [
    'ring on me — moving',
    'that\'s marked ground, shifting',
    'clearing out, do not stand in that',
  ],
  rescue: [
    'breaking it off you — hit the deck with me',
    'it\'s fixed on you, we\'re pulling it round',
    'on my way — everyone into it',
  ],
  marked: [
    'it picked me — I can\'t shake it',
    'it\'s coming for me, somebody hurt it',
    'I\'m the one it wants — need that gun off me',
  ],
  push: [
    'it\'s winding up — free shots, take them',
    'it\'s stopped — now',
    'its back is to us, deck\'s open',
  ],
  cover: [
    'there goes the cover — nothing to hide behind out here',
    'it\'s taking the map apart',
    'that was our wall',
  ],
  // There is deliberately no line for dying. The kill feed already prints every
  // loss, and a squadmate announcing one is the same information twice in a
  // six-line feed — which was, measured, the single noisiest topic on the
  // channel and most of its traffic.
} as const;
