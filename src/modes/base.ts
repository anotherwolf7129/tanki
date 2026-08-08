import type * as CANNON from 'cannon-es';
import type * as THREE from 'three';
import type { MapDef, ModeCode, TeamId } from '../data/schema';
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
  reinforcements: number;
  /** Ability currently winding up, and how far through the wind-up it is. */
  telegraph: string | null;
  telegraphProgress: number;
  /** True once the player has spent the last reinforcement and cannot return. */
  playerOut: boolean;
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
  hudLine(playerTeam: TeamId): string;
  markers(): MinimapMarker[];
  /**
   * Mode-specific multiplier applied inside the battle's damage funnel. Modes
   * that do not reshape damage return 1 and cost nothing.
   */
  damageScale(target: Tank, source: Tank | null, opts: DamageOptions, arena: Arena): number;
  /** False keeps a destroyed tank out of the fight — raids run on a ticket pool. */
  canRespawn(tank: Tank, arena: Arena): boolean;
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
  abstract hudLine(playerTeam: TeamId): string;
  markers(): MinimapMarker[] {
    return [];
  }
  damageScale(_target: Tank, _source: Tank | null, _opts: DamageOptions, _arena: Arena): number {
    return 1;
  }
  canRespawn(_tank: Tank, _arena: Arena): boolean {
    return true;
  }
  bossStatus(_arena: Arena): BossStatus | null {
    return null;
  }
  dispose(): void {}

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
