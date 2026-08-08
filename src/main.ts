import * as THREE from 'three';
import { Input } from './core/input';
import { Battle, type PlayerLoadout } from './game/battle';
import { Hud } from './render/hud';
import { Menu, type MenuResult } from './ui/menu';
import { validateMaps } from './data/maps/validate';
import type { BattleSettings } from './data/modes';
import './style.css';

const app = document.getElementById('app')!;

const glCanvas = document.createElement('canvas');
glCanvas.className = 'gl';
app.appendChild(glCanvas);

const hudCanvas = document.createElement('canvas');
hudCanvas.className = 'hud';
app.appendChild(hudCanvas);

const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
// PCFSoftShadowMap is deprecated in current three and silently downgrades to
// PCFShadowMap while logging a warning every session; ask for what we get.
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const hud = new Hud(hudCanvas);
const menu = new Menu(app);

let battle: Battle | null = null;
let paused = true;

const input = new Input({
  onEscape: () => {
    if (!battle) return;
    if (menu.visible) {
      resume();
    } else {
      openMenu();
    }
  },
});

function startBattle(result: MenuResult): void {
  battle?.dispose();
  battle = new Battle(result.settings, result.loadout, window.innerWidth / window.innerHeight);
  menu.hide();
  paused = false;
  input.setEnabled(true);
  hudCanvas.classList.remove('dim');
}

function openMenu(): void {
  paused = true;
  input.setEnabled(false);
  menu.show(startBattle);
  hudCanvas.classList.add('dim');
}

function resume(): void {
  if (!battle) return;
  menu.hide();
  paused = false;
  input.setEnabled(true);
  hudCanvas.classList.remove('dim');
}

menu.show(startBattle);

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  hud.resize();
  battle?.resize(window.innerWidth / window.innerHeight);
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'Tab') {
    hud.showScoreboard = true;
    e.preventDefault();
  }
  if (e.code === 'KeyV' && battle && !paused) battle.camera.toggleFirstPerson();
  if (e.code === 'KeyK' && battle && !paused) battle.keyHeldSelfDestruct = true;
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Tab') hud.showScoreboard = false;
  if (e.code === 'KeyK' && battle) battle.keyHeldSelfDestruct = false;
});

// Fixed-ish timestep. Long frames are clamped rather than integrated whole, so
// a background tab does not teleport every projectile on return.
const MAX_STEP = 1 / 20;
let last = performance.now();

function frame(now: number): void {
  requestAnimationFrame(frame);
  const raw = (now - last) / 1000;
  last = now;
  const dt = Math.min(raw, MAX_STEP);

  if (battle) {
    if (!paused) {
      battle.update(dt, input.sample());
    }
    renderer.render(battle.scene, battle.camera.camera);
    hud.draw(battle, battle.snapshot());
  }
}
requestAnimationFrame(frame);

// Surfaced for quick tinkering from the console during tuning.
declare global {
  interface Window {
    tankArena?: {
      battle: () => Battle | null;
      restart: (settings?: Partial<BattleSettings>, loadout?: Partial<PlayerLoadout>) => void;
      validateMaps: typeof validateMaps;
    };
  }
}
window.tankArena = {
  battle: () => battle,
  validateMaps,
  restart(settings, loadout) {
    if (!battle) return;
    startBattle({
      settings: { ...battle.settings, ...settings },
      loadout: {
        hull: battle.player.hull.id,
        turret: battle.player.turretDef.id,
        name: battle.player.name,
        ...loadout,
      },
    });
  },
};
