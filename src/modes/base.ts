import type * as CANNON from 'cannon-es';
import type * as THREE from 'three';
import type { MapDef, ModeCode, TeamId } from '../data/schema';
import type { Arena } from '../game/types';
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
