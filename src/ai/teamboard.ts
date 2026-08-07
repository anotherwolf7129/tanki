import type * as CANNON from 'cannon-es';
import type { TeamId } from '../data/schema';

export interface Claim {
  botId: number;
  expires: number;
}

/**
 * Shallow shared state per team. Deliberately thin — emergent coordination
 * reads better than scripted squad play, and all this really needs to do is
 * stop two bots racing for the same box or the same flag.
 */
export class TeamBoard {
  private readonly claims = new Map<string, Claim>();
  private readonly calls = new Map<number, number>();
  /** Objective the team currently wants, set by the mode controller. */
  objective: CANNON.Vec3 | null = null;
  objectiveKind: 'attack' | 'defend' | 'none' = 'none';
  flagCarrierId: number | null = null;
  enemyCarrierId: number | null = null;

  constructor(readonly team: TeamId) {}

  /** True if the caller now owns the claim. */
  claim(key: string, botId: number, now: number, duration = 6): boolean {
    const existing = this.claims.get(key);
    if (existing && existing.botId !== botId && existing.expires > now) return false;
    this.claims.set(key, { botId, expires: now + duration });
    return true;
  }

  release(key: string, botId: number): void {
    const existing = this.claims.get(key);
    if (existing && existing.botId === botId) this.claims.delete(key);
  }

  /** Number of allies already shooting at a target, for spread-fire decisions. */
  callTarget(targetId: number): void {
    this.calls.set(targetId, (this.calls.get(targetId) ?? 0) + 1);
  }

  focusCount(targetId: number): number {
    return this.calls.get(targetId) ?? 0;
  }

  beginTick(): void {
    this.calls.clear();
  }
}
