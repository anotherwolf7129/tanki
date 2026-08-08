import type * as CANNON from 'cannon-es';
import type * as THREE from 'three';
import type { MapDef, ModeCode, TeamId } from '../data/schema';
import { modeLimit } from '../data/modes';
import type { Arena, DamageOptions } from '../game/types';
import type { Tank } from '../entities/tank';

export interface ObjectiveHint {
  pos: CANNON.Vec3;
  kind: 'attack' | 'defend';
  /** 0..1 urgency. Bots weight this by their persona's objective bias. */
  weight: number;
}

export interface MinimapMarker {
  x: number;
  z: number;
  colour: number;
  shape: 'flag' | 'point' | 'ring';
  label?: string;
  progress?: number;
}

export interface ModeResult {
  over: boolean;
  winner?: string;
  reason?: string;
}

/** Everything the HUD needs to draw a boss fight. Null outside Boss Raid. */
export interface BossStatus {
  name: string;
  health: number;
  maxHealth: number;
  healthFraction: number;
  phase: number;
  phaseName: string;
  /** Health fractions where the phases change, for the notches on the bar. */
  phaseMarks: number[];
  /** True while the boss's gun is pointed at you specifically. */
  targetingPlayer: boolean;
  /** Your share of its attention, 0..1. */
  playerThreat: number;
  /** Raider deaths so far. Reinforcements are unlimited; these set the price. */
  losses: number;
  /** Seconds the next death will cost, which rises with every one before it. */
  respawnDelay: number;
  /** True once the boss is berserk, so the HUD can say so. */
  enraged: boolean;
  /** Ability currently winding up, and how far through the wind-up it is. */
  telegraph: string | null;
  telegraphProgress: number;
}

export interface ModeController {
  readonly code: ModeCode;
  readonly teams: boolean;
  update(dt: number, arena: Arena): void;
  onKill(killer: Tank | null, victim: Tank, arena: Arena): void;
  onDeath(victim: Tank, arena: Arena): void;
  /** Where a bot should go and how badly it should want to go there. */
  objectiveFor(bot: Tank, arena: Arena): ObjectiveHint | null;
  teamScores(): Record<'red' | 'blue', number> | null;
  result(elapsed: number, arena: Arena): ModeResult;
  hudLine(playerTeam: TeamId, arena: Arena): string;
  markers(): MinimapMarker[];
  /**
   * Mode-specific multiplier applied inside the battle's damage funnel. Modes
   * that do not reshape damage return 1 and cost nothing. `amount` is the raw
   * damage before any multiplier, which is what lets a mode express a rule as
   * "this always lands for at least N" rather than as a bare factor.
   */
  damageScale(target: Tank, source: Tank | null, opts: DamageOptions, arena: Arena, amount: number): number;
  /** False keeps a destroyed tank out of the fight entirely. */
  canRespawn(tank: Tank, arena: Arena): boolean;
  /** Seconds before this tank comes back, or null for the battle's default. */
  respawnDelay(tank: Tank, arena: Arena): number | null;
  /** Boss-fight state for the HUD, or null in every other mode. */
  bossStatus(arena: Arena): BossStatus | null;
  dispose(): void;
}

export abstract class BaseMode implements ModeController {
  abstract readonly code: ModeCode;
  abstract readonly teams: boolean;
  protected readonly scores: Record<'red' | 'blue', number> = { red: 0, blue: 0 };

  constructor(
    protected readonly def: MapDef,
    protected readonly scene: THREE.Scene,
  ) {}

  update(_dt: number, _arena: Arena): void {}
  onKill(_killer: Tank | null, _victim: Tank, _arena: Arena): void {}
  onDeath(_victim: Tank, _arena: Arena): void {}
  objectiveFor(_bot: Tank, _arena: Arena): ObjectiveHint | null {
    return null;
  }
  teamScores(): Record<'red' | 'blue', number> | null {
    return this.teams ? this.scores : null;
  }
  abstract result(elapsed: number, arena: Arena): ModeResult;
  abstract hudLine(playerTeam: TeamId, arena: Arena): string;
  markers(): MinimapMarker[] {
    return [];
  }
  damageScale(_target: Tank, _source: Tank | null, _opts: DamageOptions, _arena: Arena, _amount: number): number {
    return 1;
  }
  canRespawn(_tank: Tank, _arena: Arena): boolean {
    return true;
  }
  respawnDelay(_tank: Tank, _arena: Arena): number | null {
    return null;
  }
  bossStatus(_arena: Arena): BossStatus | null {
    return null;
  }
  dispose(): void {}

  /**
   * The mode's race-to-a-number, in its own unit, or null when the lobby turned
   * it off and only the clock can end the battle.
   */
  protected limit(arena: Arena): number | null {
    return modeLimit(arena.settings);
  }

  /**
   * `· first to 100` for the HUD strip, empty when there is no limit. The unit
   * is left off deliberately — the number it is chasing is already on the same
   * line, and the top bar is only 300 px wide.
   */
  protected limitLine(arena: Arena): string {
    const limit = this.limit(arena);
    return limit == null ? '' : `  ·  first to ${limit}`;
  }

  /**
   * Whichever team reached the limit first, if either has. Every team mode
   * races on `scores`; only the unit printed in the result differs.
   */
  protected teamLimitReached(arena: Arena, unit: string): ModeResult | null {
    const limit = this.limit(arena);
    if (limit == null) return null;
    for (const team of ['red', 'blue'] as const) {
      if (this.scores[team] >= limit) {
        return { over: true, winner: team === 'red' ? 'Red' : 'Blue', reason: `${limit} ${unit}` };
      }
    }
    return null;
  }

  protected timeUp(elapsed: number, arena: Arena): ModeResult | null {
    if (elapsed < arena.settings.timeLimit) return null;
    if (!this.teams) return { over: true, reason: 'Time limit reached' };
    const winner =
      this.scores.red === this.scores.blue
        ? 'Draw'
        : this.scores.red > this.scores.blue
          ? 'Red'
          : 'Blue';
    return { over: true, winner, reason: 'Time limit reached' };
  }
}

export function otherTeam(team: TeamId): 'red' | 'blue' {
  return team === 'red' ? 'blue' : 'red';
}
