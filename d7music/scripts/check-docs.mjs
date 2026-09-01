#!/usr/bin/env node
/**
 * Docs lint. Documentation is only worth reading if it cannot rot silently, so the same rules are
 * machine-checked here rather than promised in prose:
 *
 *   1. every relative link and every backticked repo path in the docs resolves to a real file;
 *   2. every `npm run <script>` mentioned in the docs exists in the root package.json (workspace
 *      scripts are resolved through the owning package.json);
 *   3. every fenced block is closed;
 *   4. no ALL_CAPS token that *looks* like one of our environment variables (by known prefix) is
 *      unknown to the schema — the commonest way a doc goes stale is a renamed var;
 *   5. migration files are zero-padded, unique, and in ascending order;
 *   6. then it hands over to check-env-docs.mjs for the env contract itself.
 *
 * Exit code is non-zero on any finding, so CI fails rather than warns.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const problems = [];
const note = (file, msg) => problems.push(`${file}: ${msg}`);

const DOC_FILES = [
  ...readdirSync(path.join(root, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/${f}`),
  ...(existsSync(path.join(root, 'README.md')) ? ['README.md'] : []),
];

/* ------------------------- 1/2/3: links, commands, fences ------------------------- */

const ENV_PREFIXES = [
  'NODE_', 'LOG_', 'API_', 'WEB_', 'TRUST_', 'APP_', 'SESSION_', 'BCRYPT_', 'DB_', 'DATABASE_', 'PGLITE_',
  'REDIS_', 'CACHE_', 'QUEUE_', 'STORAGE_', 'S3_', 'STREAM_', 'MUSIC_', 'METADATA_', 'MUSICBRAINZ_',
  'RELEASE_SYNC_', 'RECAND_', 'RECOMMENDATION_', 'LLM_', 'ASSISTANT_', 'OAUTH_', 'GOOGLE_', 'GITHUB_',
  'OIDC_', 'SMTP_', 'MAIL_', 'PAYMENT_', 'STRIPE_', 'RATE_LIMIT_', 'UPLOAD_', 'ALLOW_', 'REQUIRE_',
  'REPORT_', 'SEED_',
];

const rootPkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const workspaceScripts = new Map();
for (const dir of ['apps', 'packages', 'services', 'jobs']) {
  const base = path.join(root, dir);
  if (!existsSync(base)) continue;
  for (const name of readdirSync(base)) {
    const manifest = path.join(base, name, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    workspaceScripts.set(pkg.name, Object.keys(pkg.scripts ?? {}));
  }
}

const knownEnv = new Set(
  (() => {
    const res = spawnSync(process.execPath, [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(root, 'scripts', 'env-snapshot.mts')], {
      cwd: '/tmp',
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'development' },
    });
    if (res.status !== 0) {
      problems.push('(setup): env-snapshot failed — run `npm install` so the docs check can boot the real config.');
      return [];
    }
    return Object.keys(JSON.parse(res.stdout));
  })(),
);

for (const rel of DOC_FILES) {
  const text = readFileSync(path.join(root, rel), 'utf8');
  const dir = path.dirname(path.join(root, rel));

  let fences = 0;
  for (const line of text.split('\n')) if (/^```/.test(line)) fences += 1;
  if (fences % 2) note(rel, `unbalanced code fence (${fences} \`\`\` markers)`);

  // markdown links
  for (const m of text.matchAll(/\[([^\]]+)\]\((?!https?:)([^)#\s]+)(#[^)]*)?\)/g)) {
    const target = path.resolve(dir, m[2]);
    if (!existsSync(target)) note(rel, `link [${m[1]}] → ${m[2]} does not exist`);
  }

  // backticked repo paths (a brace list or a glob is prose shorthand, not a path)
  for (const m of text.matchAll(/`((?:docs|deploy|scripts|apps|packages|services|jobs|tests)[\w.\/-]*)`/g)) {
    const candidate = m[1].replace(/[.,;:)]+$/, '');
    if (!candidate.includes('/')) continue;
    if (/[{*[]/.test(candidate)) continue;
    if (existsSync(path.join(root, candidate))) continue;
    if (candidate.endsWith('/') || existsSync(path.join(root, candidate, 'package.json'))) continue;
    if (/[\w-]+\/[\w.-]+$/.test(candidate) && existsSync(path.join(root, candidate))) continue;
    note(rel, "referenced path `" + candidate + "` does not exist");
  }

  // npm scripts
  for (const m of text.matchAll(/npm run ([a-zA-Z0-9:_-]+)(\s+-w\s+(@?[\w/-]+))?/g)) {
    const [, script, , workspace] = m;
    if (workspace) {
      const list = workspaceScripts.get(workspace);
      if (!list) note(rel, `workspace "${workspace}" not found while checking \`npm run ${script}\``);
      else if (!list.includes(script)) note(rel, `\`npm run ${script} -w ${workspace}\` is not a script of that package`);
      continue;
    }
    if (!(script in (rootPkg.scripts ?? {})) && !workspaceScripts.has(script)) {
      note(rel, `\`npm run ${script}\` is not a script in the root package.json`);
    }
  }

  // env-var lookalikes
  for (const m of text.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)) {
    const token = m[1];
    if (knownEnv.has(token)) continue;
    if (ENV_PREFIXES.some((p) => token.startsWith(p))) note(rel, `mentions \`${token}\` which @d7/config does not define (renamed or removed?)`);
  }
}

/* ------------------------------ 5: migrations ------------------------------ */

const migDir = path.join(root, 'packages', 'database', 'migrations');
const files = readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
let last = 0;
for (const f of files) {
  const m = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(f);
  if (!m) note(f, 'migration filenames must be NNNN_snake_case.sql');
  else {
    const n = Number(m[1]);
    if (n <= last) note(f, `number ${m[1]} is not greater than the previous migration (${last})`);
    last = n;
  }
}
if (files.length !== new Set(files).size) note('migrations', 'duplicate filenames');

/* ------------------------------ 6: handover ------------------------------ */

const env = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-env-docs.mjs')], { cwd: root, stdio: 'inherit' });
if (env.status !== 0) problems.push('(env): scripts/check-env-docs.mjs failed (see its output above)');

if (problems.length) {
  console.error(`\ndocs check FAILED (${problems.length}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`docs check OK — ${DOC_FILES.length} documents, ${files.length} migrations, ${knownEnv.size} env vars cross-checked`);
