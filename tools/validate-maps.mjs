/**
 * Map lint. Builds the app, serves it, and runs `validateMaps()` inside a real
 * browser so the check uses the same physics world and navgrid the game does.
 *
 * Catches the failures that are invisible when eyeballing a map file: an
 * objective declared at y=0 that actually sits on a 10 m platform, a spawn
 * buried inside a prop, a flag on a ledge with no route to it.
 *
 *   node tools/validate-maps.mjs            # build, serve, check, exit
 *   node tools/validate-maps.mjs <url>      # check an already-running server
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 4319;
const explicitUrl = process.argv[2];

let server = null;
let url = explicitUrl;

if (!url) {
  await run('npx', ['vite', 'build', '--logLevel', 'error']);
  server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    stdio: 'ignore',
    detached: false,
  });
  url = `http://localhost:${PORT}/`;
  await waitForServer(url);
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

let failures = 0;
try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(url, { waitUntil: 'networkidle' });

  const reports = await page.evaluate(() => window.tankArena.validateMaps());
  for (const report of reports) {
    const errors = report.issues.filter((i) => i.severity === 'error');
    const warnings = report.issues.filter((i) => i.severity === 'warning');
    failures += errors.length;
    const status = errors.length ? 'FAIL' : ' ok ';
    console.log(`${status} ${report.id.padEnd(10)} ${errors.length} errors, ${warnings.length} warnings`);
    for (const issue of report.issues) {
      console.log(`       [${issue.severity}] ${issue.what}: ${issue.detail}`);
    }
  }
  if (pageErrors.length) {
    failures += pageErrors.length;
    console.log('\nPage errors:');
    for (const e of pageErrors) console.log(`  ${e}`);
  }
} finally {
  await browser.close();
  if (server) server.kill();
}

console.log(failures ? `\n${failures} problem(s) found.` : '\nAll maps valid.');
process.exit(failures ? 1 : 0);

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function waitForServer(target, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(target);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not start at ${target}`);
}
