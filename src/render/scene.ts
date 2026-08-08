import * as THREE from 'three';
import type { MapDef, PropDef } from '../data/schema';
import { rampMeshVertices } from '../physics/world';
import { groundMaterial, hazeColour, propMaterial, skyMaterialTexture } from './materials';

export interface SceneBundle {
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  /** One mesh per entry in `MapDef.props`, in the same order as the colliders. */
  props: THREE.Mesh[];
  dispose(): void;
}

/** One texture tile per 5 m, matching the grid the maps are authored on. */
const TILE = 5;

export function createScene(def: MapDef): SceneBundle {
  const scene = new THREE.Scene();
  const haze = hazeColour(def.theme);

  // A gradient sky with a sun bloom and a horizon band. A flat clear colour
  // reads as a missing skybox, and it gives distant geometry nothing to
  // dissolve into.
  scene.background = skyMaterialTexture(def.theme);
  const far = Math.max(def.bounds.x, def.bounds.z) * 3.2;
  scene.fog = new THREE.Fog(haze, far * 0.4, far);

  // Fill matters more than key light here. Surfaces the sun misses have only
  // the ambient terms to read by, and with a dark hemisphere ground term every
  // wall facing away from the sun collapses to solid black.
  const hemi = new THREE.HemisphereLight(haze, 0x50565f, def.theme === 'space' ? 0.7 : 0.95);
  scene.add(hemi);
  scene.add(new THREE.AmbientLight(0xffffff, def.theme === 'space' ? 0.22 : 0.3));

  const sun = new THREE.DirectionalLight(0xfff3e0, def.theme === 'space' ? 0.85 : 1.2);
  sun.position.set(90, 140, 60);
  sun.castShadow = true;
  const span = Math.max(def.bounds.x, def.bounds.z) * 1.15;
  sun.shadow.camera.left = -span;
  sun.shadow.camera.right = span;
  sun.shadow.camera.top = span;
  sun.shadow.camera.bottom = -span;
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 500;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0008;
  scene.add(sun);
  scene.add(sun.target);

  // Rim light from behind and opposite the sun. It costs nothing (no shadow
  // map) and it is what separates a tank's silhouette from the wall behind it,
  // which is most of the difference between "boxes" and "vehicles".
  const rim = new THREE.DirectionalLight(def.theme === 'space' ? 0x8ea0ff : 0xbcd4ff, 0.45);
  rim.position.set(-70, 50, -90);
  scene.add(rim);

  const owned: (THREE.BufferGeometry | THREE.Material)[] = [];

  // The visual ground matches the physics ground box, so there is no ring of
  // invisible floor outside the painted plane.
  const groundW = def.bounds.x * 2 + 120;
  const groundD = def.bounds.z * 2 + 120;
  const groundGeo = new THREE.PlaneGeometry(groundW, groundD);
  scaleUv(groundGeo, groundW / TILE, groundD / TILE);
  owned.push(groundGeo);
  const ground = new THREE.Mesh(groundGeo, groundMaterial(def.theme));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Faint 5 m grid so distances read on sight — the same grid the props use.
  const grid = new THREE.GridHelper(
    Math.max(def.bounds.x, def.bounds.z) * 2,
    Math.round((Math.max(def.bounds.x, def.bounds.z) * 2) / TILE),
    0x000000,
    0x000000,
  );
  (grid.material as THREE.Material).opacity = 0.05;
  (grid.material as THREE.Material).transparent = true;
  grid.position.y = 0.02;
  owned.push(grid.geometry, grid.material as THREE.Material);
  scene.add(grid);

  const props: THREE.Mesh[] = [];
  for (const p of def.props) {
    const mesh = buildProp(p, owned);
    scene.add(mesh);
    props.push(mesh);
  }

  return {
    scene,
    sun,
    props,
    dispose() {
      for (const o of owned) o.dispose();
      scene.clear();
    },
  };
}

/**
 * Rescales a geometry's UVs so one texture tile always covers the same number
 * of metres. Box UVs run 0..1 per face regardless of the box's size, so without
 * this a 200 m perimeter wall and a 4 m crate wear the same single stretched
 * tile and the arena loses all sense of scale.
 */
function scaleUv(geo: THREE.BufferGeometry, u: number, v: number): void {
  const uv = geo.getAttribute('uv');
  if (!uv) return;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * u, uv.getY(i) * v);
  }
  uv.needsUpdate = true;
}

function buildProp(p: PropDef, owned: (THREE.BufferGeometry | THREE.Material)[]): THREE.Mesh {
  const [w, h, d] = p.size;
  let geo: THREE.BufferGeometry;
  if (p.kind === 'ramp') {
    geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(rampMeshVertices(w, h, d), 3));
    geo.computeVertexNormals();
    // The ramp mesh is built by hand and carries no UVs, so project them off
    // world X/Z — good enough for a wedge, and it keeps the tiling consistent.
    geo.setAttribute('uv', new THREE.BufferAttribute(planarUv(geo, TILE), 2));
  } else if (p.kind === 'cylinder') {
    geo = new THREE.CylinderGeometry(w / 2, w / 2, h, 18);
    scaleUv(geo, (Math.PI * w) / TILE, h / TILE);
  } else {
    geo = new THREE.BoxGeometry(w, h, d);
    // Boxes share one UV set across all six faces; using the largest in-plane
    // pair keeps the tile square-ish on the faces that matter most.
    scaleUv(geo, Math.max(w, d) / TILE, Math.max(h, d) / TILE);
  }
  owned.push(geo);
  const mesh = new THREE.Mesh(geo, propMaterial(p.material));
  mesh.position.set(p.pos[0], p.pos[1], p.pos[2]);
  mesh.rotation.y = ((p.rot ?? 0) * Math.PI) / 180;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Triplanar-ish UVs: project each vertex onto whichever plane its normal faces. */
function planarUv(geo: THREE.BufferGeometry, tile: number): Float32Array {
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const ax = Math.abs(nrm.getX(i));
    const ay = Math.abs(nrm.getY(i));
    const az = Math.abs(nrm.getZ(i));
    let u: number;
    let v: number;
    if (ay >= ax && ay >= az) {
      u = x;
      v = z;
    } else if (ax >= az) {
      u = z;
      v = y;
    } else {
      u = x;
      v = y;
    }
    uv[i * 2] = u / tile;
    uv[i * 2 + 1] = v / tile;
  }
  return uv;
}
