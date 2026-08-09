/**
 * Augment harness. Fits every augment in the table to a real battle, one after
 * another, and reports anything that comes back broken.
 *
 * Augments are the one system that reaches into every other one: they rewrite
 * turret and hull definitions before the simulation ever sees them, and a bad
 * multiplier does not throw — it produces a clip of zero shells, a NaN reload,
 * or a cone with no angle, and the battle simply stops making sense somewhere
 * downstream. Eighty-odd of those cannot be checked by playing them.
 *
 * It also pins the two things about Vulcan's Ignition that are worth a
 * regression test rather than a play test: it does nothing at all until the
 * barrel is genuinely overheated, and once it is, the burn it leaves behind is
 * heavy enough and long enough to finish a tank on its own.
 *
 *   node tools/augment-smoke.mjs           # every augment, 1 s of battle each
 *   node tools/augment-smoke.mjs 3         # 3 s each, slower and more thorough
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 4322;
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

  const seconds = Number(process.argv[2] ?? 1);
  const report = await page.evaluate(async (seconds) => {
    const idle = {
      forward: 0, turn: 0, turretTurn: 0, centreTurret: false,
      fire: false, overdrive: false, flip: false, supply: null, zoom: 0,
    };
    const finite = (n) => typeof n === 'number' && Number.isFinite(n);
    const problems = [];
    const fitted = [];

    // ---- every augment, fitted to a live battle ------------------------
    for (const aug of Object.values(window.tankArena.augments)) {
      const hull = aug.slot === 'hull' ? aug.item : 'hunter';
      const turret = aug.slot === 'turret' ? aug.item : 'smoky';
      window.tankArena.restart(
        { mode: 'DM', mapId: 'sandbox', botCount: 3, difficulty: 'standard', timeLimit: 600 },
        { hull, turret, augments: { [aug.item]: aug.id } },
      );
      const battle = window.tankArena.battle();
      const p = battle.player;

      const label = `${aug.id}`;
      if ((aug.slot === 'hull' ? p.hullAugment : p.turretAugment)?.id !== aug.id) {
        problems.push(`${label}: not fitted — the garage dropped it`);
        continue;
      }

      const t = p.turretDef;
      const h = p.hull;
      const numbers = {
        damage: t.damage, reload: t.reloadTime, rangeMax: t.rangeMaxDamage, rangeMin: t.rangeMinDamage,
        rotation: t.rotationSpeed, protection: h.protection, topSpeed: h.topSpeed, turn: h.turnSpeed,
        clip: t.clip?.size, pellets: t.pellets?.count, missiles: t.guided?.missiles, jumps: t.chain?.jumps,
        coneAngle: t.cone?.angleDeg, beam: t.beam?.range, fuel: t.fuel?.capacity, heatCeiling: t.heat?.ceiling,
        splash: t.splash?.radius, charge: t.charge?.time, scopedCharge: t.scoped?.chargeTime, alt: t.alt?.damage,
      };
      for (const [key, value] of Object.entries(numbers)) {
        if (value === undefined) continue;
        if (!finite(value) || value <= 0) problems.push(`${label}: ${key} is ${value}`);
      }
      if (p.maxHealth <= 0) problems.push(`${label}: hull has no health`);

      // Hold the trigger for a moment so the firing path actually runs with
      // these numbers — a clip or fuel figure an augment broke shows up as a
      // stuck gun, not as a bad field.
      for (let i = 0; i < 60 * seconds; i++) {
        battle.update(1 / 60, { ...idle, fire: true });
      }
      if (!finite(p.health) || !finite(p.position.x)) problems.push(`${label}: tank left the simulation`);
      fitted.push(label);
    }

    // ---- Vulcan Ignition, the headline augment --------------------------
    window.tankArena.restart(
      { mode: 'DM', mapId: 'sandbox', botCount: 3, difficulty: 'standard', timeLimit: 600 },
      { hull: 'titan', turret: 'vulcan', augments: { vulcan: 'vulcan.ignition', titan: 'titan.thermal_sink' } },
    );
    const battle = window.tankArena.battle();
    const player = battle.player;
    const target = battle.tanks.find((t) => t !== player);
    // Spawn protection would swallow the hit this whole check is built on.
    target.spawnProtection = 0;
    player.spawnProtection = 0;

    const ignition = { ceiling: player.weapon.heatCeiling };

    player.weapon.heat = 0.5;
    battle.damage(target, 5, player, { kind: 'direct' });
    ignition.coldBurn = target.status.magnitude('burning');

    player.weapon.heat = 1.05;
    battle.damage(target, 5, player, { kind: 'direct' });
    ignition.hotBurn = target.status.magnitude('burning');
    ignition.hotDuration = target.status.remaining('burning');

    // Let it cook with nothing else touching it, and see how much of the tank
    // the burn alone takes off.
    const before = target.health;
    target.ai = null;
    for (let i = 0; i < 60 * 8; i++) target.update(1 / 60, battle);
    ignition.burnDamage = Math.round(before - target.health);
    ignition.burnFraction = Math.round(((before - target.health) / target.maxHealth) * 100);

    // ---- what the bots brought ------------------------------------------
    const bots = battle.tanks
      .filter((t) => !t.isPlayer)
      .map((t) => `${t.name}: ${t.hullAugment?.displayName ?? '—'} / ${t.turretAugment?.displayName ?? '—'}`);

    return { checked: fitted.length, problems, ignition, bots };
  }, seconds);

  console.log(`augments fitted and simulated: ${report.checked}`);
  console.log('vulcan ignition:', report.ignition);
  console.log('bot fittings:');
  for (const line of report.bots) console.log('  ' + line);

  const failures = [...report.problems];
  if (report.ignition.coldBurn !== 0) failures.push('ignition burned a target while the barrel was cool');
  if (!(report.ignition.hotBurn > 0)) failures.push('ignition did not burn a target while overheated');
  if (!(report.ignition.burnFraction > 5)) failures.push('ignition burn is not worth fitting');
  if (report.ignition.ceiling <= 1.15) failures.push('ignition did not raise the heat ceiling');
  for (const e of errors) failures.push(`page error: ${e}`);

  if (failures.length) {
    console.error('\nFAIL');
    for (const f of failures) console.error('  ' + f);
    process.exitCode = 1;
  } else {
    console.log('\nOK — every augment fitted, simulated and sane');
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
