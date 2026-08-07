import * as THREE from 'three';
import type * as CANNON from 'cannon-es';
import type { HullDef, TeamId, TurretDef } from '../data/schema';
import { hullMaterial, trackMaterial, turretMaterial } from './materials';

export interface TankMesh {
  root: THREE.Group;
  turret: THREE.Group;
  barrel: THREE.Group;
  setShield(on: boolean): void;
  setBeam(target: CANNON.Vec3 | null, colour: number): void;
  setStream(on: boolean, colour: number): void;
  setCarrying(team: TeamId | null): void;
  dispose(): void;
}

/**
 * Original geometry built from primitives — deliberately not a rip of anything.
 * Silhouettes differ by hull class so you can read a Mammoth from a Wasp at
 * distance, which matters more for readability than surface detail.
 */
export function buildTankMesh(
  hull: HullDef,
  turretDef: TurretDef,
  team: TeamId,
  isPlayer: boolean,
): TankMesh {
  const [w, h, d] = hull.size;
  const root = new THREE.Group();
  const owned: (THREE.BufferGeometry | THREE.Material)[] = [];

  const bodyGeo = new THREE.BoxGeometry(w, h, d);
  owned.push(bodyGeo);
  const body = new THREE.Mesh(bodyGeo, hullMaterial(team, isPlayer));
  body.castShadow = true;
  body.receiveShadow = true;
  root.add(body);

  // Glacis plate: a cheap way to give the hull a front.
  const noseGeo = new THREE.BoxGeometry(w * 0.9, h * 0.5, d * 0.22);
  owned.push(noseGeo);
  const nose = new THREE.Mesh(noseGeo, turretMaterial(team, isPlayer));
  nose.position.set(0, h * 0.15, d * 0.48);
  nose.rotation.x = -0.35;
  root.add(nose);

  if (hull.hover) {
    const skirtGeo = new THREE.BoxGeometry(w * 1.05, h * 0.35, d * 1.02);
    owned.push(skirtGeo);
    const skirt = new THREE.Mesh(skirtGeo, trackMaterial());
    skirt.position.y = -h * 0.55;
    root.add(skirt);
    for (const sx of [-1, 1]) {
      const podGeo = new THREE.CylinderGeometry(w * 0.16, w * 0.16, d * 0.6, 8);
      owned.push(podGeo);
      const pod = new THREE.Mesh(podGeo, turretMaterial(team, isPlayer));
      pod.rotation.z = Math.PI / 2;
      pod.rotation.y = Math.PI / 2;
      pod.position.set(sx * w * 0.52, -h * 0.35, 0);
      root.add(pod);
    }
  } else {
    for (const sx of [-1, 1]) {
      const trackGeo = new THREE.BoxGeometry(w * 0.26, h * 0.9, d * 1.04);
      owned.push(trackGeo);
      const track = new THREE.Mesh(trackGeo, trackMaterial());
      track.position.set(sx * (w * 0.5 + w * 0.06), -h * 0.15, 0);
      track.castShadow = true;
      root.add(track);
    }
  }

  // ---- turret ----------------------------------------------------------
  const turret = new THREE.Group();
  turret.position.y = hull.turretMountHeight * 0.6;
  if (!hull.centredTurret) turret.position.z = -d * 0.08;
  root.add(turret);

  const domeGeo = new THREE.CylinderGeometry(w * 0.34, w * 0.4, h * 0.85, 10);
  owned.push(domeGeo);
  const dome = new THREE.Mesh(domeGeo, turretMaterial(team, isPlayer));
  dome.castShadow = true;
  turret.add(dome);

  const barrel = new THREE.Group();
  barrel.position.y = h * 0.1;
  turret.add(barrel);

  buildBarrel(turretDef, d, barrel, owned, team, isPlayer);

  // ---- overlays --------------------------------------------------------
  const shieldGeo = new THREE.SphereGeometry(Math.max(w, d) * 0.72, 14, 10);
  const shieldMat = new THREE.MeshBasicMaterial({
    color: 0x7dd3fc,
    transparent: true,
    opacity: 0.22,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  owned.push(shieldGeo, shieldMat);
  const shield = new THREE.Mesh(shieldGeo, shieldMat);
  shield.visible = false;
  root.add(shield);

  const beamMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, toneMapped: false });
  const beamGeo = new THREE.CylinderGeometry(0.14, 0.14, 1, 6, 1, true);
  owned.push(beamGeo, beamMat);
  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.visible = false;
  root.add(beam);

  const streamMat = new THREE.MeshBasicMaterial({
    color: 0xff7a2f,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const coneRange = turretDef.cone?.range ?? 14;
  const coneRadius = Math.tan(((turretDef.cone?.angleDeg ?? 30) * 0.5 * Math.PI) / 180) * coneRange;
  const streamGeo = new THREE.ConeGeometry(coneRadius, coneRange, 12, 1, true);
  owned.push(streamGeo, streamMat);
  const stream = new THREE.Mesh(streamGeo, streamMat);
  stream.rotation.x = Math.PI / 2;
  stream.position.z = coneRange / 2;
  stream.visible = false;
  barrel.add(stream);

  const flagGeo = new THREE.BoxGeometry(0.2, 2.4, 0.2);
  const flagClothGeo = new THREE.PlaneGeometry(1.8, 1.1);
  const flagMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  owned.push(flagGeo, flagClothGeo, flagMat);
  const flagGroup = new THREE.Group();
  const pole = new THREE.Mesh(flagGeo, trackMaterial());
  pole.position.y = 1.2;
  const cloth = new THREE.Mesh(flagClothGeo, flagMat);
  cloth.position.set(0.9, 1.8, 0);
  flagGroup.add(pole, cloth);
  flagGroup.position.y = h * 0.6 + hull.turretMountHeight * 0.6;
  flagGroup.visible = false;
  root.add(flagGroup);

  const beamStart = new THREE.Vector3();
  const beamEnd = new THREE.Vector3();

  return {
    root,
    turret,
    barrel,
    setShield(on: boolean) {
      shield.visible = on;
    },
    setBeam(target: CANNON.Vec3 | null, colour: number) {
      if (!target) {
        beam.visible = false;
        return;
      }
      beamEnd.set(target.x, target.y, target.z);
      root.worldToLocal(beamEnd);
      beamStart.set(turret.position.x, turret.position.y, turret.position.z);
      const dir = beamEnd.clone().sub(beamStart);
      const len = dir.length();
      if (len < 0.05) {
        beam.visible = false;
        return;
      }
      beam.visible = true;
      beamMat.color.setHex(colour);
      beam.position.copy(beamStart).addScaledVector(dir, 0.5);
      beam.scale.set(1, len, 1);
      beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    },
    setStream(on: boolean, colour: number) {
      stream.visible = on;
      if (on) streamMat.color.setHex(colour);
    },
    setCarrying(carried: TeamId | null) {
      flagGroup.visible = carried !== null;
      if (carried) flagMat.color.setHex(carried === 'red' ? 0xe0483c : 0x3c7ce0);
    },
    dispose() {
      for (const o of owned) o.dispose();
    },
  };
}

function buildBarrel(
  def: TurretDef,
  d: number,
  barrel: THREE.Group,
  owned: (THREE.BufferGeometry | THREE.Material)[],
  team: TeamId,
  isPlayer: boolean,
): void {
  const mat = turretMaterial(team, isPlayer);
  const add = (geo: THREE.BufferGeometry, x: number, y: number, z: number) => {
    owned.push(geo);
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = Math.PI / 2;
    m.position.set(x, y, z);
    m.castShadow = true;
    barrel.add(m);
  };

  const len = barrelLength(def, d);
  switch (def.fireMode) {
    case 'sustained':
      for (const sx of [-0.4, 0.4]) add(new THREE.CylinderGeometry(0.14, 0.16, len, 8), sx, 0, len / 2);
      break;
    case 'minigun': {
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        add(new THREE.CylinderGeometry(0.09, 0.09, len, 6), Math.cos(a) * 0.24, Math.sin(a) * 0.24, len / 2);
      }
      add(new THREE.CylinderGeometry(0.42, 0.42, len * 0.35, 10), 0, 0, len * 0.18);
      break;
    }
    case 'cone':
      add(new THREE.CylinderGeometry(0.34, 0.2, len, 10), 0, 0, len / 2);
      break;
    case 'beam':
    case 'chain':
      add(new THREE.CylinderGeometry(0.16, 0.3, len, 10), 0, 0, len / 2);
      add(new THREE.TorusGeometry(0.42, 0.09, 6, 12), 0, 0, len * 0.85);
      break;
    case 'shotgun':
      add(new THREE.CylinderGeometry(0.32, 0.34, len, 10), 0, 0, len / 2);
      break;
    case 'sniper':
      add(new THREE.CylinderGeometry(0.12, 0.14, len, 8), 0, 0, len / 2);
      add(new THREE.BoxGeometry(0.28, 0.28, len * 0.4), 0, 0.34, len * 0.3);
      break;
    case 'ballistic':
      add(new THREE.CylinderGeometry(0.3, 0.36, len * 0.8, 10), 0, 0, len * 0.4);
      break;
    case 'guided':
      add(new THREE.BoxGeometry(0.9, 0.55, len * 0.7), 0, 0.1, len * 0.35);
      break;
    default:
      add(new THREE.CylinderGeometry(0.2, 0.26, len, 10), 0, 0, len / 2);
      break;
  }
}

function barrelLength(def: TurretDef, hullDepth: number): number {
  const base = hullDepth * 0.5;
  switch (def.class) {
    case 'short-range':
      return base * 0.8;
    case 'medium-range':
      return base * 1.15;
    default:
      return base * 1.5;
  }
}
