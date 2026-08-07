import type { ModeCode, TeamId } from '../data/schema';
import type { Arena } from '../game/types';
import type { Tank } from '../entities/tank';
import { BaseMode, otherTeam, type ModeResult, type ObjectiveHint } from './base';

/** Red against Blue. Several tanks can share credit for a kill. */
export class TeamDeathmatchMode extends BaseMode {
  readonly code: ModeCode = 'TDM';
  readonly teams = true;

  override onKill(killer: Tank | null, victim: Tank, arena: Arena): void {
    if (!killer || killer === victim || arena.areAllies(killer, victim)) {
      victim.score = Math.max(0, victim.score - 5);
      return;
    }
    killer.kills += 1;
    killer.addBattlePoints(10);
    killer.crystals += 6;
    if (killer.team === 'red' || killer.team === 'blue') this.scores[killer.team] += 1;

    // Assist credit: recent damage from an ally counts toward the team score
    // without stealing the kill.
    for (const t of arena.tanks) {
      if (t === killer || t === victim) continue;
      if (!arena.areAllies(t, killer)) continue;
      if (victim.lastAttacker === t && arena.time - victim.lastAttackedAt < 6) {
        t.addBattlePoints(4);
      }
    }
  }

  override objectiveFor(bot: Tank, arena: Arena): ObjectiveHint | null {
    const enemies = arena.tanks.filter((t) => t.alive && arena.areEnemies(bot, t));
    if (!enemies.length) return null;
    // Head for the enemy team's centre of mass; that produces front lines.
    let x = 0;
    let z = 0;
    for (const e of enemies) {
      x += e.position.x;
      z += e.position.z;
    }
    const pos = enemies[0].position.clone();
    pos.x = x / enemies.length;
    pos.z = z / enemies.length;
    const losing = this.scores[otherTeam(bot.team)] > this.scores[bot.team === 'red' ? 'red' : 'blue'];
    return { pos, kind: 'attack', weight: losing ? 0.5 : 0.3 };
  }

  result(elapsed: number, arena: Arena): ModeResult {
    const limit = arena.settings.killLimit;
    if (limit != null) {
      for (const team of ['red', 'blue'] as const) {
        if (this.scores[team] >= limit) {
          return { over: true, winner: team === 'red' ? 'Red' : 'Blue', reason: `${limit} kills` };
        }
      }
    }
    return this.timeUp(elapsed, arena) ?? { over: false };
  }

  hudLine(playerTeam: TeamId): string {
    const mine = playerTeam === 'blue' ? this.scores.blue : this.scores.red;
    const theirs = playerTeam === 'blue' ? this.scores.red : this.scores.blue;
    return `${mine} — ${theirs}`;
  }
}
