/**
 * Debris harness. Levels a raid map, finds the rubble the collapse left behind
 * and drives a tank straight at it, in a real browser, at real physics rates.
 *
 * This exists because "rubble is drivable" was an assertion in a comment rather
 * than a fact about the simulation, and it was false: the pile was a box, the
 * tank is a rigid body with no wheels and zero contact friction, and a vertical
 * face of any height at all is a wall to something like that. Nothing else in
 * the project could have caught it — the raid harness reports how much cover
 * came down, not whether anybody could then drive across it.
 *
 * What it measures, per approach:
 *
 *   crossed     did the hull get to the far side of the pile
 *   climbedM    how high it actually rode, against the pile's own height
 *   tiltDeg     how far it leaned doing it — a tank crossing a shoulder should
 *               roll, and a flat number here means the mound is behaving like
 *               a lift rather than like terrain
 *
 *   node tools/debris-smoke.mjs            # kungur
 *   node tools/debris-smoke.mjs silence
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 4323;
await run('npx', ['vite', 'build', '--logLevel', 'error']);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
const url = `http://localhost:${PORT}/`;
await waitForServer(url);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message + '\n' + e.stack));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });
  await page.goto(url, { waitUntil: 'networkidle' });

  const mapId = process.argv[2] ?? 'kungur';
  await page.click('#start');
  await page.waitForFunction(() => window.tankArena.battle() != null);

  const report = await page.evaluate(async ({ mapId }) => {
    window.tankArena.restart(
      { mode: 'RAID', mapId, botCount: 2, difficulty: 'standard', timeLimit: 900 },
      { hull: 'hunter', turret: 'smoky' },
    );
    const battle = window.tankArena.battle();
    const idle = {
      forward: 0, turn: 0, turretTurn: 0, centreTurret: false,
      fire: false, overdrive: false, flip: false, supply: null, zoom: 0,
    };
    const step = (n, cmd = idle) => {
      for (let i = 0; i < n; i++) battle.update(1 / 60, cmd);
    };
    const WORLD_MASK = 1 | 2; // GROUND | PROP
    const surfaceAt = (x, z) => {
      const from = battle.player.position.clone();
      const to = battle.player.position.clone();
      from.set(x, 200, z);
      to.set(x, -5, z);
      const hit = battle.phys.raycast(from, to, WORLD_MASK);
      return hit ? hit.point.y : null;
    };

    // Park the player somewhere it will not be caught by the demolition, and
    // hold it there while the map comes down.
    const parked = battle.player.position.clone();
    parked.set(0, 60, 0);
    battle.player.vehicle.teleport(parked, 0);

    // Level the map. The Overseer is the only thing allowed to do this, so the
    // blasts are attributed to it exactly as its own ordnance would be.
    const boss = battle.boss;
    const at = battle.player.position.clone();
    const bounds = 90;
    for (let x = -bounds; x <= bounds; x += 18) {
      for (let z = -bounds; z <= bounds; z += 18) {
        const y = surfaceAt(x, z);
        if (y == null) continue;
        at.set(x, y + 1.5, z);
        battle.splash(at, 16, 5200, 0, boss, { selfDamage: false, impactForce: 0 });
      }
      // Let anything mid-topple finish falling before the next column.
      step(70);
      battle.player.vehicle.teleport(parked, 0);
    }
    step(120);
    battle.player.vehicle.teleport(parked, 0);

    // Find rubble: ground that is now about a rubble-height higher than the
    // clear floor a few metres to either side of it.
    const HEIGHT = 1.1;
    const sites = [];
    for (let x = -bounds; x <= bounds; x += 2) {
      for (let z = -bounds; z <= bounds; z += 2) {
        const y = surfaceAt(x, z);
        if (y == null) continue;
        for (const [dx, dz] of [[1, 0], [0, 1]]) {
          const back = surfaceAt(x - dx * 7, z - dz * 7);
          const front = surfaceAt(x + dx * 7, z + dz * 7);
          if (back == null || front == null) continue;
          const lift = y - Math.max(back, front);
          if (lift < HEIGHT * 0.7 || lift > HEIGHT * 1.6) continue;
          if (Math.abs(back - front) > 0.4) continue;
          sites.push({ x, z, y, floor: back, dx, dz });
        }
      }
    }

    const results = [];
    // Three runs per site: flat out over the crest, flat out down one shoulder
    // — which is where the roll is supposed to come from — and a crawl, which
    // is the approach that used to jam. A tank nudging rubble at walking pace
    // has no momentum to trade for the climb, so if anything is going to park
    // against a face, it is this one.
    for (const site of sites.slice(0, 6)) {
      for (const [offset, throttle] of [[0, 1], [3.2, 1], [0, 0.3]]) {
        const startX = site.x - site.dx * 13 - site.dz * offset;
        const startZ = site.z - site.dz * 13 - site.dx * offset;
        const floor = surfaceAt(startX, startZ);
        if (floor == null) continue;
        const spawn = battle.player.position.clone();
        spawn.set(startX, floor + 1.6, startZ);
        battle.player.vehicle.teleport(spawn, Math.atan2(site.dx, site.dz));
        battle.player.health = battle.player.maxHealth;
        step(30);

        let peak = -99;
        let tilt = 0;
        const base = battle.player.position.y;
        for (let i = 0; i < (throttle < 1 ? 700 : 260); i++) {
          battle.update(1 / 60, { ...idle, forward: throttle });
          peak = Math.max(peak, battle.player.position.y - base);
          const up = battle.player.vehicle.upVector();
          tilt = Math.max(tilt, (Math.acos(Math.min(1, Math.max(-1, up.y))) * 180) / Math.PI);
        }
        const travelled =
          (battle.player.position.x - startX) * site.dx + (battle.player.position.z - startZ) * site.dz;
        results.push({
          offset,
          throttle,
          // The crest is 13 m from the start, so this is "got over it and kept
          // going" rather than "reached it" — and short of it means parked
          // against it, which was the bug.
          crossed: travelled > 16,
          travelledM: Number(travelled.toFixed(1)),
          climbedM: Number(peak.toFixed(2)),
          tiltDeg: Number(tilt.toFixed(1)),
        });
      }
    }

    const centred = results.filter((r) => r.offset === 0 && r.throttle === 1);
    const clipped = results.filter((r) => r.offset !== 0);
    const crawled = results.filter((r) => r.throttle < 1);
    const pct = (rs) => (rs.length ? Math.round((rs.filter((r) => r.crossed).length / rs.length) * 100) : null);
    const mean = (rs, k) => (rs.length ? Number((rs.reduce((a, r) => a + r[k], 0) / rs.length).toFixed(2)) : null);

    return {
      map: mapId,
      structuresDown: battle.snapshot().boss?.structuresDown ?? 0,
      coverLostPct: Math.round((battle.snapshot().boss?.coverLost ?? 0) * 100),
      rubbleSitesFound: sites.length,
      approachesRun: results.length,
      /** The headline: a tank must be able to get over what the boss knocked down. */
      crossedCentrePct: pct(centred),
      crossedShoulderPct: pct(clipped),
      /** The one that used to fail outright: no momentum, just drive at it. */
      crossedAtCrawlPct: pct(crawled),
      climbedCentreM: mean(centred, 'climbedM'),
      climbedAtCrawlM: mean(crawled, 'climbedM'),
      climbedShoulderM: mean(clipped, 'climbedM'),
      /** Rolling over a shoulder is the whole difference between terrain and a lift. */
      tiltCentreDeg: mean(centred, 'tiltDeg'),
      tiltShoulderDeg: mean(clipped, 'tiltDeg'),
      runs: results,
    };
  }, { mapId });

  console.log(JSON.stringify(report, null, 2));
  if (errors.length) {
    console.log('\nPAGE ERRORS:');
    for (const e of errors) console.log('  ' + e);
  }
} finally {
  await browser.close();
  server.kill();
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit' });
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} exited ${c}`))));
  });
}
async function waitForServer(target, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try { if ((await fetch(target)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not start');
}
