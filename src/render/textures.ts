import * as THREE from 'three';

/**
 * Procedural canvas textures. Everything here is drawn at load time from code —
 * the project ships no image assets, and a browser game that has to download
 * texture atlases before the first battle is a worse trade than a few
 * milliseconds of 2D canvas work.
 *
 * Surface textures are deliberately near-white greyscale detail (panel lines,
 * rivets, grime) so a single sheet can be tinted per team by the material's
 * `color`. That is what lets a red Mammoth and a teal player hull share one
 * upload.
 */

const cache = new Map<string, THREE.Texture>();

function build(
  key: string,
  size: number,
  draw: (g: CanvasRenderingContext2D, s: number) => void,
  opts: { srgb?: boolean; wrapT?: THREE.Wrapping } = {},
): THREE.Texture {
  const hit = cache.get(key);
  if (hit) return hit;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d')!;
  draw(g, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = opts.wrapT ?? THREE.RepeatWrapping;
  if (opts.srgb !== false) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  cache.set(key, tex);
  return tex;
}

// A tiny deterministic PRNG so a texture looks the same every session; random
// grime that reshuffles on reload reads as flicker when you alt-tab back in.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function grime(g: CanvasRenderingContext2D, s: number, seed: number, amount: number): void {
  const r = rng(seed);
  for (let i = 0; i < amount; i++) {
    const x = r() * s;
    const y = r() * s;
    const w = 2 + r() * s * 0.07;
    const h = 2 + r() * s * 0.07;
    g.fillStyle = r() < 0.5 ? `rgba(0,0,0,${0.03 + r() * 0.05})` : `rgba(255,255,255,${0.02 + r() * 0.04})`;
    g.fillRect(x, y, w, h);
  }
}

/** Horizontal streaks of rust and oil running down from panel seams. */
function streaks(g: CanvasRenderingContext2D, s: number, seed: number, count: number): void {
  const r = rng(seed);
  for (let i = 0; i < count; i++) {
    const x = r() * s;
    const y = r() * s;
    const len = s * (0.06 + r() * 0.22);
    const grad = g.createLinearGradient(x, y, x, y + len);
    grad.addColorStop(0, `rgba(30,22,14,${0.16 + r() * 0.14})`);
    grad.addColorStop(1, 'rgba(30,22,14,0)');
    g.fillStyle = grad;
    g.fillRect(x, y, 2 + r() * 5, len);
  }
}

function rivetRow(
  g: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  count: number,
  radius: number,
): void {
  for (let i = 0; i <= count; i++) {
    const t = count === 0 ? 0 : i / count;
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t;
    g.fillStyle = 'rgba(0,0,0,0.30)';
    g.beginPath();
    g.arc(x, y + radius * 0.5, radius, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.32)';
    g.beginPath();
    g.arc(x, y - radius * 0.25, radius * 0.8, 0, Math.PI * 2);
    g.fill();
  }
}

/**
 * Armour plate. Tinted by the material colour, so this is the one sheet every
 * hull and turret in the game shares.
 *
 * `camo` adds soft disruptive blotches — bots wear it, the player's hull does
 * not, which is one of several cues separating your tank from the field.
 */
export function armourTexture(camo: boolean): THREE.Texture {
  return build(`armour:${camo}`, 512, (g, s) => {
    g.fillStyle = '#e9e9ec';
    g.fillRect(0, 0, s, s);

    // Rolled-plate variation, so large flat faces are not dead flat.
    const r = rng(camo ? 99 : 7);
    for (let i = 0; i < 26; i++) {
      const w = s * (0.1 + r() * 0.35);
      const h = s * (0.1 + r() * 0.35);
      g.fillStyle = `rgba(${r() < 0.5 ? '0,0,0' : '255,255,255'},${0.025 + r() * 0.035})`;
      g.fillRect(r() * s, r() * s, w, h);
    }

    if (camo) {
      // Disruptive pattern: a handful of soft blobs, kept light enough that a
      // team's paint still reads as that team's colour at a hundred metres.
      const c = rng(31);
      for (let i = 0; i < 9; i++) {
        const cx = c() * s;
        const cy = c() * s;
        const rad = s * (0.09 + c() * 0.16);
        g.save();
        g.globalAlpha = 0.28;
        g.fillStyle = i % 3 === 0 ? '#b8b49a' : '#6f7565';
        g.beginPath();
        for (let a = 0; a < 12; a++) {
          const ang = (a / 12) * Math.PI * 2;
          const rr = rad * (0.65 + c() * 0.6);
          const px = cx + Math.cos(ang) * rr;
          const py = cy + Math.sin(ang) * rr;
          if (a === 0) g.moveTo(px, py);
          else g.lineTo(px, py);
        }
        g.closePath();
        g.fill();
        g.restore();
      }
    }

    // Panel seams on a 4×4 grid, with welds and rivet rows along them.
    const cell = s / 4;
    g.lineWidth = 2;
    for (let i = 0; i <= 4; i++) {
      const p = i * cell;
      g.strokeStyle = 'rgba(0,0,0,0.22)';
      g.beginPath();
      g.moveTo(p, 0);
      g.lineTo(p, s);
      g.moveTo(0, p);
      g.lineTo(s, p);
      g.stroke();
      // Highlight on the lower/right side of each seam reads as a plate lip.
      g.strokeStyle = 'rgba(255,255,255,0.18)';
      g.beginPath();
      g.moveTo(p + 2, 0);
      g.lineTo(p + 2, s);
      g.moveTo(0, p + 2);
      g.lineTo(s, p + 2);
      g.stroke();
    }
    for (let i = 0; i < 4; i++) {
      rivetRow(g, 6, i * cell + 8, s - 6, i * cell + 8, 13, 2.2);
    }

    streaks(g, s, 5, 26);
    grime(g, s, 12, 200);
  });
}

/** Track link band: lugs, guide horns and polished wear on the running face. */
export function treadTexture(): THREE.Texture {
  return build('tread', 256, (g, s) => {
    g.fillStyle = '#2b2d31';
    g.fillRect(0, 0, s, s);
    const links = 8;
    const h = s / links;
    for (let i = 0; i < links; i++) {
      const y = i * h;
      g.fillStyle = '#3a3d43';
      g.fillRect(0, y + 1, s, h - 3);
      // Guide horn down the middle of the link.
      g.fillStyle = '#4a4e55';
      g.fillRect(s * 0.42, y + 2, s * 0.16, h - 5);
      g.fillStyle = 'rgba(0,0,0,0.5)';
      g.fillRect(0, y + h - 2, s, 2);
      g.fillStyle = 'rgba(255,255,255,0.10)';
      g.fillRect(0, y + 1, s, 1);
      // Pin bosses at the link edges.
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.beginPath();
      g.arc(s * 0.12, y + h * 0.5, 2.4, 0, Math.PI * 2);
      g.arc(s * 0.88, y + h * 0.5, 2.4, 0, Math.PI * 2);
      g.fill();
    }
    grime(g, s, 44, 90);
  });
}

/** Diagonal hazard chevrons. Used for the player's identification bands. */
export function chevronTexture(a: string, b: string): THREE.Texture {
  return build(`chevron:${a}:${b}`, 128, (g, s) => {
    g.fillStyle = a;
    g.fillRect(0, 0, s, s);
    g.strokeStyle = b;
    g.lineWidth = s / 8;
    for (let i = -2; i < 6; i++) {
      g.beginPath();
      g.moveTo(i * (s / 4), 0);
      g.lineTo(i * (s / 4) + s, s);
      g.stroke();
    }
    grime(g, s, 71, 40);
  });
}

/** Ground plane. One tile is 5 m, matching the prop grid the maps are built on. */
export function groundTexture(theme: string): THREE.Texture {
  return build(`ground:${theme}`, 512, (g, s) => {
    const palette =
      theme === 'winter'
        ? ['#e6edf4', '#d3dde8', '#f4f8fb']
        : theme === 'urban'
          ? ['#4b5059', '#3f434b', '#585d67']
          : theme === 'space'
            ? ['#2c3048', '#232741', '#3a4060']
            : ['#66783f', '#5a6b39', '#77894b'];
    g.fillStyle = palette[0];
    g.fillRect(0, 0, s, s);

    const r = rng(theme.length * 977 + 3);
    for (let i = 0; i < 900; i++) {
      g.fillStyle = r() < 0.5 ? palette[1] : palette[2];
      g.globalAlpha = 0.25 + r() * 0.4;
      const w = 3 + r() * 26;
      g.fillRect(r() * s, r() * s, w, 3 + r() * 18);
    }
    g.globalAlpha = 1;

    if (theme === 'urban') {
      // Asphalt slabs with tar seams.
      g.strokeStyle = 'rgba(0,0,0,0.35)';
      g.lineWidth = 3;
      for (const p of [0, s / 2, s]) {
        g.beginPath();
        g.moveTo(p, 0);
        g.lineTo(p, s);
        g.moveTo(0, p);
        g.lineTo(s, p);
        g.stroke();
      }
    } else if (theme === 'space') {
      // Deck plating with a faint emissive-looking grid.
      g.strokeStyle = 'rgba(140,170,255,0.16)';
      g.lineWidth = 2;
      for (let i = 0; i <= 4; i++) {
        const p = (i * s) / 4;
        g.beginPath();
        g.moveTo(p, 0);
        g.lineTo(p, s);
        g.moveTo(0, p);
        g.lineTo(s, p);
        g.stroke();
      }
    } else if (theme === 'summer') {
      // Scrub tufts and bare patches.
      const t = rng(515);
      for (let i = 0; i < 120; i++) {
        g.fillStyle = t() < 0.4 ? '#8a7a4a' : '#87a052';
        g.globalAlpha = 0.5;
        g.beginPath();
        g.ellipse(t() * s, t() * s, 4 + t() * 12, 3 + t() * 8, t() * Math.PI, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
    }
    grime(g, s, 8, 260);
  });
}

/** Prop surfaces. One tile is 5 m, so a wall's UVs are scaled by its size. */
export function surfaceTexture(kind: string): THREE.Texture {
  return build(`surface:${kind}`, 512, (g, s) => {
    switch (kind) {
      case 'metal': {
        g.fillStyle = '#e2e6ec';
        g.fillRect(0, 0, s, s);
        // Tread plate: a diamond raised pattern.
        g.strokeStyle = 'rgba(0,0,0,0.16)';
        g.lineWidth = 2;
        for (let i = -4; i < 12; i++) {
          g.beginPath();
          g.moveTo(i * (s / 8), 0);
          g.lineTo(i * (s / 8) + s, s);
          g.moveTo(i * (s / 8), s);
          g.lineTo(i * (s / 8) + s, 0);
          g.stroke();
        }
        g.strokeStyle = 'rgba(0,0,0,0.4)';
        g.lineWidth = 4;
        g.strokeRect(2, 2, s - 4, s - 4);
        rivetRow(g, 12, 12, s - 12, 12, 8, 3);
        rivetRow(g, 12, s - 12, s - 12, s - 12, 8, 3);
        grime(g, s, 21, 140);
        break;
      }
      case 'sand': {
        g.fillStyle = '#e8dcc0';
        g.fillRect(0, 0, s, s);
        const r = rng(66);
        for (let i = 0; i < 500; i++) {
          g.fillStyle = r() < 0.5 ? 'rgba(150,130,90,0.28)' : 'rgba(255,250,230,0.3)';
          g.beginPath();
          g.arc(r() * s, r() * s, 1 + r() * 5, 0, Math.PI * 2);
          g.fill();
        }
        break;
      }
      case 'glass': {
        g.fillStyle = '#eef7ff';
        g.fillRect(0, 0, s, s);
        g.strokeStyle = 'rgba(255,255,255,0.65)';
        g.lineWidth = 6;
        g.strokeRect(3, 3, s - 6, s - 6);
        g.strokeStyle = 'rgba(255,255,255,0.35)';
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(0, s);
        g.lineTo(s, 0);
        g.stroke();
        break;
      }
      case 'hazard': {
        g.fillStyle = '#f0d089';
        g.fillRect(0, 0, s, s);
        g.strokeStyle = 'rgba(40,32,10,0.75)';
        g.lineWidth = s / 7;
        for (let i = -2; i < 7; i++) {
          g.beginPath();
          g.moveTo(i * (s / 3.5), 0);
          g.lineTo(i * (s / 3.5) + s, s);
          g.stroke();
        }
        grime(g, s, 33, 120);
        break;
      }
      default: {
        // Concrete: poured slabs with form-board lines, exposed aggregate and
        // chipped edges. The detail is deliberately high-frequency — a tile
        // covers five metres, so low-frequency blotches magnify into smears.
        g.fillStyle = '#d8d8d4';
        g.fillRect(0, 0, s, s);
        const r = rng(303);
        for (let i = 0; i < 2600; i++) {
          g.fillStyle = r() < 0.5 ? 'rgba(0,0,0,0.055)' : 'rgba(255,255,255,0.06)';
          g.fillRect(r() * s, r() * s, 1 + r() * 3, 1 + r() * 3);
        }
        // Aggregate: harder flecks of stone in the mix.
        for (let i = 0; i < 260; i++) {
          g.fillStyle = r() < 0.6 ? 'rgba(120,118,112,0.4)' : 'rgba(250,250,245,0.5)';
          g.beginPath();
          g.arc(r() * s, r() * s, 0.8 + r() * 1.8, 0, Math.PI * 2);
          g.fill();
        }
        // Slab joints: one along each edge and a form-board line across.
        g.strokeStyle = 'rgba(0,0,0,0.26)';
        g.lineWidth = 2;
        g.strokeRect(1, 1, s - 2, s - 2);
        g.strokeStyle = 'rgba(255,255,255,0.14)';
        g.lineWidth = 1;
        g.strokeRect(3, 3, s - 6, s - 6);
        g.strokeStyle = 'rgba(0,0,0,0.12)';
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(0, s / 2);
        g.lineTo(s, s / 2);
        g.stroke();
        // Chips along the joints, which is what makes concrete read as concrete.
        for (let i = 0; i < 40; i++) {
          g.fillStyle = 'rgba(96,94,90,0.4)';
          const edge = Math.floor(r() * 4);
          const t = r() * s;
          const x = edge === 0 ? t : edge === 1 ? t : edge === 2 ? 2 : s - 2;
          const y = edge === 0 ? 2 : edge === 1 ? s - 2 : t;
          g.beginPath();
          g.arc(x, y, 1.5 + r() * 3, 0, Math.PI * 2);
          g.fill();
        }
        streaks(g, s, 91, 12);
        break;
      }
    }
  });
}

/**
 * Equirectangular sky. A gradient with a sun bloom and a horizon haze band
 * reads as an actual sky, where a flat clear colour reads as a missing skybox.
 */
export function skyTexture(theme: string): THREE.Texture {
  const tex = build(
    `sky:${theme}`,
    1024,
    (g, s) => {
      const h = s / 2;
      const bands: Record<string, [string, string, string]> = {
        winter: ['#7f9ec2', '#c9dcec', '#eef3f7'],
        urban: ['#5d7893', '#9db2c6', '#d6dee6'],
        space: ['#04050c', '#0a0d1c', '#141a30'],
        summer: ['#2f6ba8', '#84b4dc', '#d8e8f2'],
      };
      const [top, mid, horizon] = bands[theme] ?? bands.summer;
      const grad = g.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, top);
      grad.addColorStop(0.55, mid);
      grad.addColorStop(1, horizon);
      g.fillStyle = grad;
      g.fillRect(0, 0, s, h);

      // Below the horizon: a dimmer ground haze so reflections do not sample sky.
      const below = g.createLinearGradient(0, h, 0, s);
      below.addColorStop(0, horizon);
      below.addColorStop(1, theme === 'space' ? '#05060d' : '#3a3f42');
      g.fillStyle = below;
      g.fillRect(0, h, s, h);

      if (theme === 'space') {
        const r = rng(1234);
        for (let i = 0; i < 900; i++) {
          const a = 0.25 + r() * 0.75;
          g.fillStyle = `rgba(255,255,255,${a})`;
          const rad = r() < 0.94 ? 0.7 : 1.6;
          g.beginPath();
          g.arc(r() * s, r() * s * 0.98, rad, 0, Math.PI * 2);
          g.fill();
        }
        // A nebula wash, for something to read distance against.
        const neb = g.createRadialGradient(s * 0.7, h * 0.45, 0, s * 0.7, h * 0.45, s * 0.28);
        neb.addColorStop(0, 'rgba(90,70,170,0.32)');
        neb.addColorStop(1, 'rgba(90,70,170,0)');
        g.fillStyle = neb;
        g.fillRect(0, 0, s, s);
      } else {
        // Sun bloom. The scene's directional light comes from +X/+Z, so put the
        // glow roughly where the shadows say it should be.
        const sx = s * 0.62;
        const sy = h * 0.34;
        const sun = g.createRadialGradient(sx, sy, 0, sx, sy, s * 0.17);
        sun.addColorStop(0, 'rgba(255,248,225,0.95)');
        sun.addColorStop(0.15, 'rgba(255,240,200,0.55)');
        sun.addColorStop(1, 'rgba(255,240,200,0)');
        g.fillStyle = sun;
        g.fillRect(0, 0, s, h);

        // Soft cloud banks, drawn as stretched translucent ellipses.
        const r = rng(theme.length * 17 + 5);
        for (let i = 0; i < 26; i++) {
          const cx = r() * s;
          const cy = h * (0.18 + r() * 0.65);
          const rw = s * (0.04 + r() * 0.12);
          const rh = rw * (0.12 + r() * 0.16);
          g.fillStyle = `rgba(255,255,255,${0.06 + r() * 0.16})`;
          g.beginPath();
          g.ellipse(cx, cy, rw, rh, 0, 0, Math.PI * 2);
          g.fill();
        }
      }
    },
    { wrapT: THREE.ClampToEdgeWrapping },
  );
  tex.mapping = THREE.EquirectangularReflectionMapping;
  return tex;
}

export function disposeTextureCache(): void {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}
