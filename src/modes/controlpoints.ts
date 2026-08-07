import * as CANNON from 'cannon-es';
import * as THREE from 'three';
import type { MapDef, ModeCode, TeamId } from '../data/schema';
import { TEAM_COLOURS } from '../render/materials';
import { clamp } from '../core/mathx';
import type { Arena } from '../game/types';
import type { Tank } from '../entities/tank';
import { BaseMode, type MinimapMarker, type ModeResult, type ObjectiveHint } from './base';

interface Point {
  id: string;
  pos: CANNON.Vec3;
  radius: number;
  /** -1 fully red, +1 fully blue. */
  charge: number;
  owner: 'red' | 'blue' | null;
  contested: boolean;
  orb: THREE.Mesh;
  disc: THREE.Mesh;
}

const CAPTURE_RATE = 0.16;
const SCORE_RATE = 2.2;

/** Stand on a platform to capture it; captured points accrue score over time. */
export class ControlPointsMode extends BaseMode {
  readonly code: ModeCode = 'CP';
  readonly teams = true;
  private readonly points: Point[] = [];
  private readonly owned: (THREE.BufferGeometry | THREE.Material)[] = [];

  constructor(def: MapDef, scene: THREE.Scene) {
    super(def, scene);
    const specs = def.controlPoints ?? [{ id: 'A', pos: [0, 0, 0] as [number, number, number], radius: 10 }];
    for (const spec of specs) this.points.push(this.makePoint(spec.id, spec.pos, spec.radius));
  }

  private makePoint(id: string, at: [number, number, number], radius: number): Point {
    const discGeo = new THREE.CylinderGeometry(radius, radius, 0.3, 28);
    const discMat = new THREE.MeshStandardMaterial({
      color: 0x9aa4b2,
      transparent: true,
      opacity: 0.35,
      emissive: 0x9aa4b2,
      emissiveIntensity: 0.2,
    });
    const orbGeo = new THREE.IcosahedronGeometry(1.8, 1);
    const orbMat = new THREE.MeshStandardMaterial({
      color: 0x9aa4b2,
      emissive: 0x9aa4b2,
      emissiveIntensity: 0.8,
      roughness: 0.3,
    });
    this.owned.push(discGeo, discMat, orbGeo, orbMat);

    const disc = new THREE.Mesh(discGeo, discMat);
    disc.position.set(at[0], at[1] + 0.16, at[2]);
    const orb = new THREE.Mesh(orbGeo, orbMat);
    orb.position.set(at[0], at[1] + 4.2, at[2]);
    this.scene.add(disc, orb);

    return {
      id,
      pos: new CANNON.Vec3(at[0], at[1], at[2]),
      radius,
      charge: 0,
      owner: null,
      contested: false,
      orb,
      disc,
    };
  }

  override update(dt: number, arena: Arena): void {
    for (const point of this.points) {
      let red = 0;
      let blue = 0;
      for (const tank of arena.tanks) {
        if (!tank.alive || tank.team === 'free') continue;
        const d = Math.hypot(tank.position.x - point.pos.x, tank.position.z - point.pos.z);
        if (d > point.radius) continue;
        if (Math.abs(tank.position.y - point.pos.y) > 6) continue;
        if (tank.team === 'red') red += 1;
        else blue += 1;
      }

      point.contested = red > 0 && blue > 0;
      if (!point.contested && (red > 0 || blue > 0)) {
        // Extra bodies help, but with diminishing returns.
        const push = blue > 0 ? 1 + (blue - 1) * 0.35 : -(1 + (red - 1) * 0.35);
        point.charge = clamp(point.charge + push * CAPTURE_RATE * dt, -1, 1);
      }

      const previous = point.owner;
      point.owner = point.charge >= 1 ? 'blue' : point.charge <= -1 ? 'red' : null;
      if (point.owner !== previous) {
        if (point.owner) arena.notify(`${point.owner === 'red' ? 'Red' : 'Blue'} captured point ${point.id}`, 'objective');
        else arena.notify(`Point ${point.id} is neutral`, 'objective');
        // Everyone standing on it when it flips gets credit.
        if (point.owner) {
          for (const tank of arena.tanks) {
            if (tank.team !== point.owner || !tank.alive) continue;
            if (Math.hypot(tank.position.x - point.pos.x, tank.position.z - point.pos.z) <= point.radius) {
              arena.awardBattlePoints(tank, 12);
            }
          }
        }
      }

      if (point.owner) this.scores[point.owner] += SCORE_RATE * dt;

      const colour =
        point.owner === 'red'
          ? TEAM_COLOURS.red
          : point.owner === 'blue'
            ? TEAM_COLOURS.blue
            : point.charge === 0
              ? 0x9aa4b2
              : point.charge > 0
                ? mix(0x9aa4b2, TEAM_COLOURS.blue, point.charge)
                : mix(0x9aa4b2, TEAM_COLOURS.red, -point.charge);
      (point.orb.material as THREE.MeshStandardMaterial).color.setHex(colour);
      (point.orb.material as THREE.MeshStandardMaterial).emissive.setHex(colour);
      (point.disc.material as THREE.MeshStandardMaterial).color.setHex(colour);
      (point.disc.material as THREE.MeshStandardMaterial).emissive.setHex(colour);
      point.orb.rotation.y += dt * (point.contested ? 3.2 : 0.7);
      point.orb.position.y = point.pos.y + 4.2 + Math.sin(arena.time * 1.6) * 0.35;
    }
  }

  override onKill(killer: Tank | null, victim: Tank, arena: Arena): void {
    if (killer && killer !== victim && arena.areEnemies(killer, victim)) {
      killer.kills += 1;
      killer.addBattlePoints(8);
      killer.crystals += 5;
    }
  }

  override objectiveFor(bot: Tank, _arena: Arena): ObjectiveHint | null {
    if (bot.team === 'free') return null;
    const mine = bot.team === 'red' ? 'red' : 'blue';
    let best: Point | null = null;
    let bestScore = -Infinity;

    for (const point of this.points) {
      const dist = point.pos.distanceTo(bot.position);
      // Prefer neutral or nearly-flipped points over one already firmly held.
      const ownership = point.owner === mine ? -30 : point.owner ? 25 : 45;
      const contest = point.contested ? 30 : 0;
      const score = ownership + contest - dist * 0.35;
      if (score > bestScore) {
        bestScore = score;
        best = point;
      }
    }
    if (!best) return null;
    const weight = best.owner === mine ? 0.35 : best.contested ? 0.95 : 0.8;
    return { pos: best.pos.clone(), kind: best.owner === mine ? 'defend' : 'attack', weight };
  }

  result(elapsed: number, arena: Arena): ModeResult {
    const limit = arena.settings.scoreLimit;
    if (limit != null) {
      for (const team of ['red', 'blue'] as const) {
        if (this.scores[team] >= limit) {
          return { over: true, winner: team === 'red' ? 'Red' : 'Blue', reason: `${limit} points` };
        }
      }
    }
    return this.timeUp(elapsed, arena) ?? { over: false };
  }

  hudLine(playerTeam: TeamId): string {
    const mine = playerTeam === 'blue' ? this.scores.blue : this.scores.red;
    const theirs = playerTeam === 'blue' ? this.scores.red : this.scores.blue;
    const held = this.points.filter((p) => p.owner === (playerTeam === 'blue' ? 'blue' : 'red')).length;
    return `${Math.floor(mine)} — ${Math.floor(theirs)}  ·  ${held}/${this.points.length} held`;
  }

  override markers(): MinimapMarker[] {
    return this.points.map((p) => ({
      x: p.pos.x,
      z: p.pos.z,
      colour:
        p.owner === 'red' ? TEAM_COLOURS.red : p.owner === 'blue' ? TEAM_COLOURS.blue : 0x9aa4b2,
      shape: 'point' as const,
      label: p.id,
      progress: Math.abs(p.charge),
    }));
  }

  override dispose(): void {
    for (const p of this.points) this.scene.remove(p.disc, p.orb);
    for (const o of this.owned) o.dispose();
  }
}

function mix(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}
