/**
 * One-shot sync run — `npm run sync:releases`.
 * Same code path the scheduler uses, so a manual run and a scheduled run are identical.
 */
import { parseArgs } from 'node:util';
import { env } from '@d7/config';
import { createDb, closeDb, applyMigrations, getDb } from '@d7/database';
import { buildProviders } from '@d7/music-providers';
import { getCache } from '@d7/cache';
import { ReleaseSyncService } from '@d7/service-release-sync';
import { makeLocalCatalogSource } from '@d7/service-release-sync';

const { values } = parseArgs({
  options: {
    provider: { type: 'string' },
    days: { type: 'string' },
    max: { type: 'string' },
    'index-only': { type: 'boolean', default: false },
    'no-migrate': { type: 'boolean', default: false },
  },
});

async function main() {
  const db = values['no-migrate'] ? await getDb() : await createDb();
  if (!values['no-migrate']) await applyMigrations(db);
  const cache = await getCache();
  const providers = buildProviders({ localCatalog: makeLocalCatalogSource(db) });
  for (const line of providers.summary) process.stdout.write(`· ${line}\n`);
  const service = new ReleaseSyncService({
    db,
    providers,
    cache,
    log: (level, msg, meta) => process.stdout.write(`${level}: ${msg}${meta ? ` ${JSON.stringify(meta)}` : ''}\n`),
  });
  const result = await service.runOnce({
    provider: values.provider,
    lookbackDays: values.days ? Number(values.days) : undefined,
    maxAlbums: values.max ? Number(values.max) : undefined,
    indexOnly: values['index-only'],
    triggeredBy: 'cli',
  });
  process.stdout.write(
    `\nsync run ${result.id}\n` +
      `  provider : ${result.provider}\n` +
      `  status   : ${result.status}\n` +
      `  fetched  : albums=${result.fetchedAlbums} tracks=${result.fetchedTracks}\n` +
      `  imported : albums=+${result.insertedAlbums}/~${result.updatedAlbums} tracks=+${result.insertedTracks}/~${result.updatedTracks}\n` +
      `  deduped  : ${result.skippedDuplicates} skipped, ${result.rejectedInvalid} rejected\n` +
      `  pages    : ${result.extra.pages}, rate-limit wait ${result.extra.rateLimitWaitMs}ms, notifications ${result.extra.notificationsSent}\n` +
      `  duration : ${result.durationMs ?? 0}ms\n`,
  );
  if (result.errors.length) {
    process.stdout.write(`  errors   :\n${result.errors.map((e) => `    - [${e.stage}] ${e.message}`).join('\n')}\n`);
  }
  await closeDb();
  setTimeout(() => process.exit(result.status === 'failed' ? 1 : 0), 120);
}

main().catch((err) => {
  process.stderr.write(`release-sync job failed: ${(err as Error).message}\n`);
  process.exit(1);
});
