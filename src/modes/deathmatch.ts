import type { ModeCode, TeamId } from '../data/schema';
import type { Arena } from '../game/types';
import type { Tank } from '../entities/tank';
import { BaseMode, type ModeResult, type ObjectiveHint } from './base';

/** No teams, only the killer scores, no assists. */
export class DeathmatchMode extends BaseMode {
  readonly code: ModeCode = 'DM';
  readonly teams = false;

  override onKill(killer: Tank | null, victim: Tank, _arena: Arena): void {
    if (!killer || killer === victim) {
      victim.score = Math.max(0, victim.score - 5);
      return;
    }
    killer.kills += 1;
    killer.addBattlePoints(10);
    killer.crystals += 6;
  }

  override objectiveFor(bot: Tank, arena: Arena): ObjectiveHint | null {
    // "Hunt the nearest low-hp target" — the DM subtree from the spec.
    let best: Tank | null = null;
    let bestScore = -Infinity;
    for (const t of arena.tanks) {
      if (t === bot || !t.alive) continue;
      const d = t.position.distanceTo(bot.position);
      const score = (1 - t.healthFraction) * 60 - d * 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    if (!best) return null;
    return { pos: best.position.clone(), kind: 'attack', weight: 0.35 };
  }

  result(elapsed: number, arena: Arena): ModeResult {
    const limit = this.limit(arena);
    if (limit != null) {
      const leader = arena.tanks.reduce((a, b) => (b.kills > a.kills ? b : a), arena.tanks[0]);
      if (leader && leader.kills >= limit) {
        return { over: true, winner: leader.name, reason: `${limit} kills` };
      }
    }
    return this.timeUp(elapsed, arena) ?? { over: false };
  }

  hudLine(_playerTeam: TeamId, arena: Arena): string {
    return `Free for all${this.limitLine(arena)}`;
  }
}
