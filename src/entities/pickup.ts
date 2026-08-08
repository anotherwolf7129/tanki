import * as CANNON from 'cannon-es';
import * as THREE from 'three';
import type { MapDef, SupplyKind } from '../data/schema';
import { CRYSTAL_BOX_REWARD, GOLD_BOX_REWARD, SUPPLIES } from '../data/supplies';
import { pick, randRange } from '../core/mathx';
import type { Arena } from '../game/types';
import type { Tank } from './tank';

type PickupKind = SupplyKind | 'gold' | 'crystal';

interface Pickup {
  kind: PickupKind;
  pos: CANNON.Vec3;
  mesh: THREE.Object3D;
  /** Gold boxes fall from the sky; everything else spawns in place. */
  fallSpeed: number;
  groundY: number;
  radius: number;
  spin: number;
}

const BOX_RESPAWN = 22;
const GOLD_INTERVAL_DM: [number, number] = [70, 130];
const GOLD_INTERVAL_OTHER: [number, number] = [130, 220];
const GOLD_WARNING = 6;

/**
 * Supply boxes, crystal boxes and the Gold Box. Boxes spawn only in the map's
 * declared drop zones — predictable zones are what make box control a real
 * decision, and picking a supply up as a box bypasses Smart Cooldowns entirely.
 */
export class PickupSystem {
  private readonly pickups: Pickup[] = [];
  private readonly zoneTimers: number[];
  private goldTimer: number;
  private goldWarned = false;
  private pendingGoldZone: [number, number, number] | null = null;
  readonly goldMarker = new THREE.Object3D();

  private readonly boxGeo = new THREE.BoxGeometry(2, 2, 2);
  private readonly goldGeo = new THREE.BoxGeometry(3, 3, 3);
  private readonly frameGeo = new THREE.TorusGeometry(1.5, 0.12, 6, 4);
  // Halos used to be built per box and never freed, which leaked a geometry and
  // a material every time a supply zone respawned — one shared pair each.
  private readonly haloGeo = new THREE.RingGeometry(1.8, 2.2, 24);
  private readonly goldHaloGeo = new THREE.RingGeometry(2.6, 3.2, 28);
  private readonly beaconGeo = new THREE.CylinderGeometry(2.6, 2.6, 60, 18, 1, true);
  private readonly materials = new Map<number, THREE.MeshStandardMaterial>();
  private readonly haloMaterials = new Map<number, THREE.MeshBasicMaterial>();
  private readonly beaconMaterial: THREE.MeshBasicMaterial;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly def: MapDef,
    private readonly enabled: boolean,
    goldEnabled: boolean,
    isDeathmatch: boolean,
  ) {
    this.zoneTimers = def.supplyZones.map(() => randRange(2, 10));
    const range = isDeathmatch ? GOLD_INTERVAL_DM : GOLD_INTERVAL_OTHER;
    this.goldTimer = goldEnabled && def.goldBoxZones.length ? randRange(range[0] * 0.5, range[1] * 0.7) : Infinity;
    this.goldRange = range;

    // The landing marker used to be an empty Object3D, so the warning that a
    // Gold Box was inbound pointed at nothing you could actually see in the
    // world. It is now a column of light standing on the drop zone.
    this.beaconMaterial = new THREE.MeshBasicMaterial({
      color: 0xffd700,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const column = new THREE.Mesh(this.beaconGeo, this.beaconMaterial);
    column.position.y = 30;
    const pad = new THREE.Mesh(this.goldHaloGeo, this.beaconMaterial);
    pad.rotation.x = -Math.PI / 2;
    pad.position.y = 0.15;
    this.goldMarker.add(column, pad);
    this.goldMarker.visible = false;
    scene.add(this.goldMarker);
  }

  private readonly goldRange: [number, number];

  update(dt: number, arena: Arena): void {
    if (this.enabled) this.updateZones(dt);
    this.updateGold(dt, arena);
    this.updatePickups(dt, arena);
  }

  private updateZones(dt: number): void {
    for (let i = 0; i < this.def.supplyZones.length; i++) {
      const zone = this.def.supplyZones[i];
      const live = this.pickups.some(
        (p) => p.kind !== 'gold' && Math.hypot(p.pos.x - zone.pos[0], p.pos.z - zone.pos[2]) < 3,
      );
      if (live) continue;
      this.zoneTimers[i] -= dt;
      if (this.zoneTimers[i] > 0) continue;
      this.zoneTimers[i] = BOX_RESPAWN + randRange(-4, 6);
      // Lower-value crystal boxes share the same zones.
      const kind: PickupKind = Math.random() < 0.18 ? 'crystal' : pick(zone.types);
      this.spawn(kind, new CANNON.Vec3(zone.pos[0], zone.pos[1] + 1.2, zone.pos[2]), 0);
    }
  }

  private updateGold(dt: number, arena: Arena): void {
    if (this.goldMarker.visible) {
      // Beats faster as the drop gets closer, so the warning has urgency.
      const urgency = 1 + (GOLD_WARNING - Math.max(0, this.goldTimer)) * 1.2;
      this.beaconMaterial.opacity = 0.1 + Math.abs(Math.sin(arena.time * urgency * 2.2)) * 0.2;
    }
    if (!isFinite(this.goldTimer)) return;
    this.goldTimer -= dt;
    if (!this.goldWarned && this.goldTimer <= GOLD_WARNING) {
      this.goldWarned = true;
      this.pendingGoldZone = pick(this.def.goldBoxZones);
      arena.notify('Gold Box incoming!', 'gold');
      this.goldMarker.position.set(this.pendingGoldZone[0], this.pendingGoldZone[1], this.pendingGoldZone[2]);
      this.goldMarker.visible = true;
    }
    if (this.goldTimer <= 0) {
      const zone = this.pendingGoldZone ?? pick(this.def.goldBoxZones);
      this.spawn('gold', new CANNON.Vec3(zone[0], zone[1] + 90, zone[2]), zone[1] + 2);
      arena.notify('Gold Box has landed', 'gold');
      this.goldTimer = randRange(this.goldRange[0], this.goldRange[1]);
      this.goldWarned = false;
      this.pendingGoldZone = null;
      this.goldMarker.visible = false;
    }
  }

  private updatePickups(dt: number, arena: Arena): void {
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i];
      if (p.fallSpeed > 0 || p.pos.y > p.groundY) {
        p.fallSpeed += 30 * dt;
        p.pos.y = Math.max(p.groundY, p.pos.y - p.fallSpeed * dt);
        if (p.pos.y <= p.groundY) p.fallSpeed = 0;
      }
      p.spin += dt * (p.kind === 'gold' ? 1.6 : 0.9);
      p.mesh.position.set(p.pos.x, p.pos.y + Math.sin(p.spin * 1.5) * 0.18, p.pos.z);
      p.mesh.rotation.y = p.spin;

      for (const tank of arena.tanks) {
        if (!tank.alive) continue;
        const d = Math.hypot(
          tank.position.x - p.pos.x,
          (tank.position.y - p.pos.y) * 0.6,
          tank.position.z - p.pos.z,
        );
        if (d > p.radius + tank.hull.size[0] * 0.6) continue;
        this.collect(p, tank, arena);
        this.scene.remove(p.mesh);
        this.pickups.splice(i, 1);
        break;
      }
    }
  }

  private collect(p: Pickup, tank: Tank, arena: Arena): void {
    if (p.kind === 'gold') {
      tank.crystals += GOLD_BOX_REWARD;
      tank.addBattlePoints(15);
      arena.notify(`${tank.name} took the Gold Box (+${GOLD_BOX_REWARD})`, 'gold');
      arena.fx.supplyBurst(p.pos, 0xffd700, 2.2);
      return;
    }
    if (p.kind === 'crystal') {
      tank.crystals += CRYSTAL_BOX_REWARD;
      arena.fx.supplyBurst(p.pos, 0x67e8f9);
      return;
    }
    // Box pickups bypass Smart Cooldowns — that is the point of box control.
    tank.giveSupply(p.kind);
    if (tank.isPlayer) {
      arena.notify(`Picked up ${SUPPLIES[p.kind].displayName}`, 'info');
    } else if (tank.isBoss) {
      // The raid boss banks it rather than burning it on pickup: its own logic
      // decides when a kit is worth spending, and the raid gets told it lost the
      // box so that contesting one reads as having mattered.
      arena.notify(`${tank.name} took the ${SUPPLIES[p.kind].displayName}`, 'warning');
    } else if (Math.random() < 0.7) {
      tank.applySupply(p.kind, arena);
      tank.supplies[p.kind].count = Math.max(0, tank.supplies[p.kind].count - 1);
    }
    arena.fx.supplyBurst(p.pos, SUPPLIES[p.kind].colour);
    arena.onSupplyPicked?.(tank, p.kind);
  }

  private spawn(kind: PickupKind, pos: CANNON.Vec3, groundY: number): void {
    const gold = kind === 'gold';
    const colour = gold ? 0xffd700 : kind === 'crystal' ? 0x22d3ee : SUPPLIES[kind].colour;
    const mesh = new THREE.Mesh(gold ? this.goldGeo : this.boxGeo, this.material(colour));
    mesh.castShadow = true;
    mesh.position.set(pos.x, pos.y, pos.z);

    // Corner frame, so a box reads as a crate rather than a coloured cube.
    const frame = new THREE.Mesh(this.frameGeo, this.material(colour));
    frame.scale.setScalar(gold ? 1.42 : 0.95);
    frame.rotation.set(Math.PI / 4, Math.PI / 4, 0);
    mesh.add(frame);

    const halo = new THREE.Mesh(gold ? this.goldHaloGeo : this.haloGeo, this.haloMaterial(colour));
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = -0.9;
    mesh.add(halo);

    this.scene.add(mesh);
    this.pickups.push({
      kind,
      pos: pos.clone(),
      mesh,
      fallSpeed: gold ? 4 : 0,
      groundY,
      radius: gold ? 3.4 : 2.4,
      spin: Math.random() * 6,
    });
  }

  /** Positions for the minimap, including a pending gold-box landing zone. */
  markers(): { x: number; z: number; colour: number; gold: boolean }[] {
    const out = this.pickups.map((p) => ({
      x: p.pos.x,
      z: p.pos.z,
      colour: p.kind === 'gold' ? 0xffd700 : p.kind === 'crystal' ? 0x22d3ee : SUPPLIES[p.kind].colour,
      gold: p.kind === 'gold',
    }));
    if (this.pendingGoldZone) {
      out.push({ x: this.pendingGoldZone[0], z: this.pendingGoldZone[2], colour: 0xffd700, gold: true });
    }
    return out;
  }

  /** Bots ask for this to decide whether to contest a box. */
  nearest(from: CANNON.Vec3, kinds?: PickupKind[]): { pos: CANNON.Vec3; kind: PickupKind; value: number } | null {
    let best: Pickup | null = null;
    let bestD = Infinity;
    for (const p of this.pickups) {
      if (kinds && !kinds.includes(p.kind)) continue;
      const d = p.pos.distanceTo(from);
      const weighted = p.kind === 'gold' ? d * 0.35 : d;
      if (weighted < bestD) {
        bestD = weighted;
        best = p;
      }
    }
    if (!best) return null;
    return { pos: best.pos, kind: best.kind, value: best.kind === 'gold' ? 3 : 1 };
  }

  private material(colour: number): THREE.MeshStandardMaterial {
    let m = this.materials.get(colour);
    if (!m) {
      m = new THREE.MeshStandardMaterial({
        color: colour,
        emissive: colour,
        emissiveIntensity: 0.5,
        roughness: 0.4,
        metalness: 0.2,
      });
      this.materials.set(colour, m);
    }
    return m;
  }

  private haloMaterial(colour: number): THREE.MeshBasicMaterial {
    let m = this.haloMaterials.get(colour);
    if (!m) {
      m = new THREE.MeshBasicMaterial({
        color: colour,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
        depthWrite: false,
        toneMapped: false,
      });
      this.haloMaterials.set(colour, m);
    }
    return m;
  }

  dispose(): void {
    for (const p of this.pickups) this.scene.remove(p.mesh);
    this.pickups.length = 0;
    this.goldMarker.clear();
    this.scene.remove(this.goldMarker);
    this.boxGeo.dispose();
    this.goldGeo.dispose();
    this.frameGeo.dispose();
    this.haloGeo.dispose();
    this.goldHaloGeo.dispose();
    this.beaconGeo.dispose();
    this.beaconMaterial.dispose();
    for (const m of this.materials.values()) m.dispose();
    for (const m of this.haloMaterials.values()) m.dispose();
  }
}

interface Mine {
  owner: Tank;
  pos: CANNON.Vec3;
  mesh: THREE.Mesh;
  armTimer: number;
  life: number;
}

/** Proximity mines. They vanish when their owner is destroyed. */
export class MineSystem {
  private readonly mines: Mine[] = [];
  private readonly geo = new THREE.CylinderGeometry(1.1, 1.1, 0.35, 12);

  constructor(private readonly scene: THREE.Scene) {}

  spawn(owner: Tank, pos: CANNON.Vec3): void {
    const def = SUPPLIES.mine;
    const material = new THREE.MeshStandardMaterial({
      color: def.colour,
      emissive: def.colour,
      emissiveIntensity: 0.35,
      transparent: true,
      opacity: 0.85,
    });
    const mesh = new THREE.Mesh(this.geo, material);
    mesh.position.set(pos.x, pos.y - 0.4, pos.z);
    this.scene.add(mesh);
    this.mines.push({ owner, pos: pos.clone(), mesh, armTimer: def.armTime ?? 1.5, life: 240 });
  }

  update(dt: number, arena: Arena): void {
    for (let i = this.mines.length - 1; i >= 0; i--) {
      const m = this.mines[i];
      m.armTimer -= dt;
      m.life -= dt;
      const armed = m.armTimer <= 0;
      (m.mesh.material as THREE.MeshStandardMaterial).opacity = armed ? 0.55 : 0.9;

      if (!m.owner.alive || m.life <= 0) {
        this.remove(i);
        continue;
      }
      if (!armed) continue;

      const trigger = arena.tanks.find(
        (t) =>
          t.alive &&
          t !== m.owner &&
          arena.areEnemies(m.owner, t) &&
          t.position.distanceTo(m.pos) < 3.2 &&
          t.spawnProtection <= 0,
      );
      if (!trigger) continue;

      const def = SUPPLIES.mine;
      arena.splash(m.pos, def.radius ?? 8, def.damage ?? 1800, (def.damage ?? 1800) * 0.4, m.owner, {
        selfDamage: false,
        impactForce: 2.0,
      });
      arena.fx.explosion(m.pos, def.radius ?? 8, def.colour);
      this.remove(i);
    }
  }

  /** Rampage drives through mines and destroys them on contact. */
  clearNear(pos: CANNON.Vec3, radius: number): void {
    for (let i = this.mines.length - 1; i >= 0; i--) {
      if (this.mines[i].pos.distanceTo(pos) <= radius) this.remove(i);
    }
  }

  visibleTo(tank: Tank, arena: Arena): { x: number; z: number }[] {
    return this.mines
      .filter((m) => m.owner === tank || arena.areAllies(m.owner, tank))
      .map((m) => ({ x: m.pos.x, z: m.pos.z }));
  }

  private remove(i: number): void {
    const m = this.mines[i];
    this.scene.remove(m.mesh);
    (m.mesh.material as THREE.Material).dispose();
    this.mines.splice(i, 1);
  }

  dispose(): void {
    while (this.mines.length) this.remove(this.mines.length - 1);
    this.geo.dispose();
  }
}
