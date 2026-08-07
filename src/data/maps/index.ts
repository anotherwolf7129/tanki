import type { MapDef, ModeCode } from '../schema';
import { sandbox } from './sandbox';
import { silence } from './silence';
import { kungur } from './kungur';
import { rio } from './rio';
import { polygon } from './polygon';
import { stadium } from './stadium';
import { madness } from './madness';

export const MAPS: Record<string, MapDef> = {
  sandbox,
  silence,
  kungur,
  rio,
  polygon,
  stadium,
  madness,
};

export const MAP_IDS = Object.keys(MAPS);

export function map(id: string): MapDef {
  const m = MAPS[id];
  if (!m) throw new Error(`unknown map: ${id}`);
  return m;
}

export function mapsForMode(mode: ModeCode): string[] {
  return MAP_IDS.filter((id) => MAPS[id].modes.includes(mode));
}
