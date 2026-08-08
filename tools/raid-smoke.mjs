/**
 * Boss Raid harness. Builds the app, serves it, starts a raid in a real browser
 * and fast-forwards the simulation far faster than real time, then reports what
 * actually happened.
 *
 * Raid balance is not eyeballable — the fight is four allied bots, one boss and
 * a five-minute clock, and the interesting numbers (how long it lasts, how much
 * of it the squad spends in the respawn queue, whether the boss's repair is
 * undoing progress, whether every ability actually fires) only exist in
 * aggregate. This is what
 * caught the two balance bugs that mattered: a repair rate that scaled off the
 * boss's own pool and out-healed the whole squad, and squadmates whose guns
 * could not reach the range the boss holds.
 *
 *   node tools/raid-smoke.mjs             # kungur, 400 simulated seconds
 *   node tools/raid-smoke.mjs silence     # a different map
 *
 * Run it several times: bot pathing makes single runs noisy, and it is the
 * spread across runs that tells you whether the mode is tuned.
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 4321;
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
  const seconds = Number(process.argv[3] ?? 400);
  // `restart` needs an existing battle, so enter one from the menu first.
  await page.click('#start');
  await page.waitForFunction(() => window.tankArena.battle() != null);
  const report = await page.evaluate(async ({ mapId, seconds }) => {
    window.tankArena.restart(
      { mode: 'RAID', mapId, botCount: 4, difficulty: 'standard', timeLimit: 600 },
      { hull: 'hunter', turret: 'smoky' },
    );
    const battle = window.tankArena.battle();
    const boss = battle.boss;
    const idle = {
      forward: 0, turn: 0, turretTurn: 0, centreTurret: false,
      fire: false, overdrive: false, flip: false, supply: null, zoom: 0,
    };

    const seen = { telegraphs: new Set(), phases: new Set(), notes: [] };
    const start = boss.health;
    const player = battle.player;
    let bossMoved = 0;
    let last = boss.position.clone();
    let samples = 0;
    let inRearArc = 0;
    let aggroOnPlayer = 0;
    let dreadPeak = 0;
    let coverLost = 0;
    let structuresDown = 0;
    const mark = {
      current: null, quarryAlive: true, lastBreak: 0, lastRemaining: 0,
      called: 0, onPlayer: 0, broken: 0, caught: 0, outlasted: 0, samples: 0,
      peak: 0, peakSum: 0, ended: 0,
    };

    for (let i = 0; i < 60 * seconds; i++) {
      // Stand-in for a competent player: slew the turret onto the boss, hold the
      // trigger and try to keep a working distance.
      let turretTurn = 0;
      let forward = 0;
      let turn = 0;
      if (player.alive && boss.alive) {
        const wrap = (a) => {
          let d = a % (Math.PI * 2);
          if (d > Math.PI) d -= Math.PI * 2;
          if (d < -Math.PI) d += Math.PI * 2;
          return d;
        };
        const dx = boss.position.x - player.position.x;
        const dz = boss.position.z - player.position.z;
        const want = Math.atan2(dx, dz);
        const dTurret = wrap(want - player.turretYaw);
        // Tap rather than hold near the target, the way a player does — holding
        // Z/X all the way in makes the turret oscillate and never settle.
        turretTurn = Math.abs(dTurret) < 0.06 ? 0 : Math.sign(dTurret);
        const dist = Math.hypot(dx, dz);
        // Drive the hull at the boss as well, or the "player" wedges itself
        // against the first wall it spawned facing and never fires a live shot.
        const dHull = wrap(want - player.vehicle.yaw);
        turn = Math.max(-1, Math.min(1, dHull * 2.2));
        forward = dist > 65 ? 1 : dist < 40 ? -0.8 : 0;
      }
      // Fire when the HUD would be showing a lock, which is what a player does.
      battle.update(1 / 60, { ...idle, fire: battle.lockedTarget === boss, turretTurn, forward, turn });

      if (i % 6 === 0) {
        const snap = battle.snapshot();
        if (snap.boss?.telegraph) seen.telegraphs.add(snap.boss.telegraph);
        if (snap.boss) {
          seen.phases.add(snap.boss.phase);
          if (snap.boss.targetingPlayer) aggroOnPlayer += 1;

          // The hunt, sampled on transitions. A mark that never fires, never
          // ends, or only ever ends one way is the failure mode worth catching
          // — the mechanic is meant to have three exits and be survivable by
          // all of them, and none of that is visible from the health bar.
          const marked = snap.boss.markedName;
          if (marked && !mark.current) {
            mark.called += 1;
            if (snap.boss.markedPlayer) mark.onPlayer += 1;
          } else if (!marked && mark.current) {
            // Attribute the ending by the clock rather than by the rescue bar.
            // The tick that pushes the bar over the threshold also clears the
            // mark, so a successful rescue is never *observed* at 100% — read
            // that way, every break in the fight was miscounted as a timeout.
            // Time left on a live quarry is the unambiguous signal.
            if (!mark.quarryAlive) mark.caught += 1;
            else if (mark.lastRemaining > 0.3) mark.broken += 1;
            else mark.outlasted += 1;
          }
          if (marked) {
            const who = battle.tanks.find((t) => t.name === marked);
            mark.quarryAlive = !!who?.alive;
            mark.lastBreak = snap.boss.markBreak;
            mark.lastRemaining = snap.boss.markRemaining;
            mark.peak = Math.max(mark.peak, snap.boss.markBreak);
            mark.samples += 1;
          } else if (mark.current) {
            // Bank how far the rescue actually got, so a threshold that is
            // never reached can be re-sized against real numbers rather than
            // against an estimate of what a squad "should" manage.
            mark.peakSum += mark.lastBreak;
            mark.ended += 1;
          }
          mark.current = marked;
          dreadPeak = Math.max(dreadPeak, snap.boss.dread);
          // The arena itself, which is the one pressure in the mode that only
          // ever goes one way — if a run ends with the cover untouched the
          // demolition is decorative, and if it ends near total the raid spent
          // the last phase in a car park.
          coverLost = Math.max(coverLost, snap.boss.coverLost);
          structuresDown = Math.max(structuresDown, snap.boss.structuresDown);
        }
        if (snap.over) { seen.notes.push(`over at ${(i / 60).toFixed(0)}s: ${snap.winner} — ${snap.reason}`); break; }
        // A destroyed tank is parked far below the arena, so sampling its
        // position while it is down reports the trip to the car park as travel.
        if (boss.alive) bossMoved += boss.position.distanceTo(last);
        last = boss.position.clone();

        if (player.alive && boss.alive) {
          samples += 1;
          const f = boss.vehicle.forwardVector();
          const dx = player.position.x - boss.position.x;
          const dz = player.position.z - boss.position.z;
          const len = Math.hypot(dx, dz) || 1;
          if ((dx * f.x + dz * f.z) / len < -0.35) inRearArc += 1;
        }
      }
    }

    const snap = battle.snapshot();
    return {
      simulatedSeconds: Math.round(snap.elapsed),
      bossStartHealth: start,
      bossMaxHealth: boss.maxHealth,
      bossHealth: Math.round(boss.health),
      bossHealthPct: Math.round(boss.healthFraction * 100),
      bossMovedMetres: Math.round(bossMoved),
      bossKills: boss.kills,
      bossDamageDealt: Math.round(boss.damageDealt),
      telegraphsSeen: [...seen.telegraphs],
      phasesSeen: [...seen.phases],
      squadLosses: snap.boss?.losses,
      respawnDelay: snap.boss?.respawnDelay,
      bossEnraged: snap.boss?.enraged,
      bossSupplies: Object.fromEntries(
        Object.entries(boss.supplies).map(([k, v]) => [k, v.count]),
      ),
      targetingPlayer: snap.boss?.targetingPlayer,
      playerThreat: Math.round((snap.boss?.playerThreat ?? 0) * 100),
      hudLine: snap.modeLine,
      playerInRearArcPct: samples ? Math.round((inRearArc / samples) * 100) : 0,
      aggroOnPlayerPct: samples ? Math.round((aggroOnPlayer / samples) * 100) : 0,
      marksCalled: mark.called,
      marksOnPlayer: mark.onPlayer,
      markEndedBroken: mark.broken,
      markEndedCaught: mark.caught,
      markEndedOutlasted: mark.outlasted,
      /** Share of the fight somebody was being hunted. Ambient is a failure. */
      markedPct: samples ? Math.round((mark.samples / samples) * 100) : 0,
      dreadPeak: Number(dreadPeak.toFixed(2)),
      /** Share of the map's cover the Overseer destroyed, and how many props. */
      coverLostPct: Math.round(coverLost * 100),
      structuresDown,
      /** Radio calls the squad made. Silence is a bug; a wall of text is worse. */
      squadCalls: battle.squadCalls?.() ?? 0,
      /** Best and mean rescue progress reached, 0..1 — how close help ever got. */
      markBreakBest: Number(mark.peak.toFixed(2)),
      markBreakMean: mark.ended ? Number((mark.peakSum / mark.ended).toFixed(2)) : 0,
      over: snap.over,
      notes: seen.notes,
      scoreboard: snap.scoreboard.map((t) => ({
        name: t.name,
        persona: t.ai?.persona.displayName ?? 'you',
        score: Math.round(t.score),
        dmg: Math.round(t.damageDealt),
        deaths: t.deaths,
        alive: t.alive,
      })),
    };
  }, { mapId, seconds });

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
