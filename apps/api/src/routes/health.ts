/**
 * Health, version and the public client configuration.
 *
 * `/api/health` is what the Docker/compose healthcheck and the web app's status page read.
 * It reports *capability* rather than just "ok": whether audio can be streamed, whether an LLM
 * is wired, whether sync is armed. That is the information the UI needs to avoid promising a
 * feature the deployment cannot deliver.
 */
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { MOODS, env, planFor } from '@d7/config';
import { listRecentRuns } from '@d7/database';

/**
 * Version for /api/version and the deploy checklist. Four levels up from src/routes is the repo
 * root (the workspace root package.json holds the release version); the apps/api manifest is the
 * fallback for a layout where only the app was copied into the image.
 */
export function packageVersion(): string {
  for (const rel of ['../../../../package.json', '../../../package.json']) {
    try {
      const parsed = JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')) as { version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version) return parsed.version;
    } catch {
      /* try the next candidate */
    }
  }
  return '0.0.0';
}

export default async function healthRoutes(app: FastifyInstance) {
  app.get('/api/health', async (request, reply) => {
    const started = Date.now();
    let dbOk = false;
    let catalog = { tracks: 0, albums: 0, artists: 0 };
    try {
      await app.d7.db.queryOne<{ ok: number }>(`SELECT 1 AS ok`);
      dbOk = true;
      const row = await app.d7.db.queryOne<Record<string, number>>(
        `SELECT (SELECT count(*) FROM tracks WHERE status='published')::int AS tracks,
                (SELECT count(*) FROM albums WHERE status='published')::int AS albums,
                (SELECT count(*) FROM artists)::int AS artists`,
      );
      catalog = { tracks: Number(row?.tracks ?? 0), albums: Number(row?.albums ?? 0), artists: Number(row?.artists ?? 0) };
    } catch (err) {
      app.d7.log.error('health check: database unreachable', { message: (err as Error).message });
    }
    let storageOk = true;
    try {
      await app.d7.storage.exists('__health_probe__');
    } catch {
      storageOk = false;
    }
    const sync = await listRecentRuns(app.d7.db, undefined, 1).catch(() => []);
    const healthy = dbOk && storageOk;
    reply.code(healthy ? 200 : 503);
    return {
      status: healthy ? 'ok' : 'degraded',
      uptimeSec: Math.round((Date.now() - new Date(app.d7.startedAt).getTime()) / 1000),
      tookMs: Date.now() - started,
      checks: {
        database: { ok: dbOk, driver: app.d7.db.driver, label: app.d7.db.logLabel, ...catalog },
        cache: { ok: true, driver: app.d7.cache.driver },
        storage: { ok: storageOk, driver: app.d7.storage.name },
        audioProvider: { name: app.d7.providers.audio.name, configured: app.d7.providers.audio.name !== 'none' && app.d7.providers.audio.name !== 'local_library' },
        metadataProviders: app.d7.providers.descriptors
          .filter((d) => d.kind === 'metadata')
          .map((d) => ({ name: d.name, enabled: d.enabled, configured: d.configured, reasons: d.reasons })),
        queue: { driver: app.d7.queue.driver },
        releaseSync: { enabled: env.RELEASE_SYNC_ENABLED, everyMinutes: env.RELEASE_SYNC_INTERVAL_MIN, lastRun: sync[0] ?? null },
        assistant: { engine: env.LLM_BASE_URL && env.LLM_API_KEY ? 'llm+rules' : 'rules', model: env.LLM_BASE_URL && env.LLM_API_KEY ? env.LLM_MODEL : null },
        payments: env.PAYMENT_PROVIDER,
      },
    };
  });

  app.get('/api/version', async () => ({
    name: 'd7music-api',
    version: packageVersion(),
    node: process.version,
    env: env.NODE_ENV,
    startedAt: app.d7.startedAt,
  }));

  /** Everything the browser needs to configure itself — no secrets, no internal URLs. */
  app.get('/api/config', async () => ({
    appName: 'D7music',
    apiBaseUrl: env.API_PUBLIC_URL,
    webOrigin: env.WEB_ORIGIN,
    plans: [planFor('free'), planFor('premium')],
    moods: Object.keys(MOODS),
    features: {
      assistant: true,
      assistantLlm: Boolean(env.LLM_BASE_URL && env.LLM_API_KEY),
      offlineDownloads: true,
      oauth: env.OAUTH_PROVIDERS.filter((p) => ['google', 'github', 'oidc'].includes(p)),
      uploads: true,
      payments: env.PAYMENT_PROVIDER,
      unlicensedStreaming: env.ALLOW_UNLICENSED_STREAM,
      searchSuggestions: true,
    },
    providers: app.d7.providers.summary,
    providerDescriptors: app.d7.providers.descriptors.map((d) => ({ name: d.name, kind: d.kind, enabled: d.enabled, configured: d.configured, supportsNewReleases: d.supportsNewReleases })),
    limits: {
      streamUrlTtlSec: env.STREAM_URL_TTL_SEC,
      uploadMaxMb: env.UPLOAD_MAX_MB,
      assistantDailyFree: env.ASSISTANT_DAILY_LIMIT_FREE,
      assistantDailyPremium: env.ASSISTANT_DAILY_LIMIT_PREMIUM,
      rateLimits: { search: env.RATE_LIMIT_SEARCH, write: env.RATE_LIMIT_WRITE, playback: env.RATE_LIMIT_PLAYBACK, auth: env.RATE_LIMIT_AUTH },
    },
    catalog: { audioProvider: app.d7.providers.audio.name, storage: app.d7.storage.name },
  }));
}
