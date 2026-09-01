#!/usr/bin/env node
/**
 * Vercel deploy layout check — run as the first half of `buildCommand`.
 *
 * Why this exists: two failed Vercel deploys of this repository each produced an error that pointed
 * somewhere other than the cause.
 *
 *   1. `error TS5058: The specified path does not exist: 'tsconfig.json'` from `/vercel/path0/apps/api`
 *      — the Root Directory was `apps/api`, so the build looked at one workspace instead of the
 *      repository, and never read `vercel.json` at all.
 *   2. `Command "npm run typecheck" exited with 1` with no TypeScript source errors — because the
 *      project has `NODE_ENV=production` set (the deploy guide says to set it), that variable is
 *      present during the build too, and npm then omits devDependencies: `NODE_ENV=production npm
 *      config get omit` prints `dev`. `typescript` is a root devDependency, so `tsc` is not installed.
 *      `installCommand` therefore pins `npm ci --include=dev`.
 *
 * Both mistakes are invisible to the app and cheap to assert, so assert them and fail with the real
 * reason instead of letting the builder improvise an error from a neighbouring field. Everything here
 * is cwd-driven, because Vercel runs the build from the configured project root: "where am I" and
 * "what did the install actually put down" are exactly the things under test. Plain `.mjs` on
 * purpose — this runs before the toolchain is trusted, with `node`, not `tsx`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.cwd());
const problems = [];
const hints = [];
const has = (...parts) => existsSync(join(root, ...parts));

function check(condition, message) {
  if (!condition) problems.push(message);
}

let manifest = null;
try {
  manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
} catch {
  problems.push(`no package.json in ${root} — that is not a Node project root`);
}

if (manifest) {
  check(Array.isArray(manifest.workspaces) && manifest.workspaces.length > 0, 'package.json here has no "workspaces" field: this is not the repository root, it is a package inside it');
  check(has('api', 'index.ts'), 'api/index.ts is missing: Vercel builds exactly one function from it, and it lives at the repository root');
  check(has('vercel.json'), 'vercel.json is missing: the rewrite, function settings and cron schedules all live there');
  check(has('tsconfig.json'), 'tsconfig.json is missing: the whole monorepo is typechecked as one project from the root');
  check(has('packages', 'config', 'src', 'index.ts'), 'packages/config/src/index.ts is missing: @d7/* workspace imports resolve into sibling packages, so they must be inside the project root');
  const migrations = join(root, 'packages', 'database', 'migrations');
  const sql = existsSync(migrations) ? readdirSync(migrations).filter((f) => f.endsWith('.sql')) : [];
  check(sql.length > 0, 'no packages/database/migrations/*.sql found: functions.includeFiles in vercel.json copies this directory into the function, and it is empty');

  // The installed tree, but only when there is one: before `npm ci` these absences are normal, and a
  // "missing" report would be noise rather than a finding.
  if (has('node_modules')) {
    check(has('node_modules', 'tsx', 'package.json'), 'node_modules/tsx is missing. `tsx` is a *production* dependency here specifically because the API, every job CLI and the serverless entry run TypeScript through it, so its absence means the install did not follow the manifest');
    // Ask the manifest, not node_modules/.package-lock.json: with `omit=dev` npm rewrites that file
    // to the pruned tree, so "typescript is a devDependency" is no longer recorded anywhere inside
    // node_modules — exactly the state we are trying to explain.
    const declaredDev = Boolean(manifest.devDependencies?.typescript);
    if (!has('node_modules', 'typescript', 'package.json') && declaredDev) {
      problems.push('node_modules/typescript is missing, and `tsc` is part of buildCommand');
      hints.push(
        process.env.NODE_ENV === 'production'
          ? 'That is what NODE_ENV=production does to a build: npm derives omit=dev from it (check: `NODE_ENV=production npm config get omit`), so no devDependency is installed — typescript and vitest types included, which is enough to fail `tsc -p tsconfig.json` even though no source is wrong. Fix: installCommand "npm ci --include=dev" (what vercel.json sets), or drop the typecheck from buildCommand and leave it to CI.'
          : 'Run `npm ci` at the repository root; typescript is a root devDependency.',
      );
    }
  }
}

if (problems.length) {
  console.error('\nVercel deploy layout check FAILED');
  console.error(`project root as seen by the build: ${root}`);
  console.error(`NODE_ENV: ${process.env.NODE_ENV || '(unset)'}\n`);
  for (const p of problems) console.error(`  - ${p}`);
  for (const h of hints) console.error(`\n  ${h}`);
  if (problems.some((p) => /repository root|workspaces/.test(p))) {
    console.error('\nIn the Vercel dashboard: Settings → General → Root Directory must be the REPOSITORY');
    console.error('ROOT (empty / "./"), not "apps/api". Everything else (@d7/* workspace symlinks,');
    console.error('packages/database/migrations, vercel.json, api/index.ts) sits above that directory.');
  }
  console.error('');
  process.exit(1);
}

console.log(`vercel layout OK — ${root}`);
