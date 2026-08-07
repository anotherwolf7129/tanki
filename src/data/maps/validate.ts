import { NavGrid } from '../../ai/navgrid';
import { PhysicsWorld } from '../../physics/world';
import type { MapDef, TeamId } from '../schema';
import { MAPS, MAP_IDS } from './index';

export interface MapIssue {
  severity: 'error' | 'warning';
  what: string;
  detail: string;
}

export interface MapReport {
  id: string;
  issues: MapIssue[];
}

const REACH_TOLERANCE = 6;

/**
 * Static map lint. Every spawn, flag, control point and supply zone has to sit
 * on a drivable surface that is actually connected to the rest of the arena —
 * a flag on top of a 10 m cliff face or a spawn in a sealed pocket is invisible
 * in the editor and fatal in play.
 */
export function validateMap(def: MapDef): MapReport {
  const issues: MapIssue[] = [];
  const phys = new PhysicsWorld(def.gravityScale);
  phys.buildMap(def);
  const nav = new NavGrid(phys, def);

  const onSurface = (label: string, pos: [number, number, number], expectY = true): number => {
    const cell = nav.nearestWalkable(pos[0], pos[2], 2);
    if (cell < 0) {
      issues.push({ severity: 'error', what: label, detail: `no drivable cell near ${fmt(pos)}` });
      return -1;
    }
    const surface = nav.surfaceHeight(pos[0], pos[2]);
    if (expectY && Math.abs(surface - pos[1]) > 2.5) {
      issues.push({
        severity: 'error',
        what: label,
        detail: `declared y=${pos[1]} but the surface at ${fmt(pos)} is ${surface.toFixed(1)}`,
      });
    }
    return cell;
  };

  const anchors: { label: string; pos: [number, number, number] }[] = [];

  for (const team of ['red', 'blue', 'free'] as TeamId[]) {
    (def.spawns[team] ?? []).forEach((s, i) => {
      const label = `spawn ${team}[${i}]`;
      onSurface(label, s.pos);
      anchors.push({ label, pos: s.pos });
    });
  }
  if (def.flags) {
    for (const team of ['red', 'blue'] as const) {
      onSurface(`flag ${team}`, def.flags[team]);
      anchors.push({ label: `flag ${team}`, pos: def.flags[team] });
    }
  }
  for (const cp of def.controlPoints ?? []) {
    onSurface(`control point ${cp.id}`, cp.pos);
    anchors.push({ label: `control point ${cp.id}`, pos: cp.pos });
  }
  for (const [i, zone] of def.supplyZones.entries()) {
    onSurface(`supply zone [${i}]`, zone.pos);
  }
  for (const [i, zone] of def.goldBoxZones.entries()) {
    onSurface(`gold box zone [${i}]`, zone, false);
  }

  // Connectivity: every anchor must be reachable from the first one.
  const root = anchors[0];
  if (root) {
    for (const anchor of anchors.slice(1)) {
      const path = nav.findPath(root.pos[0], root.pos[2], anchor.pos[0], anchor.pos[2]);
      const end = path[path.length - 1];
      const gap = end ? Math.hypot(end.x - anchor.pos[0], end.z - anchor.pos[2]) : Infinity;
      if (gap > REACH_TOLERANCE) {
        issues.push({
          severity: 'error',
          what: anchor.label,
          detail: `unreachable from ${root.label}: path stops ${gap.toFixed(0)} m short`,
        });
      }
    }
  }

  const modesNeedingFlags = def.modes.includes('CTF');
  if (modesNeedingFlags && !def.flags) {
    issues.push({ severity: 'error', what: 'CTF', detail: 'map declares CTF but has no flags' });
  }
  if (def.modes.includes('CP') && !def.controlPoints?.length) {
    issues.push({ severity: 'error', what: 'CP', detail: 'map declares CP but has no control points' });
  }
  const teamed = def.modes.some((m) => m !== 'DM');
  if (teamed && (!def.spawns.red?.length || !def.spawns.blue?.length)) {
    issues.push({ severity: 'error', what: 'spawns', detail: 'team modes need red and blue spawns' });
  }
  const needed = def.maxPlayers;
  if ((def.spawns.free?.length ?? 0) < Math.min(8, needed)) {
    issues.push({
      severity: 'warning',
      what: 'spawns',
      detail: `only ${def.spawns.free?.length ?? 0} free spawns for ${needed} players`,
    });
  }

  return { id: def.id, issues };
}

export function validateMaps(): MapReport[] {
  return MAP_IDS.map((id) => validateMap(MAPS[id]));
}

function fmt(p: [number, number, number]): string {
  return `(${p[0]}, ${p[1]}, ${p[2]})`;
}
