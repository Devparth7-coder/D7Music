/**
 * Standalone worker process: consumes the release-sync queue and runs the scheduler.
 * Split from the API so a slow provider can never block a user request.
 *   npm run worker
 */
import { env } from '@d7/config';
import { createDb, applyMigrations, closeDb } from '@d7/database';
import { buildProviders, type LocalCatalogSource } from '@d7/music-providers';
import { getCache } from '@d7/cache';
import { createJobQueue } from './queue.js';
import { ReleaseSyncService } from './index.js';
import { makeLocalCatalogSource } from './local-catalog-source.js';

function log(level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} release-sync ${msg}${meta ? ` ${JSON.stringify(meta)}` : ''}`;
  process.stdout.write(`${line}\n`);
}

async function main() {
  const db = await createDb();
  await applyMigrations(db);
  const cache = await getCache();
  const localCatalog: LocalCatalogSource = makeLocalCatalogSource(db);
  const providers = buildProviders({ localCatalog });
  for (const line of providers.summary) log('info', line);

  const service = new ReleaseSyncService({ db, providers, cache, log });
  const queue = await createJobQueue({ db, namespace: env.QUEUE_NAMESPACE, redisUrl: env.REDIS_URL || undefined });
  log('info', `queue driver: ${queue.driver}`);

  queue.register(async (job) => {
    if (job.kind === 'album_import') {
      const provider = String(job.payload.provider ?? providers.audio.name);
      const providerAlbumId = String(job.payload.providerAlbumId ?? '');
      if (!providerAlbumId) throw new Error('album_import requires providerAlbumId');
      const res = await service.importByProviderAlbumId(provider, providerAlbumId);
      if (!res.found) log('warn', 'album not found on provider', { providerAlbumId });
      return;
    }
    if (job.kind === 'index_refresh') {
      await service.runOnce({ indexOnly: true, triggeredBy: 'cli' });
      return;
    }
    throw new Error(`unknown job kind: ${job.kind}`);
  });
  queue.start(10_000);
  service.start();

  const shutdown = async (signal: string) => {
    log('info', `received ${signal}, shutting down`);
    await service.stop();
    await queue.close();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  process.stderr.write(`worker failed: ${(err as Error).message}\n`);
  process.exitCode = 1;
});
