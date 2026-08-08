import { HULLS, HULL_IDS, TURRETS, TURRET_IDS, preferredRange } from '../data';
import { DIFFICULTIES, DIFFICULTY_IDS } from '../data/difficulty';
import { MAPS, MAP_IDS, mapsForMode } from '../data/maps';
import { DEFAULT_SETTINGS, MODES, MODE_CODES, type BattleSettings } from '../data/modes';
import type { ModeCode } from '../data/schema';
import type { PlayerLoadout } from '../game/battle';

export interface MenuResult {
  settings: BattleSettings;
  loadout: PlayerLoadout;
}

const STORAGE_KEY = 'tank-arena:setup';

interface Persisted {
  settings: BattleSettings;
  loadout: PlayerLoadout;
}

function load(): Persisted {
  const fallback: Persisted = {
    settings: { ...DEFAULT_SETTINGS },
    loadout: { hull: 'hunter', turret: 'smoky', name: 'Commander' },
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      settings: { ...fallback.settings, ...parsed.settings },
      loadout: { ...fallback.loadout, ...parsed.loadout },
    };
  } catch {
    return fallback;
  }
}

function save(state: Persisted): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* private browsing — setup just won't persist */
  }
}

/**
 * Garage and battle setup. The equipment gap the difficulty profile applies is
 * shown here explicitly rather than hidden, because a legible advantage reads
 * as earned and an invisible one reads as cheating.
 */
export class Menu {
  readonly root: HTMLElement;
  private state = load();
  private onStart: ((result: MenuResult) => void) | null = null;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'menu';
    parent.appendChild(this.root);
    this.render();
  }

  show(onStart: (result: MenuResult) => void): void {
    this.onStart = onStart;
    this.root.classList.remove('hidden');
    this.render();
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  private render(): void {
    const { settings, loadout } = this.state;
    const profile = DIFFICULTIES[settings.difficulty] ?? DIFFICULTIES.standard;
    const hull = HULLS[loadout.hull];
    const turret = TURRETS[loadout.turret];
    const [near, far] = preferredRange(turret);

    const availableMaps = mapsForMode(settings.mode);
    if (!availableMaps.includes(settings.mapId)) settings.mapId = availableMaps[0] ?? MAP_IDS[0];
    const mapChoice = MAPS[settings.mapId];
    settings.botCount = Math.min(settings.botCount, mapChoice.maxPlayers - 1);

    this.root.innerHTML = `
      <div class="menu-inner">
        <header>
          <h1>Tank Arena</h1>
          <p class="sub">Browser 3D tank combat. You are the only human on the field.</p>
        </header>

        <div class="cols">
          <section class="card">
            <h2>Garage</h2>
            <label>Callsign
              <input id="name" type="text" maxlength="16" value="${escapeHtml(loadout.name)}" />
            </label>

            <label>Hull
              <select id="hull">
                ${HULL_IDS.map(
                  (id) =>
                    `<option value="${id}" ${id === loadout.hull ? 'selected' : ''}>${HULLS[id].displayName} — ${HULLS[id].class}</option>`,
                ).join('')}
              </select>
            </label>
            <div class="stats">
              <span><b>${Math.round(hull.protection * profile.player.hullTierMultiplier)}</b> hp</span>
              <span><b>${hull.topSpeed.toFixed(1)}</b> m/s</span>
              <span><b>${hull.turnSpeed}</b> °/s</span>
              <span><b>${hull.mass}</b> kg</span>
              ${hull.hover ? '<span class="tag">hover</span>' : ''}
            </div>
            <p class="hint"><b>${hull.overdrive.displayName}</b> — ${overdriveBlurb(hull.overdrive.effect)}</p>

            <label>Turret
              <select id="turret" ${hull.fixedTurret ? 'disabled' : ''}>
                ${TURRET_IDS.filter(
                  // A hull with a fixed turret mounts one that is not otherwise
                  // purchasable, so it has to be listed too — otherwise the
                  // disabled select shows the wrong gun's name.
                  (id) => TURRETS[id].purchasable !== false || id === loadout.turret,
                )
                  .map(
                    (id) =>
                      `<option value="${id}" ${id === loadout.turret ? 'selected' : ''}>${TURRETS[id].displayName} — ${TURRETS[id].class}</option>`,
                  )
                  .join('')}
              </select>
            </label>
            <div class="stats">
              <span><b>${Math.round(turret.damage * profile.player.turretTierMultiplier)}</b> dmg</span>
              <span><b>${turret.reloadTime.toFixed(2)}</b>s reload</span>
              <span><b>${turret.rotationSpeed}</b> °/s</span>
              <span><b>${Math.round(near)}–${Math.round(far)}</b> m band</span>
              ${(turret.special ?? []).map((s) => `<span class="tag">${s}</span>`).join('')}
            </div>
          </section>

          <section class="card">
            <h2>Battle</h2>
            <label>Mode
              <select id="mode">
                ${MODE_CODES.map(
                  (code) =>
                    `<option value="${code}" ${code === settings.mode ? 'selected' : ''}>${MODES[code].displayName}</option>`,
                ).join('')}
              </select>
            </label>
            <p class="hint">${MODES[settings.mode].blurb}</p>

            <label>Map
              <select id="map">
                ${availableMaps
                  .map(
                    (id) =>
                      `<option value="${id}" ${id === settings.mapId ? 'selected' : ''}>${MAPS[id].displayName} — ${MAPS[id].size}, up to ${MAPS[id].maxPlayers}</option>`,
                  )
                  .join('')}
              </select>
            </label>

            <label>Opponents <output id="botOut">${settings.botCount}</output>
              <input id="bots" type="range" min="1" max="${Math.max(1, mapChoice.maxPlayers - 1)}" value="${settings.botCount}" />
            </label>

            <label>Time limit <output id="timeOut">${Math.round(settings.timeLimit / 60)} min</output>
              <input id="time" type="range" min="2" max="15" value="${Math.round(settings.timeLimit / 60)}" />
            </label>

            <div class="toggles">
              <label class="check"><input id="ff" type="checkbox" ${settings.friendlyFire ? 'checked' : ''} /> Friendly fire</label>
              <label class="check"><input id="supplies" type="checkbox" ${settings.suppliesEnabled ? 'checked' : ''} /> Supply drops</label>
              <label class="check"><input id="gold" type="checkbox" ${settings.goldBoxEnabled ? 'checked' : ''} /> Gold Box</label>
            </div>
          </section>

          <section class="card">
            <h2>Difficulty</h2>
            <div class="difficulties">
              ${DIFFICULTY_IDS.map(
                (id) => `
                <button class="diff ${id === settings.difficulty ? 'active' : ''}" data-diff="${id}">
                  <b>${DIFFICULTIES[id].name}</b>
                  <span>${DIFFICULTIES[id].blurb}</span>
                </button>`,
              ).join('')}
            </div>
            <div class="ledger">
              <h3>Your edge</h3>
              <ul>
                <li>Hull ×${profile.player.hullTierMultiplier.toFixed(2)} vs bot ×${profile.bot.hullTierMultiplier.toFixed(2)}</li>
                <li>Turret ×${profile.player.turretTierMultiplier.toFixed(2)} vs bot ×${profile.bot.turretTierMultiplier.toFixed(2)}</li>
                <li>Bot reaction ${profile.bot.reactionDelayMs[0]}–${profile.bot.reactionDelayMs[1]} ms</li>
                <li>Bot aim error ${profile.bot.aimErrorDeg}° → floor ${profile.bot.minAimErrorDeg}°</li>
                <li>Bot field of view ${profile.bot.fovDegrees}°</li>
                <li>Overdrive charge ×${profile.player.overdriveChargeRate} vs ×${profile.bot.overdriveChargeRate}</li>
                <li>Aim assist ${Math.round(profile.player.aimAssistStrength * 100)}%${profile.dynamic.enabled ? ' · adaptive' : ''}</li>
              </ul>
            </div>
          </section>
        </div>

        <div class="controls-row">
          <div class="keys">
            <span><kbd>↑</kbd><kbd>↓</kbd> drive</span>
            <span><kbd>←</kbd><kbd>→</kbd> steer</span>
            <span><kbd>Z</kbd><kbd>X</kbd> turret</span>
            <span><kbd>Space</kbd> fire · hold &amp; release to charge</span>
            <span><kbd>C</kbd> centre turret</span>
            <span><kbd>Q</kbd> overdrive</span>
            <span><kbd>1</kbd>–<kbd>5</kbd> supplies</span>
            <span><kbd>R</kbd> flip</span>
            <span><kbd>Tab</kbd> scores</span>
            <span><kbd>V</kbd> view</span>
            <span><kbd>−</kbd><kbd>=</kbd> zoom</span>
            <span><kbd>Esc</kbd> menu</span>
          </div>
          <button id="start" class="primary">Enter battle</button>
        </div>
      </div>`;

    this.wire();
  }

  private wire(): void {
    const q = <T extends HTMLElement>(sel: string) => this.root.querySelector(sel) as T;
    const { settings, loadout } = this.state;

    q<HTMLInputElement>('#name').addEventListener('input', (e) => {
      loadout.name = (e.target as HTMLInputElement).value;
    });
    q<HTMLSelectElement>('#hull').addEventListener('change', (e) => {
      loadout.hull = (e.target as HTMLSelectElement).value;
      const fixed = HULLS[loadout.hull].fixedTurret;
      if (fixed) {
        loadout.turret = fixed;
      } else if (TURRETS[loadout.turret]?.purchasable === false) {
        // Leaving a fixed-turret hull must not carry its unbuyable gun along.
        loadout.turret = TURRET_IDS.find((id) => TURRETS[id].purchasable !== false) ?? 'smoky';
      }
      this.persistAndRender();
    });
    q<HTMLSelectElement>('#turret').addEventListener('change', (e) => {
      loadout.turret = (e.target as HTMLSelectElement).value;
      this.persistAndRender();
    });
    q<HTMLSelectElement>('#mode').addEventListener('change', (e) => {
      settings.mode = (e.target as HTMLSelectElement).value as ModeCode;
      this.persistAndRender();
    });
    q<HTMLSelectElement>('#map').addEventListener('change', (e) => {
      settings.mapId = (e.target as HTMLSelectElement).value;
      this.persistAndRender();
    });
    q<HTMLInputElement>('#bots').addEventListener('input', (e) => {
      settings.botCount = Number((e.target as HTMLInputElement).value);
      q<HTMLOutputElement>('#botOut').textContent = String(settings.botCount);
    });
    q<HTMLInputElement>('#time').addEventListener('input', (e) => {
      const minutes = Number((e.target as HTMLInputElement).value);
      settings.timeLimit = minutes * 60;
      q<HTMLOutputElement>('#timeOut').textContent = `${minutes} min`;
    });
    q<HTMLInputElement>('#ff').addEventListener('change', (e) => {
      settings.friendlyFire = (e.target as HTMLInputElement).checked;
    });
    q<HTMLInputElement>('#supplies').addEventListener('change', (e) => {
      settings.suppliesEnabled = (e.target as HTMLInputElement).checked;
    });
    q<HTMLInputElement>('#gold').addEventListener('change', (e) => {
      settings.goldBoxEnabled = (e.target as HTMLInputElement).checked;
    });
    for (const btn of this.root.querySelectorAll<HTMLButtonElement>('.diff')) {
      btn.addEventListener('click', () => {
        settings.difficulty = btn.dataset.diff!;
        this.persistAndRender();
      });
    }
    q<HTMLButtonElement>('#start').addEventListener('click', () => {
      save(this.state);
      this.onStart?.({ settings: { ...settings }, loadout: { ...loadout } });
    });
  }

  private persistAndRender(): void {
    save(this.state);
    this.render();
  }
}

function overdriveBlurb(effect: string): string {
  const map: Record<string, string> = {
    timedBomb: 'drops a timed N2 charge without losing speed',
    revealEnemies: 'reveals every enemy on the map for a while',
    launchAndStun: 'detonates beneath you, launching the hull and stunning nearby enemies',
    disarm: 'EMP burst that disarms nearby enemy turrets',
    piercingFreeze: 'long-range icicle that freezes the target',
    supercharge: 'massively raises fire rate for any mounted turret',
    grantAllSupplies: 'triggers every supply for you and nearby allies, free',
    chainDamageHeal: 'arc that damages enemies and heals allies',
    protectiveDome: 'stationary dome that cuts incoming damage',
    contactKillField: 'speed boost plus a contact-kill field',
    healAndRepel: 'full heal and launches everything nearby away',
  };
  return map[effect] ?? effect;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
