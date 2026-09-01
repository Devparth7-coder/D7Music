/**
 * Migration runner.
 *
 * Applies packages/database/migrations/*.sql in filename order, records each applied
 * file with a checksum, and verifies the checksum on re-run so a mutated historical
 * migration is caught instead of silently diverging between environments.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './client.js';

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = resolve(here, '../migrations');

export interface MigrationResult {
  applied: string[];
  skipped: number;
  optionalExtensions: { name: string; ok: boolean; reason?: string }[];
}

async function ensureLedger(db: Db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer
    )`);
}

export function migrationChecksum(sql: string) {
  return createHash('sha256').update(sql).digest('hex').slice(0, 16);
}

export async function listMigrations(dir = MIGRATIONS_DIR) {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  return Promise.all(
    files.map(async (name) => ({ name, path: join(dir, name), sql: await readFile(join(dir, name), 'utf8') })),
  );
}

/**
 * Optional extensions: they improve search quality but the app must run without them
 * (managed Postgres tiers differ). Never fatal.
 */
const OPTIONAL_EXTENSIONS = ['pg_trgm', 'unaccent', 'fuzzystrmatch'];

async function tryExtensions(db: Db) {
  const results: MigrationResult['optionalExtensions'] = [];
  for (const name of OPTIONAL_EXTENSIONS) {
    try {
      await db.execute(`CREATE EXTENSION IF NOT EXISTS ${name}`);
      results.push({ name, ok: true });
    } catch (err) {
      results.push({ name, ok: false, reason: err instanceof Error ? err.message.split('\n')[0] : String(err) });
    }
  }
  return results;
}

export async function applyMigrations(db: Db, log: (msg: string) => void = () => {}): Promise<MigrationResult> {
  await ensureLedger(db);
  const ledger = await db.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations');
  const done = new Map(ledger.map((r) => [r.name, r.checksum]));
  const migrations = await listMigrations();

  const applied: string[] = [];
  let skipped = 0;

  for (const m of migrations) {
    const checksum = migrationChecksum(m.sql);
    const prev = done.get(m.name);
    if (prev) {
      if (prev !== checksum) {
        throw new Error(
          `Migration ${m.name} changed after being applied (ledger ${prev} vs file ${checksum}). ` +
            'Add a new migration instead of editing history.',
        );
      }
      skipped += 1;
      continue;
    }
    const started = Date.now();
    await db.transaction(async (tx) => {
      // One call per file: Postgres accepts a multi-statement script here, which keeps
      // dollar-quoted function bodies intact (a naive `;` split would corrupt them).
      await tx.execute(m.sql);
      await tx.execute('INSERT INTO schema_migrations (name, checksum, duration_ms) VALUES ($1, $2, $3)', [
        m.name,
        checksum,
        Date.now() - started,
      ]);
    });
    applied.push(m.name);
    log(`applied ${m.name} (${Date.now() - started}ms)`);
  }

  const optionalExtensions = await tryExtensions(db);
  if (applied.length) await db.execute('NOTIFY d7music, "schema_changed"').catch(() => {});
  return { applied, skipped, optionalExtensions };
}

export async function migrationStatus(db: Db) {
  await ensureLedger(db);
  const migrations = await listMigrations();
  const ledger = await db.query<{ name: string; applied_at: string }>(
    'SELECT name, applied_at FROM schema_migrations',
  );
  const done = new Map(ledger.map((r) => [r.name, r.applied_at]));
  return migrations.map((m) => ({ name: m.name, appliedAt: done.get(m.name) ?? null }));
}
