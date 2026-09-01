#!/usr/bin/env node
/**
 * Docs/contract drift check.
 *
 * `packages/config/src/index.ts` is the single source of truth for the environment. This script
 * loads it for real (through scripts/env-snapshot.mts) and fails if:
 *
 *   1. `.env.example` is missing a variable the app reads, or documents one that no longer exists;
 *   2. `docs/ENVIRONMENT.md` is missing a variable, documents an unknown one, or shows a default
 *      that differs from what the schema produces;
 *   3. a documented `FATAL:` boot guard no longer appears in the config source.
 *
 * It is cheap (one process boot, no network, no database), so CI runs it before the tests.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const errors = [];

/* ------------------------------- snapshot ------------------------------- */

function tsxCli() {
  const candidates = [
    path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(root, 'node_modules', '.bin', 'tsx'),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

function snapshot() {
  const cli = tsxCli();
  if (!cli) {
    errors.push('cannot find tsx — run `npm install` first (this check boots the real config).');
    return null;
  }
  // Run outside the repo so `dotenv` finds no `.env` and we see true schema defaults.
  const res = spawnSync(process.execPath, [cli, path.join(root, 'scripts', 'env-snapshot.mts')], {
    cwd: os.tmpdir(),
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'development' },
  });
  if (res.status !== 0) {
    errors.push(`env-snapshot failed: ${(res.stderr || res.stdout || '').trim().split('\n').slice(0, 3).join(' / ')}`);
    return null;
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    errors.push('env-snapshot did not print JSON.');
    return null;
  }
}

/* ------------------------------ .env.example ----------------------------- */

function stripComment(line) {
  const i = line.search(/\s#/);
  return (i === -1 ? line : line.slice(0, i)).trim();
}

function envExampleKeys() {
  const file = path.join(root, '.env.example');
  if (!existsSync(file)) {
    errors.push('.env.example is missing.');
    return null;
  }
  const keys = [];
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = stripComment(raw);
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) {
      errors.push(`.env.example: not a KEY=VALUE line: ${raw.slice(0, 60)}`);
      continue;
    }
    keys.push(line.slice(0, eq).trim());
  }
  return keys;
}

/* ------------------------------ ENVIRONMENT.md --------------------------- */

function render(value) {
  if (value === '') return '`*(empty)*`';
  if (value === true) return '`true`';
  if (value === false) return '`false`';
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.length ? '`' + value.join(',') + '`' : '`*(empty)*`';
  if (typeof value === 'string') return '`' + value + '`';
  return '`' + String(value) + '`';
}

function docTable(file) {
  const full = path.join(root, file);
  if (!existsSync(full)) {
    errors.push(`${file} is missing.`);
    return null;
  }
  const rows = new Map();
  for (const line of readFileSync(full, 'utf8').split('\n')) {
    const m = line.match(/^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|([^|]*)\|/);
    if (m) rows.set(m[1], m[2].trim());
  }
  if (!rows.size) errors.push(`${file}: no | \`VAR\` | default | … table rows found.`);
  return rows;
}

/* --------------------------------- run ---------------------------------- */

const snap = snapshot();

if (snap) {
  const keys = Object.keys(snap);

  const example = envExampleKeys();
  if (example) {
    const dupes = example.filter((k, i) => example.indexOf(k) !== i);
    if (dupes.length) errors.push(`.env.example: duplicate entries for ${[...new Set(dupes)].join(', ')}`);
    for (const k of keys) if (!example.includes(k)) errors.push(`.env.example: missing ${k} (default ${JSON.stringify(snap[k])})`);
    for (const k of example) if (!(k in snap)) errors.push(`.env.example: ${k} is not read by @d7/config — stale or a typo`);
  }

  const table = docTable('docs/ENVIRONMENT.md');
  if (table) {
    for (const k of keys) {
      if (!table.has(k)) {
        errors.push(`docs/ENVIRONMENT.md: no row for ${k}`);
        continue;
      }
      const want = render(snap[k]);
      if (table.get(k) !== want) {
        errors.push(`docs/ENVIRONMENT.md: \`${k}\` documents ${table.get(k)} but the schema default is ${want}`);
      }
    }
    for (const k of table.keys()) if (!(k in snap)) errors.push(`docs/ENVIRONMENT.md: row for unknown variable ${k}`);
  }

  const cfg = readFileSync(path.join(root, 'packages', 'config', 'src', 'index.ts'), 'utf8');
  const guards = [
    'FATAL: APP_SECRET must be set to a high-entropy value in production.',
    'FATAL: DB_DRIVER=pglite is not a production datastore. Use postgres.',
    'FATAL: DATABASE_URL is required in production.',
  ];
  for (const g of guards) {
    if (!cfg.includes(g)) errors.push(`docs/ENVIRONMENT.md documents a boot guard that config no longer throws: "${g}"`);
  }

  console.log(`env contract: ${keys.length} variables, ${example ? example.length : 0} in .env.example, ${table ? table.size : 0} documented rows`);
}

if (errors.length) {
  console.error(`\nenv docs check FAILED (${errors.length}):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('env docs check OK');
