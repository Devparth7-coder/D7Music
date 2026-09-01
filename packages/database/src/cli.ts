#!/usr/bin/env node
/**
 * db CLI: migrate | seed | reset | audio | status
 * Runs against DB_DRIVER from env; falls back to the embedded Postgres driver when no
 * DATABASE_URL is configured, so `npm run db:migrate && npm run db:seed` works on a
 * clean machine with no services running.
 */
import { rm } from 'node:fs/promises';
import { env, resolveDataPath } from '@d7/config';

const args = process.argv.slice(2);
const cmd = args[0] ?? 'status';
const flag = (name: string, def?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? '') : def;
};

function log(msg: string) {
  process.stdout.write(`${msg}\n`);
}

async function main() {
  const { createDb, closeDb } = await import('./client.js');
  const db = await createDb();
  log(`db: ${db.logLabel}`);

  if (cmd === 'migrate') {
    const { applyMigrations } = await import('./migrate.js');
    const res = await applyMigrations(db, (m) => log(`  ${m}`));
    log(`migrations applied=${res.applied.length} skipped=${res.skipped}`);
    const ext = res.optionalExtensions.filter((e) => e.ok).map((e) => e.name);
    const missing = res.optionalExtensions.filter((e) => !e.ok).map((e) => e.name);
    if (ext.length) log(`optional extensions enabled: ${ext.join(', ')}`);
    if (missing.length) log(`optional extensions unavailable (app runs without them): ${missing.join(', ')}`);
  } else if (cmd === 'status') {
    const { migrationStatus } = await import('./migrate.js');
    const rows = await migrationStatus(db);
    for (const r of rows) log(`${r.appliedAt ? '[x]' : '[ ]'} ${r.name}${r.appliedAt ? ` (${r.appliedAt})` : ''}`);
  } else if (cmd === 'seed') {
    const { applyMigrations } = await import('./migrate.js');
    await applyMigrations(db);
    const { seedCatalog } = await import('./seed.js');
    const withAudio = flag('audio', 'true') !== 'false';
    const t0 = Date.now();
    const res = await seedCatalog(db, { withAudio });
    log(
      `seeded in ${((Date.now() - t0) / 1000).toFixed(1)}s — artists=${res.artists} albums=${res.albums} tracks=${res.tracks} ` +
        `audio=${res.audioObjects} lyrics=${res.lyrics} playlists=${res.playlists} events=${res.events} docs=${res.searchDocuments}`,
    );
    log(`logins: admin@${'d7music.test'} / ${env.SEED_ADMIN_PASSWORD} · demo@d7music.test / ${env.SEED_DEMO_PASSWORD}`);
  } else if (cmd === 'audio') {
    // Re-generate the sample audio objects without touching rows.
    const { LocalStorageProvider, synthesizeTrack } = await import('@d7/audio-storage');
    const storage = new LocalStorageProvider(resolveDataPath(env.STORAGE_LOCAL_DIR), { secret: env.APP_SECRET, publicBase: env.API_PUBLIC_URL });
    const rows = await db.query<{ storage_key: string; title: string }>(`SELECT storage_key, title FROM tracks WHERE storage_key IS NOT NULL`);
    let n = 0;
    for (const r of rows) {
      if (await storage.exists(r.storage_key)) continue;
      const wav = synthesizeTrack({ seed: r.title, genre: 'lofi', seconds: 10, sampleRate: 22050 });
      await storage.upload({ key: r.storage_key, body: wav, contentType: 'audio/wav' });
      n += 1;
    }
    log(`regenerated ${n} missing audio object(s) under ${env.STORAGE_LOCAL_DIR}`);
  } else if (cmd === 'reset') {
    if (env.DB_DRIVER !== 'pglite') {
      log('refusing to reset a postgres database from the CLI — drop it manually (safer).');
      process.exitCode = 1;
    } else {
      await closeDb();
      await rm(resolveDataPath(env.PGLITE_DIR), { recursive: true, force: true });
      if (flag('storage') === 'true') await rm(resolveDataPath(env.STORAGE_LOCAL_DIR), { recursive: true, force: true });
      log(`removed ${env.PGLITE_DIR}${flag('storage') === 'true' ? ` and ${env.STORAGE_LOCAL_DIR}` : ''}`);
    }
  } else {
    log(`unknown command: ${cmd}\nusage: tsx packages/database/src/cli.ts <migrate|seed|status|audio|reset> [--audio true|false] [--storage true]`);
    process.exitCode = 1;
  }
  await closeDb();
  exitSoon(process.exitCode ? Number(process.exitCode) : 0);
}

/**
 * PGlite runs Postgres on a worker thread; on some platforms it lingers briefly after
 * close() and keeps a one-shot CLI alive. Force the exit once stdout has flushed.
 */
function exitSoon(code = 0) {
  setTimeout(() => process.exit(code), 250).unref?.();
  setImmediate(() => process.nextTick(() => process.exit(code)));
}

main().catch((err) => {
  const message = (err as Error).message ?? String(err);
  // PGlite swallows the real cause when the on-disk cluster cannot be opened. That is
  // almost always a half-restored/corrupt data directory, and it is cheap to recover.
  const hint = message.includes('failed to initialize properly')
    ? `\nhint: the cluster at ${process.env.D7_DB_URL ? 'the configured D7_DB_URL' : env.PGLITE_DIR} could not be opened.\n      Rebuild it with: npm run db:reset && npm run db:seed\n`
    : '';
  process.stderr.write(`db cli failed: ${message}\n${(err as Error).stack?.split('\n').slice(1, 4).join('\n') ?? ''}\n${hint}`);
  exitSoon(1);
});
