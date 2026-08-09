import type { StatusKind } from '../data/schema';

export interface StatusInstance {
  kind: StatusKind;
  magnitude: number;
  remaining: number;
  sourceId: number;
}

/**
 * Stackable effect container. Effects of the same kind refresh rather than
 * duplicate, except freezing which accumulates up to a cap — that stacking is
 * what makes sustained Freeze contact progressively crippling.
 */
/** Effects an enemy inflicts on you, as opposed to buffs you give yourself. */
const HOSTILE: ReadonlySet<StatusKind> = new Set<StatusKind>([
  'burning',
  'freezing',
  'emp',
  'stun',
  'ap',
  'jammer',
  'reveal',
]);

export class StatusSet {
  private readonly effects = new Map<StatusKind, StatusInstance>();
  immune = false;
  /**
   * 0..1, from a hull augment. Shortens hostile effects only — a coating that
   * sheds fire is not a reason for your own Double Armour to run out early.
   */
  resistance = 0;

  clear(): void {
    this.effects.clear();
  }

  apply(kind: StatusKind, magnitude: number, duration: number, sourceId = -1): void {
    if (this.immune && kind !== 'doubleArmor' && kind !== 'doubleDamage' && kind !== 'nitro') return;
    if (this.resistance > 0 && HOSTILE.has(kind)) duration *= 1 - Math.min(0.9, this.resistance);
    const existing = this.effects.get(kind);
    if (!existing) {
      this.effects.set(kind, { kind, magnitude, remaining: duration, sourceId });
      return;
    }
    if (kind === 'freezing') {
      existing.magnitude = Math.min(0.65, existing.magnitude + magnitude);
    } else {
      existing.magnitude = Math.max(existing.magnitude, magnitude);
    }
    existing.remaining = Math.max(existing.remaining, duration);
    existing.sourceId = sourceId;
  }

  remove(kind: StatusKind): void {
    this.effects.delete(kind);
  }

  has(kind: StatusKind): boolean {
    return this.effects.has(kind);
  }

  get(kind: StatusKind): StatusInstance | undefined {
    return this.effects.get(kind);
  }

  magnitude(kind: StatusKind): number {
    return this.effects.get(kind)?.magnitude ?? 0;
  }

  remaining(kind: StatusKind): number {
    return this.effects.get(kind)?.remaining ?? 0;
  }

  list(): StatusInstance[] {
    return [...this.effects.values()];
  }

  /** Ticks durations down and returns burn damage accrued this step. */
  update(dt: number): { burnDamage: number; burnSourceId: number } {
    let burnDamage = 0;
    let burnSourceId = -1;
    for (const e of [...this.effects.values()]) {
      if (e.kind === 'burning') {
        burnDamage += e.magnitude * dt;
        burnSourceId = e.sourceId;
      }
      if (e.kind === 'freezing') {
        // Thaws steadily once contact stops.
        e.magnitude = Math.max(0, e.magnitude - dt * 0.12);
      }
      e.remaining -= dt;
      if (e.remaining <= 0 || (e.kind === 'freezing' && e.magnitude <= 0.01)) {
        this.effects.delete(e.kind);
      }
    }
    return { burnDamage, burnSourceId };
  }

  /** Multiplier on hull speed and turn rate. */
  get movementScale(): number {
    let s = 1 - this.magnitude('freezing');
    if (this.has('nitro')) s *= 1.4;
    if (this.has('stun')) s = 0;
    return Math.max(0, s);
  }

  /** Multiplier on turret rotation speed. */
  get turretScale(): number {
    let s = 1 - this.magnitude('freezing') * 0.8;
    if (this.has('nitro')) s *= 1.25;
    if (this.has('stun')) s = 0;
    return Math.max(0, s);
  }

  get canFire(): boolean {
    return !this.has('emp') && !this.has('stun');
  }

  get damageDealtScale(): number {
    let s = 1;
    if (this.has('doubleDamage')) s *= 2;
    if (this.has('supercharge')) s *= 1.15;
    return s;
  }

  get fireRateScale(): number {
    const sc = this.get('supercharge');
    return sc ? sc.magnitude : 1;
  }

  get damageTakenScale(): number {
    let s = 1;
    if (this.has('doubleArmor')) s *= 0.5;
    if (this.has('ap')) s *= 1.35;
    return s;
  }
}
