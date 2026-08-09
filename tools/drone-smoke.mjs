/**
 * Drone and supply-stock harness. Runs every drone in the table through a live
 * battle and checks the two things a drone actually changes: how hard a supply
 * lands, and how many of them can be running at once.
 *
 * Worth a harness rather than a play test because none of it is visible from
 * the outside. A drone that quietly failed to amplify, or one whose exclusivity
 * cancelled a buff it should not have touched, looks exactly like a drone that
 * works — you would only notice as a target dying slightly slower than it
 * should have, ten minutes into a battle. The numbers below are read straight
 * out of the damage funnel's own multipliers, so they are the same figures the
 * simulation uses rather than a restatement of them.
 *
 *   node tools/drone-smoke.mjs
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
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.click('#start');
  await page.waitForFunction(() => window.tankArena.battle() != null);

  const report = await page.evaluate(async () => {
    const SETTINGS = { mode: 'DM', mapId: 'sandbox', botCount: 3, difficulty: 'standard', timeLimit: 600 };
    const problems = [];

    const fresh = (drone) => {
      window.tankArena.restart(SETTINGS, { hull: 'hunter', turret: 'smoky', drone });
      const battle = window.tankArena.battle();
      // Every measurement below is of a supply applied on purpose, so clear
      // whatever the spawn left running first.
      battle.player.status.clear();
      return battle;
    };

    // ---- the stock a battle starts you with ------------------------------
    const start = fresh(null);
    const counts = Object.fromEntries(
      Object.entries(start.player.supplies).map(([k, v]) => [k, v.count]),
    );
    const stock = Math.min(...Object.values(counts));
    if (stock < 10) problems.push(`starting stock is only ${stock} of each`);
    if (new Set(Object.values(counts)).size !== 1) {
      problems.push(`starting stock is uneven: ${JSON.stringify(counts)}`);
    }

    // ---- no drone: the plain 2016 ruleset ---------------------------------
    const plain = fresh(null);
    plain.player.applySupply('damage', plain);
    plain.player.applySupply('armor', plain);
    plain.player.applySupply('nitro', plain);
    const stockRules = {
      damage: plain.player.status.damageDealtScale,
      taken: plain.player.status.damageTakenScale,
      speed: plain.player.status.movementScale,
      running: plain.player.status.list().length,
    };
    if (stockRules.damage !== 2) problems.push(`stock Double Damage is ×${stockRules.damage}`);
    if (stockRules.taken !== 0.5) problems.push(`stock Double Armour leaves ×${stockRules.taken}`);
    if (stockRules.running !== 3) problems.push(`stock buffs do not stack: ${stockRules.running} running`);

    // ---- every drone in the table ----------------------------------------
    const drones = [];
    for (const drone of Object.values(window.tankArena.drones)) {
      const label = drone.id;
      const battle = fresh(drone.id);
      const p = battle.player;
      if (p.drone?.id !== drone.id) {
        problems.push(`${label}: not fitted — the garage dropped it`);
        continue;
      }
      const amplify = drone.supplyAmplify ?? 1;

      p.applySupply('damage', battle);
      const damage = p.status.damageDealtScale;
      if (damage !== 2 ** amplify) problems.push(`${label}: Double Damage is ×${damage}, wanted ×${2 ** amplify}`);

      // Armour on top of damage: the exclusivity check and the amplification
      // check in one, because a drone that holds one charge has to have ended
      // the damage buff by now and a drone that holds two has to have kept it.
      p.applySupply('armor', battle);
      const taken = p.status.damageTakenScale;
      if (taken !== 0.5 ** amplify) problems.push(`${label}: Double Armour leaves ×${taken}`);
      const stillDamaged = p.status.has('doubleDamage');
      if (drone.exclusiveBuffs && stillDamaged) {
        problems.push(`${label}: two buffs running at once on a one-charge drone`);
      }
      if (!drone.exclusiveBuffs && !stillDamaged) {
        problems.push(`${label}: cancelled a buff it has no reason to`);
      }

      p.applySupply('nitro', battle);
      const speed = p.status.movementScale;
      if (!(speed > 1) || !Number.isFinite(speed)) problems.push(`${label}: Speed Boost is ×${speed}`);
      if (drone.exclusiveBuffs && p.status.has('doubleArmor')) {
        problems.push(`${label}: Speed Boost did not end the armour it replaced`);
      }

      // The heal is a flat number rather than a multiplier, so it is measured
      // by taking a bite out of the hull and putting it back.
      p.status.clear();
      p.health = Math.round(p.maxHealth * 0.2);
      const before = p.health;
      p.applySupply('repair', battle);
      const heal = p.health - before;

      // Half a second of battle with all of it running, to be sure none of
      // these numbers reaches the physics as a NaN.
      const idle = {
        forward: 1, turn: 0, turretTurn: 0, centreTurret: false,
        fire: true, overdrive: false, flip: false, supply: null, zoom: 0,
      };
      p.applySupply('nitro', battle);
      for (let i = 0; i < 30; i++) battle.update(1 / 60, idle);
      if (!Number.isFinite(p.health) || !Number.isFinite(p.position.x)) {
        problems.push(`${label}: tank left the simulation`);
      }

      drones.push({ id: label, damage, taken, speed: Number(speed.toFixed(2)), heal });
    }

    return { counts, stock, stockRules, drones, problems };
  });

  console.log('starting supplies:', report.counts);
  console.log('no drone:', report.stockRules);
  console.log('drones:');
  for (const d of report.drones) {
    console.log(`  ${d.id}: damage ×${d.damage} · damage taken ×${d.taken} · speed ×${d.speed} · repair ${d.heal} hp`);
  }

  const failures = [...report.problems];
  for (const e of errors) failures.push(`page error: ${e}`);

  if (failures.length) {
    console.error('\nFAIL');
    for (const f of failures) console.error('  ' + f);
    process.exitCode = 1;
  } else {
    console.log('\nOK — supplies stocked, every drone fitted and amplifying');
  }
} finally {
  await browser.close();
  server.kill();
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function waitForServer(target) {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(target);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('preview server never came up');
}
