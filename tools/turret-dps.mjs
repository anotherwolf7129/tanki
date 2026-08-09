/**
 * Turret damage harness. Puts every turret in the game on a firing range,
 * holds the trigger against a pinned target, and reports what actually comes
 * out the other end.
 *
 * The table cannot be read for this. A turret's `damage` field means a
 * different thing in every firing mode — a shell for Magnum, a tenth of a
 * second of contact for Firebird, one pellet of eight for Hammer — so the
 * numbers in `turrets.json` are not comparable to each other and never were.
 * The only figure that compares is damage actually put into a tank per second
 * of trigger, with the reload, the clip, the fuel drain, the heat ceiling, the
 * spin-up, the chain falloff and the range band all in play. This measures
 * exactly that, in the real simulation, and prints it sorted.
 *
 * That is what it is for: the close-range guns spent a long time reading fine
 * in the data and landing for a third of the field's output in a fight, and no
 * amount of squinting at a JSON file would have shown it.
 *
 *   node tools/turret-dps.mjs           # every turret, 12 s each, at knife range
 *   node tools/turret-dps.mjs 20        # longer, for the slow-cycling guns
 *
 * Numbers are for the player's own tank, so they include the difficulty
 * profile's turret tier — the gun as you actually drive it, not as authored.
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

  const seconds = Number(process.argv[2] ?? 12);
  const difficulty = process.argv[3] ?? 'standard';
  const rows = await page.evaluate(
    async ({ seconds, difficulty }) => {
      const idle = {
        forward: 0, turn: 0, turretTurn: 0, centreTurret: false,
        fire: false, overdrive: false, flip: false, supply: null, zoom: 0,
      };
      const out = [];

      // Every purchasable gun, plus the two the mode hands out — those are the
      // ceiling everything else is judged against, so leaving them out of the
      // table would hide the only reference points worth having.
      const ids = Object.keys(window.tankArena.turrets);

      for (const id of ids) {
        window.tankArena.restart(
          { mode: 'DM', mapId: 'sandbox', botCount: 1, difficulty, timeLimit: 900 },
          // Juggernaut is the only hull that overrides the fitted turret, so
          // the range car is a plain medium and every gun gets mounted.
          { hull: 'hunter', turret: id },
        );
        const battle = window.tankArena.battle();
        const me = battle.player;
        const mark = battle.tanks.find((t) => t !== me);
        if (!mark || me.turretDef.id !== id) continue;

        // The range car: a target that cannot shoot back, cannot drive off and
        // cannot die, held at a fixed distance in front of the gun. Anything
        // less and the figure measures bot pathing instead of the turret.
        mark.ai = null;
        const distance = Math.max(6, Math.min(reach(me.turretDef), 18));
        const settle = 90;
        let dealt = 0;

        for (let i = 0; i < 60 * seconds + settle; i++) {
          pin(me, mark, distance);
          if (i === settle) dealt = me.damageDealt;
          battle.update(1 / 60, { ...idle, fire: true, ...held(me.weapon) });
        }

        const dps = (me.damageDealt - dealt) / seconds;
        out.push({
          id,
          class: me.turretDef.class,
          mode: me.turretDef.fireMode,
          dps: Math.round(dps),
          metres: Math.round(distance),
        });
      }
      return out;

      /** How far out this gun is meant to work, so nothing is measured out of band. */
      function reach(t) {
        if (t.cone) return t.cone.range * 0.6;
        if (t.beam) return t.beam.range * 0.6;
        if (t.chain) return (t.hardCap ?? t.chain.jumpRange) * 0.6;
        return t.rangeMaxDamage * 0.8;
      }

      /**
       * Shaft and Gauss are not held, they are *released* — the trigger winds
       * the charge up and letting go is the shot. Holding one down forever, as
       * every other gun here wants, measures zero. Watching the charge and
       * letting go at the top is how a player fires them, and it needs no
       * per-turret timing constants to stay right.
       */
      function held(weapon) {
        if (!weapon.releaseFires) return {};
        return { fire: weapon.chargeFraction < 0.999 };
      }

      /** Reset the pair to the firing line, facing each other, every frame. */
      function pin(me, mark, distance) {
        me.spawnProtection = 0;
        mark.spawnProtection = 0;
        mark.health = mark.maxHealth = 1e9;
        // Its statuses are deliberately left alone: the fire Firebird leaves
        // behind is most of what Firebird does, and a target scrubbed clean
        // every frame would report the stream without the burn. Nothing it
        // catches can help it escape — the position is forced regardless.

        const p = me.vehicle.body.position;
        me.vehicle.body.velocity.set(0, 0, 0);
        me.vehicle.body.angularVelocity.set(0, 0, 0);

        mark.vehicle.body.position.set(p.x, p.y, p.z + distance);
        mark.vehicle.body.velocity.set(0, 0, 0);
        mark.vehicle.body.angularVelocity.set(0, 0, 0);

        // Lay the barrel on the target's centre of mass directly, rather than
        // levelling it and trusting the two to line up. The turret ring sits
        // well above the hull, so a level barrel throws a zero-width ray clean
        // over the roof of a tank parked at the same height — which reads as a
        // gun that does no damage rather than as a harness that missed.
        const muzzle = me.muzzle();
        const to = mark.centre();
        const dx = to.x - muzzle.x;
        const dy = to.y - muzzle.y;
        const dz = to.z - muzzle.z;
        me.turretYaw = me.desiredYaw = Math.atan2(dx, dz);
        me.turretPitch = me.desiredPitch = Math.asin(dy / Math.max(0.001, Math.hypot(dx, dy, dz)));
      }
    },
    { seconds, difficulty },
  );

  rows.sort((a, b) => a.dps - b.dps);
  console.log(`\nsustained damage per second — ${difficulty}, ${seconds}s per gun, player's own tank\n`);
  for (const r of rows) {
    console.log(
      `${String(r.dps).padStart(6)}  ${r.id.padEnd(11)} ${r.class.padEnd(14)} ${r.mode.padEnd(10)} @ ${r.metres}m`,
    );
  }

  const dead = rows.filter((r) => r.dps <= 0);
  if (dead.length) {
    console.error(`\nFAIL — these guns put out nothing at all: ${dead.map((r) => r.id).join(', ')}`);
    process.exitCode = 1;
  }
  if (errors.length) {
    console.error('\npage errors:\n' + errors.join('\n'));
    process.exitCode = 1;
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
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('preview server never came up');
}
