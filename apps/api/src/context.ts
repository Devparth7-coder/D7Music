/**
 * API composition root. Everything the routes need is created once here and hung off
 * `server.d7`, so tests can build the same object graph against an ephemeral database.
 */
import { env } from '@d7/config';
import {
  applyMigrations,
  createDb,
  closeDb,
  type Db,
} from '@d7/database';
import { buildProviders, type BuiltProviders } from '@d7/music-providers';
import { createAudioStorage, type AudioStorageProvider } from '@d7/audio-storage';
import { getCache, type Cache } from '@d7/cache';
import { ReleaseSyncService, createJobQueue, makeLocalCatalogSource, type JobQueue } from '@d7/service-release-sync';
import { LinearScoringProvider, type RecommendationProvider } from '@d7/service-recommendations';
import { PostgresSearchBackend } from '@d7/service-search';
import { NotificationService } from '@d7/service-notifications';
import { AiMusicAssistant } from '@d7/service-ai-assistant';

export interface AppLog {
  debug: (msg: string, meta?: Record<string, unknown>) => void;
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
  level: string;
}

export interface AppContext {
  db: Db;
  cache: Cache;
  storage: AudioStorageProvider;
  providers: BuiltProviders;
  search: PostgresSearchBackend & { clicked(input: { query: string; entityType: string; entityId: string }): Promise<void> };
  recommendations: RecommendationProvider & {
    computeAndPersist(db: Db, opts?: { userIds?: string[]; limit?: number; algorithm?: string }): Promise<{ computed: number; skipped: number; errors: number; durationMs: number; users: number }>;
    signals(db: Db, userId: string): Promise<import('@d7/types').RecommendationSignals>;
  };
  assistant: AiMusicAssistant;
  notifications: NotificationService;
  releaseSync: ReleaseSyncService;
  queue: JobQueue;
  log: AppLog;
  startedAt: string;
  /** Increments whenever the catalog changes; part of every cached home/search key. */
  catalogVersion: () => Promise<number>;
  close: () => Promise<void>;
}

function makeLogger(level: string): AppLog {
  const threshold: Record<string, number> = { silent: 100, fatal: 90, error: 80, warn: 60, info: 40, debug: 20, trace: 10 };
  const active = threshold[level] ?? 40;
  const emit = (name: 'debug' | 'info' | 'warn' | 'error', min: number) => (msg: string, meta?: Record<string, unknown>) => {
    if (active > min) return;
    const line = `${new Date().toISOString()} ${name.toUpperCase().padEnd(5)} ${msg}${meta && Object.keys(meta).length ? ` ${safe(meta)}` : ''}`;
    if (name === 'error') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };
  return {
    debug: emit('debug', 20),
    info: emit('info', 40),
    warn: emit('warn', 60),
    error: emit('error', 80),
    level,
  };
}

function safe(meta: Record<string, unknown>) {
  try {
    return JSON.stringify(meta);
  } catch {
    return '[unserializable meta]';
  }
}

export interface CreateContextOptions {
  db?: Db;
  logLevel?: string;
  /** Skip scheduler/queue timers (tests). */
  headless?: boolean;
  /** Test paths that already migrated the schema can skip the migration pass. */
  skipMigrations?: boolean;
}

export async function createContext(opts: CreateContextOptions = {}): Promise<AppContext> {
  const log = makeLogger(opts.logLevel ?? env.LOG_LEVEL);
  const db = opts.db ?? (await createDb());
  // Tests inject an already-migrated database; a serverless deployment turns boot-time migration
  // off so concurrent cold starts never race the ledger (see docs/DEPLOY-VERCEL.md).
  if (!opts.skipMigrations && env.API_MIGRATE_AT_BOOT) await applyMigrations(db);

  const cache = await getCache();
  const storage = createAudioStorage();
  const localCatalog = makeLocalCatalogSource(db);
  const providers = buildProviders({ localCatalog });
  for (const line of providers.summary) log.info(`provider: ${line}`);
  if (env.MUSIC_PROVIDER === 'none' || providers.audio.name === 'none') {
    log.warn('no external audio provider configured; only platform-owned uploads will be streamable');
  }

  const notifications = new NotificationService({
    db,
    log: (level, msg, meta) => log[level](msg, meta),
  });

  const releaseSync = new ReleaseSyncService({
    db,
    providers,
    cache,
    notifier: notifications,
    log: (level, msg, meta) => log[level](msg, meta),
    onCatalogChanged: async (info) => {
      try {
        const engine = new LinearScoringProvider();
        await engine.computeAndPersist(db, { limit: 40 });
        log.info('recommendations refreshed after catalog change', {
          newTracks: info.newTrackIds.length,
          newAlbums: info.newAlbumIds.length,
        });
      } catch (err) {
        log.warn('recommendation refresh failed', { message: (err as Error).message });
      }
      await refreshRelated(db);
    },
  });

  const queue = await createJobQueue({ db, namespace: env.QUEUE_NAMESPACE, redisUrl: env.REDIS_URL || undefined });
  queue.register(async (job) => {
    if (job.kind === 'album_import') {
      const providerAlbumId = String(job.payload.providerAlbumId ?? '');
      if (!providerAlbumId) throw new Error('album_import requires providerAlbumId');
      await releaseSync.importByProviderAlbumId(String(job.payload.provider ?? providers.audio.name), providerAlbumId);
    } else if (job.kind === 'index_refresh') {
      await releaseSync.runOnce({ indexOnly: true, triggeredBy: 'cli' });
    } else {
      throw new Error(`unknown job kind ${job.kind}`);
    }
  });

  if (!opts.headless) {
    releaseSync.start();
    queue.start(15_000);
    log.info('release sync armed', {
      intervalMin: env.RELEASE_SYNC_INTERVAL_MIN,
      enabled: env.RELEASE_SYNC_ENABLED,
      queue: queue.driver,
      cache: cache.driver,
      storage: storage.name,
      db: db.logLabel,
    });
  }

  const recommendations = new LinearScoringProvider() as AppContext['recommendations'];
  const assistant = new AiMusicAssistant({
    db,
    log: (level, msg, meta) => log[level](msg, meta),
  });

  const search = new PostgresSearchBackend(db) as AppContext['search'];

  return {
    db,
    cache,
    storage,
    providers,
    search,
    recommendations,
    assistant,
    notifications,
    releaseSync,
    queue,
    log,
    startedAt: new Date().toISOString(),
    catalogVersion: async () => Number((await cache.get<number>('catalog_version')) ?? 0),
    close: async () => {
      await releaseSync.stop();
      await queue.close();
      if (!opts.db) await closeDb();
      else await db.close();
    },
  };
}

async function refreshRelated(db: Db) {
  const { refreshRelatedArtists } = await import('@d7/service-recommendations');
  await refreshRelatedArtists(db).catch(() => undefined);
}
