/**
 * `npm run dev` — one command that leaves you with a working local stack.
 *
 *   node scripts/dev.mjs                # migrate, then API (+ web when apps/web has source)
 *   node scripts/dev.mjs --seed         # also seed the demo catalog (destructive: dev DB only)
 *   node scripts/dev.mjs --no-db        # skip the migration step
 *   node scripts/dev.mjs --api-only     # do not start the web tier even if it exists
 *
 * Deliberately dependency-free (no concurrently/nodemon): the only thing it has to do is spawn
 * the workspace dev scripts, prefix their output, and make sure Ctrl-C takes both children down.
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** A Next app needs a route dir; `apps/web` is a manifest-only stub until the front end lands. */
function webImplemented() {
  return ['app', 'src/app', 'pages', 'src/pages'].some((d) => existsSync(path.join(root, 'apps/web', d)));
}

function envReady() {
  if (existsSync(path.join(root, '.env'))) return true;
  const example = path.join(root, '.env.example');
  if (!existsSync(example)) return false;
  copyFileSync(example, path.join(root, '.env'));
  say('! no .env found — copied .env.example to .env (dev defaults, embedded Postgres).', 'warn');
  return true;
}

const COLORS = { api: '\x1b[36m', web: '\x1b[35m', db: '\x1b[33m', sys: '\x1b[1m' };
const RESET = '\x1b[0m';

function say(msg, who = 'sys') {
  const c = COLORS[who] ?? '';
  process.stdout.write(`${c}${who.padEnd(3)}${RESET} ${msg}\n`);
}

/** Prefix each line so two watchers in one terminal stay readable. */
function pipeLines(stream, who) {
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const c = COLORS[who] ?? '';
  rl.on('line', (line) => process.stdout.write(`${c}${who.padEnd(3)}${RESET} ${line}\n`));
}

function runNpm(task, { inherit = false } = {}) {
  const [script, ...rest] = task.split(' ');
  const child = spawn(npm, ['run', script, ...rest], { cwd: root, stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
  return child;
}

function main() {
  envReady();

  if (!flag('no-db')) {
    say('migrating (idempotent; safe to re-run)', 'db');
    const res = spawnSync(npm, ['run', 'db:migrate'], { cwd: root, stdio: 'inherit' });
    if (res.status !== 0) {
      say('db:migrate failed — fix that before starting the servers (boot would only repeat it).', 'db');
      process.exit(res.status ?? 1);
    }
    if (flag('seed')) {
      const seeded = existsSync(path.join(root, '.data/storage')) || existsSync(path.join(root, 'storage/audio'));
      if (!seeded) {
        say('seeding demo catalog + generated audio (first run takes ~15 s)…', 'db');
        spawnSync(npm, ['run', 'db:seed'], { cwd: root, stdio: 'inherit' });
      } else {
        say('storage already has objects — skipping seed (use `npm run db:reset` to start over).', 'db');
      }
    }
  }

  const children = [];
  const api = runNpm('dev:api');
  pipeLines(api.stdout, 'api');
  pipeLines(api.stderr, 'api');
  children.push(['api', api]);
  say('API on http://localhost:4000  ·  GET /api/health', 'sys');

  const wantWeb = !flag('api-only') && webImplemented();
  if (wantWeb) {
    const web = runNpm('dev:web');
    pipeLines(web.stdout, 'web');
    pipeLines(web.stderr, 'web');
    children.push(['web', web]);
    say('web on http://localhost:3000', 'sys');
  } else if (!flag('api-only')) {
    say('apps/web has no source yet — starting the API only. The front end talks to GET /api/config.', 'sys');
  }

  const readPort = () => {
    try {
      const m = readFileSync(path.join(root, '.env'), 'utf8').match(/^API_PORT=(\d+)$/m);
      return m ? Number(m[1]) : 4000;
    } catch {
      return 4000;
    }
  };
  const port = readPort();
  say(`curl -s http://localhost:${port}/api/health | head -c 400   # what the deployment checks`, 'sys');

  let closing = false;
  const stop = (signal) => {
    if (closing) return;
    closing = true;
    for (const [, child] of children) child.kill(signal);
    setTimeout(() => process.exit(0), 400).unref();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  for (const [who, child] of children) {
    child.on('exit', (code) => {
      if (closing) return;
      say(`${who} exited with code ${code ?? 'null'} — shutting the rest down`, who);
      stop('SIGTERM');
      process.exitCode = code ?? 0;
    });
  }
}

main();
