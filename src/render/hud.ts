import * as THREE from 'three';
import { SUPPLIES, SUPPLY_ORDER } from '../data/supplies';
import { clamp } from '../core/mathx';
import type { Battle, BattleSnapshot } from '../game/battle';

const PANEL = 'rgba(12,16,22,0.72)';
const ACCENT = '#2ee6a8';

/**
 * Canvas HUD. Kept off the DOM so it can be redrawn every frame without layout
 * cost, and so damage numbers can be projected from world space cheaply.
 */
export class Hud {
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;
  showScoreboard = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
    this.resize();
  }

  resize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.floor(window.innerWidth * this.dpr);
    this.canvas.height = Math.floor(window.innerHeight * this.dpr);
    this.canvas.style.width = `${window.innerWidth}px`;
    this.canvas.style.height = `${window.innerHeight}px`;
  }

  draw(battle: Battle, snap: BattleSnapshot): void {
    const ctx = this.ctx;
    const w = window.innerWidth;
    const h = window.innerHeight;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.textBaseline = 'middle';

    this.drawDamageNumbers(battle, w, h);
    this.drawReticle(battle, snap, w, h);
    this.drawTopBar(snap, w);
    this.drawHealth(snap, w, h);
    this.drawWeapon(snap, w, h);
    this.drawSupplies(snap, w, h);
    this.drawMinimap(battle, w, h);
    this.drawFeed(snap, h);
    this.drawStatus(snap, w, h);
    if (snap.selfDestruct != null) this.drawSelfDestruct(snap.selfDestruct, w, h);
    if (!snap.player.alive && !snap.over) this.drawRespawn(snap, w, h);
    if (this.showScoreboard || snap.over) this.drawScoreboard(snap, w, h);
    if (snap.over) this.drawResult(snap, w, h);
  }

  // ---- pieces -----------------------------------------------------------

  private drawReticle(battle: Battle, snap: BattleSnapshot, w: number, h: number): void {
    const ctx = this.ctx;
    if (!snap.player.alive) return;
    const cx = w / 2;
    const cy = h / 2;
    const weapon = snap.player.weapon;
    const scoped = weapon.scopeFov != null;

    ctx.save();
    ctx.strokeStyle = weapon.ready || scoped ? ACCENT : 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 1.5;

    if (scoped) {
      ctx.beginPath();
      ctx.arc(cx, cy, 90, 0, Math.PI * 2);
      ctx.moveTo(cx - 150, cy);
      ctx.lineTo(cx - 12, cy);
      ctx.moveTo(cx + 12, cy);
      ctx.lineTo(cx + 150, cy);
      ctx.moveTo(cx, cy - 150);
      ctx.lineTo(cx, cy - 12);
      ctx.moveTo(cx, cy + 12);
      ctx.lineTo(cx, cy + 150);
      ctx.stroke();
      // Charge ring: the longer you hold, the harder it hits.
      if (weapon.chargeFraction > 0) {
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(cx, cy, 100, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * weapon.chargeFraction);
        ctx.stroke();
      }
    } else {
      const spread = 10 + (1 - weapon.reloadFraction) * 14;
      ctx.beginPath();
      for (const [dx, dy] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ]) {
        ctx.moveTo(cx + dx * spread, cy + dy * spread);
        ctx.lineTo(cx + dx * (spread + 8), cy + dy * (spread + 8));
      }
      ctx.stroke();
      ctx.fillStyle = ACCENT;
      ctx.fillRect(cx - 1, cy - 1, 2, 2);

      if (weapon.chargeFraction > 0 && weapon.isCharging) {
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(cx, cy, spread + 16, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * weapon.chargeFraction);
        ctx.stroke();
      }
      if (weapon.lockFraction > 0) {
        ctx.strokeStyle = weapon.lockFraction >= 1 ? '#f87171' : '#fbbf24';
        ctx.lineWidth = 2;
        const r = 34 - weapon.lockFraction * 14;
        ctx.strokeRect(cx - r, cy - r, r * 2, r * 2);
      }
    }
    ctx.restore();

    // Ballistic landing marker for Magnum-style arcs.
    const landing = battle.ballisticLanding();
    if (landing) {
      const p = this.project(battle, landing.x, landing.y, landing.z, w, h);
      if (p) {
        ctx.save();
        ctx.strokeStyle = 'rgba(245,158,11,0.9)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 14, 0, Math.PI * 2);
        ctx.moveTo(p.x - 20, p.y);
        ctx.lineTo(p.x + 20, p.y);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  private drawTopBar(snap: BattleSnapshot, w: number): void {
    const ctx = this.ctx;
    const remaining = Math.max(0, snap.timeLimit - snap.elapsed);
    const mm = Math.floor(remaining / 60);
    const ss = Math.floor(remaining % 60);
    const label = `${mm}:${ss.toString().padStart(2, '0')}`;

    ctx.save();
    ctx.fillStyle = PANEL;
    roundRect(ctx, w / 2 - 150, 12, 300, 46, 8);
    ctx.fill();

    ctx.fillStyle = remaining < 60 ? '#f87171' : '#e6edf5';
    ctx.font = '600 22px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(label, w / 2, 28);

    ctx.font = '500 13px system-ui, sans-serif';
    ctx.fillStyle = '#9aa4b2';
    ctx.fillText(`${snap.modeCode} · ${snap.modeLine}`, w / 2, 48);
    ctx.restore();

    if (snap.teamScores) {
      ctx.save();
      ctx.font = '700 26px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillStyle = '#3c7ce0';
      ctx.fillText(String(Math.floor(snap.teamScores.blue)), w / 2 - 165, 35);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#e0483c';
      ctx.fillText(String(Math.floor(snap.teamScores.red)), w / 2 + 165, 35);
      ctx.restore();
    }
  }

  private drawHealth(snap: BattleSnapshot, _w: number, h: number): void {
    const ctx = this.ctx;
    const p = snap.player;
    const x = 28;
    const y = h - 96;
    const width = 300;

    ctx.save();
    ctx.fillStyle = PANEL;
    roundRect(ctx, x - 10, y - 26, width + 20, 76, 8);
    ctx.fill();

    ctx.fillStyle = '#9aa4b2';
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${p.hull.displayName.toUpperCase()} · ${p.turretDef.displayName.toUpperCase()}`, x, y - 14);

    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    roundRect(ctx, x, y, width, 16, 4);
    ctx.fill();
    const frac = p.healthFraction;
    ctx.fillStyle = frac > 0.5 ? ACCENT : frac > 0.25 ? '#fbbf24' : '#f87171';
    roundRect(ctx, x, y, Math.max(2, width * frac), 16, 4);
    ctx.fill();
    ctx.fillStyle = '#0b0f14';
    ctx.font = '700 11px ui-monospace, monospace';
    ctx.fillText(`${Math.ceil(p.health)} / ${p.maxHealth}`, x + 8, y + 8);

    // Overdrive charge.
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    roundRect(ctx, x, y + 24, width, 10, 3);
    ctx.fill();
    const od = p.overdriveCharge / 100;
    ctx.fillStyle = od >= 1 ? '#fbbf24' : '#818cf8';
    roundRect(ctx, x, y + 24, Math.max(2, width * od), 10, 3);
    ctx.fill();
    ctx.fillStyle = od >= 1 ? '#fbbf24' : '#9aa4b2';
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.fillText(
      od >= 1 ? `${p.hull.overdrive.displayName.toUpperCase()} READY — SPACE` : p.hull.overdrive.displayName,
      x,
      y + 44,
    );
    ctx.restore();
  }

  private drawWeapon(snap: BattleSnapshot, w: number, h: number): void {
    const ctx = this.ctx;
    const weapon = snap.player.weapon;
    const x = w - 268;
    const y = h - 96;

    ctx.save();
    ctx.fillStyle = PANEL;
    roundRect(ctx, x - 10, y - 26, 250, 76, 8);
    ctx.fill();
    ctx.textAlign = 'left';
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.fillStyle = '#9aa4b2';
    ctx.fillText('WEAPON', x, y - 14);

    const bar = (label: string, frac: number, colour: string, row: number) => {
      const by = y + row * 18;
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      roundRect(ctx, x + 54, by, 168, 10, 3);
      ctx.fill();
      ctx.fillStyle = colour;
      roundRect(ctx, x + 54, by, Math.max(2, 168 * clamp(frac, 0, 1)), 10, 3);
      ctx.fill();
      ctx.fillStyle = '#9aa4b2';
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.fillText(label, x, by + 5);
    };

    let row = 0;
    if (weapon.clipSize > 0) {
      bar(`CLIP ${weapon.clipRemaining}/${weapon.clipSize}`, weapon.clipRemaining / weapon.clipSize, '#38bdf8', row++);
    }
    if (weapon.def.fuel) bar('FUEL', weapon.fuelFraction, '#22d3ee', row++);
    if (weapon.def.heat) {
      bar('HEAT', weapon.heatFraction, weapon.heatFraction > 0.85 ? '#f87171' : '#fb923c', row++);
    }
    bar('RELOAD', weapon.reloadFraction, weapon.ready ? ACCENT : '#fbbf24', row++);
    if (weapon.def.maxCritChance) {
      bar(`CRIT ${Math.round(weapon.critChancePercent)}%`, weapon.critChancePercent / weapon.def.maxCritChance, '#facc15', row++);
    }
    ctx.restore();
  }

  private drawSupplies(snap: BattleSnapshot, w: number, h: number): void {
    const ctx = this.ctx;
    const size = 46;
    const gap = 8;
    const total = SUPPLY_ORDER.length * (size + gap) - gap;
    const x0 = (w - total) / 2;
    const y = h - 66;

    ctx.save();
    SUPPLY_ORDER.forEach((kind, i) => {
      const def = SUPPLIES[kind];
      const state = snap.player.supplies[kind];
      const x = x0 + i * (size + gap);
      const usable = state.count > 0 && state.cooldown <= 0;

      ctx.fillStyle = PANEL;
      roundRect(ctx, x, y, size, size, 8);
      ctx.fill();
      ctx.strokeStyle = usable ? hex(def.colour) : 'rgba(255,255,255,0.1)';
      ctx.lineWidth = usable ? 2 : 1;
      roundRect(ctx, x, y, size, size, 8);
      ctx.stroke();

      ctx.fillStyle = usable ? hex(def.colour) : 'rgba(255,255,255,0.28)';
      ctx.font = '700 18px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(def.key), x + size / 2, y + size / 2 - 4);
      ctx.font = '600 10px system-ui, sans-serif';
      ctx.fillText(`×${state.count}`, x + size / 2, y + size - 11);

      if (state.cooldown > 0) {
        ctx.fillStyle = 'rgba(8,10,14,0.66)';
        const frac = clamp(state.cooldown / 20, 0, 1);
        roundRect(ctx, x, y, size, size * frac, 8);
        ctx.fill();
        ctx.fillStyle = '#e6edf5';
        ctx.font = '700 13px ui-monospace, monospace';
        ctx.fillText(state.cooldown.toFixed(0), x + size / 2, y + size / 2);
      }
    });
    ctx.restore();
  }

  private drawMinimap(battle: Battle, w: number, _h: number): void {
    const ctx = this.ctx;
    const size = 176;
    const x = w - size - 20;
    const y = 20;
    const def = battle.def;
    const scale = size / (Math.max(def.bounds.x, def.bounds.z) * 2);
    const cx = x + size / 2;
    const cy = y + size / 2;

    ctx.save();
    ctx.fillStyle = 'rgba(12,16,22,0.78)';
    roundRect(ctx, x, y, size, size, 10);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, size, size, 10);
    ctx.stroke();
    ctx.save();
    ctx.beginPath();
    roundRect(ctx, x, y, size, size, 10);
    ctx.clip();

    const markers = battle.minimapMarkers();

    for (const p of markers.pickups) {
      ctx.fillStyle = hex(p.colour);
      const px = cx + p.x * scale;
      const py = cy + p.z * scale;
      if (p.gold) {
        ctx.beginPath();
        ctx.arc(px, py, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,215,0,0.6)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, py, 9 + Math.sin(battle.time * 6) * 2.5, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.fillRect(px - 2, py - 2, 4, 4);
      }
    }

    for (const m of markers.mines) {
      ctx.fillStyle = 'rgba(167,139,250,0.8)';
      ctx.beginPath();
      ctx.arc(cx + m.x * scale, cy + m.z * scale, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const o of markers.objectives) {
      const px = cx + o.x * scale;
      const py = cy + o.z * scale;
      ctx.fillStyle = hex(o.colour);
      if (o.shape === 'flag') {
        ctx.fillRect(px - 1, py - 7, 2, 14);
        ctx.beginPath();
        ctx.moveTo(px + 1, py - 7);
        ctx.lineTo(px + 8, py - 4);
        ctx.lineTo(px + 1, py - 1);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.strokeStyle = hex(o.colour);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, py, 6, 0, Math.PI * 2);
        ctx.stroke();
        if (o.progress) {
          ctx.beginPath();
          ctx.arc(px, py, 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * o.progress);
          ctx.lineWidth = 3;
          ctx.stroke();
        }
      }
    }

    for (const t of markers.tanks) {
      const px = cx + t.x * scale;
      const py = cy + t.z * scale;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(-t.yaw);
      ctx.fillStyle = hex(t.colour);
      ctx.beginPath();
      ctx.moveTo(0, -5);
      ctx.lineTo(3.5, 4);
      ctx.lineTo(-3.5, 4);
      ctx.closePath();
      ctx.fill();
      if (t.you) {
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.restore();
    ctx.restore();
  }

  private drawFeed(snap: BattleSnapshot, h: number): void {
    const ctx = this.ctx;
    const now = snap.elapsed;
    const recent = snap.notifications.filter((n) => now - n.at < 6).slice(-6);
    ctx.save();
    ctx.textAlign = 'left';
    ctx.font = '600 13px system-ui, sans-serif';
    let y = h / 2 - 120;
    for (const n of recent) {
      const age = now - n.at;
      const alpha = clamp(1 - (age - 4) / 2, 0, 1);
      ctx.globalAlpha = alpha;
      ctx.fillStyle =
        n.kind === 'gold'
          ? '#ffd700'
          : n.kind === 'objective'
            ? '#7dd3fc'
            : n.kind === 'warning'
              ? '#f87171'
              : n.kind === 'kill'
                ? '#e6edf5'
                : '#9aa4b2';
      ctx.fillText(n.text, 28, y);
      y += 20;
    }
    ctx.restore();
  }

  private drawStatus(snap: BattleSnapshot, w: number, h: number): void {
    const effects = snap.player.status.list().filter((e) => e.kind !== 'reveal');
    if (!effects.length) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = '600 12px system-ui, sans-serif';
    const labels: Record<string, [string, string]> = {
      burning: ['BURNING', '#fb923c'],
      freezing: ['FROZEN', '#7dd3fc'],
      emp: ['DISARMED', '#818cf8'],
      stun: ['STUNNED', '#f87171'],
      doubleArmor: ['ARMOR', '#60a5fa'],
      doubleDamage: ['DAMAGE', '#f87171'],
      nitro: ['NITRO', '#fbbf24'],
      supercharge: ['SUPERCHARGE', '#a78bfa'],
      ap: ['EXPOSED', '#f87171'],
    };
    let x = w / 2 - ((effects.length - 1) * 96) / 2;
    for (const e of effects) {
      const [label, colour] = labels[e.kind] ?? [e.kind.toUpperCase(), '#9aa4b2'];
      ctx.fillStyle = PANEL;
      roundRect(ctx, x - 44, h - 152, 88, 22, 6);
      ctx.fill();
      ctx.fillStyle = colour;
      ctx.fillText(`${label} ${e.remaining.toFixed(0)}s`, x, h - 141);
      x += 96;
    }
    ctx.restore();
  }

  private drawSelfDestruct(remaining: number, w: number, h: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#f87171';
    ctx.font = '700 16px system-ui, sans-serif';
    ctx.fillText(`SELF DESTRUCT IN ${Math.ceil(remaining)}`, w / 2, h / 2 + 120);
    ctx.restore();
  }

  private drawRespawn(snap: BattleSnapshot, w: number, h: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = 'rgba(8,10,14,0.45)';
    ctx.fillRect(0, 0, w, h);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#e6edf5';
    ctx.font = '700 34px system-ui, sans-serif';
    ctx.fillText('DESTROYED', w / 2, h / 2 - 20);
    ctx.font = '600 18px system-ui, sans-serif';
    ctx.fillStyle = '#9aa4b2';
    ctx.fillText(`Respawning in ${Math.max(0, snap.player.respawnTimer).toFixed(1)}s`, w / 2, h / 2 + 16);
    ctx.restore();
  }

  private drawScoreboard(snap: BattleSnapshot, w: number, h: number): void {
    const ctx = this.ctx;
    const rows = snap.scoreboard.slice(0, 16);
    const width = 560;
    const rowH = 26;
    const height = 74 + rows.length * rowH;
    const x = (w - width) / 2;
    const y = (h - height) / 2;

    ctx.save();
    ctx.fillStyle = 'rgba(8,11,16,0.9)';
    roundRect(ctx, x, y, width, height, 12);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    roundRect(ctx, x, y, width, height, 12);
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.font = '700 15px system-ui, sans-serif';
    ctx.fillStyle = '#e6edf5';
    ctx.fillText('SCOREBOARD', x + 20, y + 26);
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.fillStyle = '#9aa4b2';
    ctx.fillText('PLAYER', x + 20, y + 52);
    ctx.textAlign = 'right';
    ctx.fillText('SCORE', x + 320, y + 52);
    ctx.fillText('K', x + 380, y + 52);
    ctx.fillText('D', x + 424, y + 52);
    ctx.fillText('DMG', x + 490, y + 52);
    ctx.fillText('◆', x + 540, y + 52);

    rows.forEach((t, i) => {
      const ry = y + 74 + i * rowH;
      if (t.isPlayer) {
        ctx.fillStyle = 'rgba(46,230,168,0.12)';
        roundRect(ctx, x + 10, ry - 12, width - 20, rowH - 2, 5);
        ctx.fill();
      }
      ctx.textAlign = 'left';
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.fillStyle = t.isPlayer ? ACCENT : t.team === 'red' ? '#e0483c' : t.team === 'blue' ? '#7fa9ee' : '#e6edf5';
      const persona = t.ai ? ` · ${t.ai.persona.displayName}` : '';
      ctx.fillText(`${t.name}${persona}`, x + 20, ry);
      ctx.fillStyle = '#9aa4b2';
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.fillText(`${t.hull.displayName}/${t.turretDef.displayName}`, x + 200, ry);
      ctx.textAlign = 'right';
      ctx.font = '600 13px ui-monospace, monospace';
      ctx.fillStyle = '#e6edf5';
      ctx.fillText(String(Math.round(t.score)), x + 320, ry);
      ctx.fillText(String(t.kills), x + 380, ry);
      ctx.fillText(String(t.deaths), x + 424, ry);
      ctx.fillText(String(Math.round(t.damageDealt)), x + 490, ry);
      ctx.fillStyle = '#22d3ee';
      ctx.fillText(String(t.crystals), x + 540, ry);
    });
    ctx.restore();
  }

  private drawResult(snap: BattleSnapshot, w: number, _h: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#e6edf5';
    ctx.font = '700 40px system-ui, sans-serif';
    ctx.fillText(snap.winner ? `${snap.winner} wins` : 'Battle over', w / 2, 120);
    ctx.font = '600 16px system-ui, sans-serif';
    ctx.fillStyle = '#9aa4b2';
    ctx.fillText(`${snap.reason ?? ''} — press Escape for the garage`, w / 2, 150);
    ctx.restore();
  }

  private drawDamageNumbers(battle: Battle, w: number, h: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.textAlign = 'center';
    for (const n of battle.fx.damageNumbers) {
      const p = this.project(battle, n.world.x, n.world.y, n.world.z, w, h);
      if (!p) continue;
      ctx.globalAlpha = clamp(n.life, 0, 1);
      ctx.fillStyle = n.colour;
      ctx.font = '700 16px ui-monospace, monospace';
      ctx.fillText(n.text, p.x, p.y);
    }
    ctx.restore();
  }

  private readonly tmp = new THREE.Vector3();

  private project(battle: Battle, x: number, y: number, z: number, w: number, h: number): { x: number; y: number } | null {
    this.tmp.set(x, y, z).project(battle.camera.camera);
    if (this.tmp.z > 1) return null;
    return { x: (this.tmp.x * 0.5 + 0.5) * w, y: (-this.tmp.y * 0.5 + 0.5) * h };
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function hex(colour: number): string {
  return `#${colour.toString(16).padStart(6, '0')}`;
}
