import * as THREE from 'three';
import type { MapDef, PropDef } from '../data/schema';
import { rampMeshVertices } from '../physics/world';
import { groundMaterial, propMaterial, skyColour } from './materials';

export interface SceneBundle {
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  dispose(): void;
}

export function createScene(def: MapDef): SceneBundle {
  const scene = new THREE.Scene();
  const sky = skyColour(def.theme);
  scene.background = new THREE.Color(sky);
  const far = Math.max(def.bounds.x, def.bounds.z) * 3.2;
  scene.fog = new THREE.Fog(sky, far * 0.35, far);

  // Fill matters more than key light here. Everything is untextured primitives,
  // so a surface the sun misses has nothing else to read by — with a dark
  // hemisphere ground term, shadowed geometry and every wall facing away from
  // the sun collapse to solid black and the map becomes unreadable.
  const hemi = new THREE.HemisphereLight(sky, 0x5c6470, def.theme === 'space' ? 0.75 : 1.05);
  scene.add(hemi);
  scene.add(new THREE.AmbientLight(0xffffff, def.theme === 'space' ? 0.25 : 0.35));

  const sun = new THREE.DirectionalLight(0xfff3e0, def.theme === 'space' ? 0.8 : 1.15);
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

  const owned: (THREE.BufferGeometry | THREE.Material)[] = [];

  const groundGeo = new THREE.PlaneGeometry(def.bounds.x * 2 + 40, def.bounds.z * 2 + 40);
  owned.push(groundGeo);
  const ground = new THREE.Mesh(groundGeo, groundMaterial(def.theme));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Faint 5 m grid so distances read on sight — the same grid the props use.
  const grid = new THREE.GridHelper(
    Math.max(def.bounds.x, def.bounds.z) * 2,
    Math.round((Math.max(def.bounds.x, def.bounds.z) * 2) / 5),
    0x000000,
    0x000000,
  );
  (grid.material as THREE.Material).opacity = 0.06;
  (grid.material as THREE.Material).transparent = true;
  grid.position.y = 0.02;
  scene.add(grid);

  for (const p of def.props) {
    const mesh = buildProp(p, owned);
    scene.add(mesh);
  }

  return {
    scene,
    sun,
    dispose() {
      for (const o of owned) o.dispose();
      scene.clear();
    },
  };
}

function buildProp(p: PropDef, owned: (THREE.BufferGeometry | THREE.Material)[]): THREE.Mesh {
  const [w, h, d] = p.size;
  let geo: THREE.BufferGeometry;
  if (p.kind === 'ramp') {
    geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(rampMeshVertices(w, h, d), 3));
    geo.computeVertexNormals();
  } else if (p.kind === 'cylinder') {
    geo = new THREE.CylinderGeometry(w / 2, w / 2, h, 14);
  } else {
    geo = new THREE.BoxGeometry(w, h, d);
  }
  owned.push(geo);
  const mesh = new THREE.Mesh(geo, propMaterial(p.material));
  mesh.position.set(p.pos[0], p.pos[1], p.pos[2]);
  mesh.rotation.y = ((p.rot ?? 0) * Math.PI) / 180;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
