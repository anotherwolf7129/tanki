import * as CANNON from 'cannon-es';
import * as THREE from 'three';
import type { MapDef, ModeCode, TeamId } from '../data/schema';
import { flagPoints } from '../data/modes';
import { TEAM_COLOURS } from '../render/materials';
import type { Arena } from '../game/types';
import type { Tank } from '../entities/tank';
import { BaseMode, otherTeam, type MinimapMarker, type ModeResult, type ObjectiveHint } from './base';

type FlagState = 'home' | 'carried' | 'dropped';

interface Flag {
  team: 'red' | 'blue';
  home: CANNON.Vec3;
  pos: CANNON.Vec3;
  state: FlagState;
  carrier: Tank | null;
  dropTimer: number;
  mesh: THREE.Group;
  /** Everyone who has held this flag since it left home, for transfer credit. */
  chain: Tank[];
}

const RETURN_TIME = 30;
const PICKUP_RADIUS = 4.2;

/**
 * Drive through the enemy flag to take it; bring it to your own platform to
 * score, but only while your own flag is home. Scoring follows the wiki
 * formula: pickup and transfer are banked and only pay out on delivery.
 */
export class CaptureFlagMode extends BaseMode {
  readonly code: ModeCode = 'CTF';
  readonly teams = true;
  private readonly flags: Record<'red' | 'blue', Flag>;
  private readonly owned: (THREE.BufferGeometry | THREE.Material)[] = [];

  constructor(def: MapDef, scene: THREE.Scene) {
    super(def, scene);
    const spec = def.flags ?? {
      red: [-def.bounds.x + 10, 0, 0] as [number, number, number],
      blue: [def.bounds.x - 10, 0, 0] as [number, number, number],
    };
    this.flags = {
      red: this.makeFlag('red', spec.red),
      blue: this.makeFlag('blue', spec.blue),
    };
  }

  private makeFlag(team: 'red' | 'blue', at: [number, number, number]): Flag {
    const group = new THREE.Group();
    const poleGeo = new THREE.CylinderGeometry(0.16, 0.16, 5, 8);
    const clothGeo = new THREE.PlaneGeometry(2.6, 1.6);
    const baseGeo = new THREE.CylinderGeometry(4, 4.4, 0.5, 20);
    const clothMat = new THREE.MeshStandardMaterial({
      color: TEAM_COLOURS[team],
      emissive: TEAM_COLOURS[team],
      emissiveIntensity: 0.35,
      side: THREE.DoubleSide,
    });
    const poleMat = new THREE.MeshStandardMaterial({ color: 0xd8dde3, metalness: 0.7, roughness: 0.3 });
    const baseMat = new THREE.MeshStandardMaterial({
      color: TEAM_COLOURS[team],
      transparent: true,
      opacity: 0.35,
      emissive: TEAM_COLOURS[team],
      emissiveIntensity: 0.25,
    });
    this.owned.push(poleGeo, clothGeo, baseGeo, clothMat, poleMat, baseMat);

    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.y = 2.5;
    const cloth = new THREE.Mesh(clothGeo, clothMat);
    cloth.position.set(1.4, 4.0, 0);
    const base = new THREE.Mesh(baseGeo, baseMat);
    base.position.y = 0.25;
    group.add(pole, cloth, base);
    group.position.set(at[0], at[1], at[2]);
    this.scene.add(group);

    return {
      team,
      home: new CANNON.Vec3(at[0], at[1], at[2]),
      pos: new CANNON.Vec3(at[0], at[1], at[2]),
      state: 'home',
      carrier: null,
      dropTimer: 0,
      mesh: group,
      chain: [],
    };
  }

  override update(dt: number, arena: Arena): void {
    for (const team of ['red', 'blue'] as const) {
      const flag = this.flags[team];

      if (flag.state === 'carried') {
        const carrier = flag.carrier!;
        if (!carrier.alive) {
          this.drop(flag, arena);
        } else {
          flag.pos.copy(carrier.position);
          flag.pos.y += 1.5;
        }
      } else if (flag.state === 'dropped') {
        flag.dropTimer -= dt;
        if (flag.dropTimer <= 0) this.returnHome(flag, arena, null);
      }

      flag.mesh.position.set(flag.pos.x, flag.pos.y, flag.pos.z);
      flag.mesh.visible = flag.state !== 'carried';

      for (const tank of arena.tanks) {
        if (!tank.alive || tank.team === 'free') continue;
        const dist = tank.position.distanceTo(flag.pos);
        if (dist > PICKUP_RADIUS) continue;

        if (tank.team === team) {
          // Touching your own flag returns it if it is loose; if it is home and
          // you are carrying theirs, that is a capture.
          if (flag.state === 'dropped') {
            this.returnHome(flag, arena, tank);
          } else if (flag.state === 'home' && tank.carryingFlag) {
            this.capture(tank, arena);
          }
        } else if (flag.state !== 'carried' && !tank.carryingFlag) {
          this.pickup(flag, tank, arena);
        }
      }
    }
  }

  private pickup(flag: Flag, tank: Tank, arena: Arena): void {
    const wasHome = flag.state === 'home';
    flag.state = 'carried';
    flag.carrier = tank;
    tank.carryingFlag = flag.team;
    tank.mesh.setCarrying(flag.team);
    if (wasHome) flag.chain = [];
    if (!flag.chain.includes(tank)) flag.chain.push(tank);
    // Banked, not awarded: pickup only pays if the flag is eventually delivered.
    tank.bankedFlagPoints += flagPoints(arena.playerCount).pickup;
    arena.notify(`${tank.name} took the ${flag.team} flag`, 'objective');
  }

  private drop(flag: Flag, arena: Arena): void {
    const carrier = flag.carrier;
    flag.state = 'dropped';
    flag.dropTimer = RETURN_TIME;
    if (carrier) {
      flag.pos.copy(carrier.position);
      flag.pos.y = Math.max(0.2, flag.pos.y);
      carrier.carryingFlag = null;
      carrier.mesh.setCarrying(null);
    }
    flag.carrier = null;
    arena.notify(`The ${flag.team} flag was dropped`, 'objective');
  }

  private returnHome(flag: Flag, arena: Arena, by: Tank | null): void {
    flag.state = 'home';
    flag.pos.copy(flag.home);
    if (flag.carrier) {
      flag.carrier.carryingFlag = null;
      flag.carrier.mesh.setCarrying(null);
    }
    flag.carrier = null;
    // The chain is broken, so banked pickup points for it are forfeit.
    for (const t of flag.chain) t.bankedFlagPoints = 0;
    flag.chain = [];
    if (by) {
      by.addBattlePoints(8);
      arena.notify(`${by.name} returned the ${flag.team} flag`, 'objective');
    } else {
      arena.notify(`The ${flag.team} flag returned`, 'objective');
    }
  }

  private capture(tank: Tank, arena: Arena): void {
    const carried = tank.carryingFlag;
    if (!carried || carried === 'free') return;
    const flag = this.flags[carried];
    const pts = flagPoints(arena.playerCount);

    // Delivery pays out, and everyone in the transfer chain settles up.
    const chain = flag.chain.filter((t) => t !== tank);
    const perTransfer = chain.length ? pts.transfer / chain.length : 0;
    for (const t of chain) {
      arena.awardBattlePoints(t, perTransfer + t.bankedFlagPoints);
      t.bankedFlagPoints = 0;
    }
    arena.awardBattlePoints(tank, pts.delivery + tank.bankedFlagPoints);
    tank.bankedFlagPoints = 0;
    tank.crystals += 40;

    tank.carryingFlag = null;
    tank.mesh.setCarrying(null);
    flag.state = 'home';
    flag.pos.copy(flag.home);
    flag.carrier = null;
    flag.chain = [];

    if (tank.team === 'red' || tank.team === 'blue') this.scores[tank.team] += 1;
    arena.notify(`${tank.name} captured the ${carried} flag!`, 'objective');
  }

  override onKill(killer: Tank | null, victim: Tank, arena: Arena): void {
    if (killer && killer !== victim && arena.areEnemies(killer, victim)) {
      killer.kills += 1;
      killer.addBattlePoints(victim.carryingFlag ? 18 : 8);
      killer.crystals += 6;
    }
  }

  override onDeath(victim: Tank, arena: Arena): void {
    for (const team of ['red', 'blue'] as const) {
      const flag = this.flags[team];
      if (flag.carrier === victim) this.drop(flag, arena);
    }
  }

  override objectiveFor(bot: Tank, _arena: Arena): ObjectiveHint | null {
    if (bot.team === 'free') return null;
    const mine = this.flags[bot.team === 'red' ? 'red' : 'blue'];
    const theirs = this.flags[otherTeam(bot.team)];

    if (bot.carryingFlag) {
      // Carrying: run for home, hard.
      return { pos: mine.home.clone(), kind: 'attack', weight: 1 };
    }
    if (mine.state !== 'home') {
      // Recovering your own flag beats anything else on the board.
      return { pos: mine.pos.clone(), kind: 'defend', weight: 0.95 };
    }
    if (theirs.state === 'carried' && theirs.carrier) {
      return { pos: theirs.carrier.position.clone(), kind: 'defend', weight: 0.9 };
    }
    return { pos: theirs.pos.clone(), kind: 'attack', weight: 0.6 };
  }

  result(elapsed: number, arena: Arena): ModeResult {
    const limit = arena.settings.flagLimit;
    if (limit != null) {
      for (const team of ['red', 'blue'] as const) {
        if (this.scores[team] >= limit) {
          return { over: true, winner: team === 'red' ? 'Red' : 'Blue', reason: `${limit} flags` };
        }
      }
    }
    return this.timeUp(elapsed, arena) ?? { over: false };
  }

  hudLine(playerTeam: TeamId): string {
    const mine = playerTeam === 'blue' ? this.scores.blue : this.scores.red;
    const theirs = playerTeam === 'blue' ? this.scores.red : this.scores.blue;
    return `Flags ${mine} — ${theirs}`;
  }

  override markers(): MinimapMarker[] {
    return (['red', 'blue'] as const).map((team) => ({
      x: this.flags[team].pos.x,
      z: this.flags[team].pos.z,
      colour: TEAM_COLOURS[team],
      shape: 'flag' as const,
      label: this.flags[team].state === 'carried' ? '!' : undefined,
    }));
  }

  override dispose(): void {
    for (const team of ['red', 'blue'] as const) this.scene.remove(this.flags[team].mesh);
    for (const o of this.owned) o.dispose();
  }
}
