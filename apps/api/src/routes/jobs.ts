/**
 * Scheduled-job entry point (Vercel Cron / any external scheduler).
 *
 * The worker in `services/release-sync/src/worker.ts` does the same work, but a serverless
 * deployment has nowhere to keep a process alive, so the *scheduler* becomes the caller instead:
 * Vercel Cron issues a `GET` to `/api/jobs/<name>` with `Authorization: Bearer $CRON_SECRET`.
 *
 * Three rules keep this from being a gun pointed at the database:
 *   - it is secret-gated and fails closed (`501` when `CRON_SECRET` is unset, never "open");
 *   - every job runs inside `cache.withLock` (and `release-sync` shares the worker's lock name), so a
 *     retry or an overlapping schedule answers
 *     `{"skipped":"locked"}` instead of starting a second run — atomic within a process on any cache
 *     driver, and across processes when `REDIS_URL` makes the lock a Redis `SET NX`;
 *   - it runs the *same* service methods as the worker and the CLI, so a scheduled run, a manual
 *     `npm run sync:releases` and an admin button cannot drift apart.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { env } from '@d7/config';
import { rebuildSearchIndex } from '@d7/database';
import { ApiError, envelopeFor, intField } from '../lib/http.js';

export const JOB_NAMES = ['release-sync', 'recommendations', 'reindex', 'trending', 'queue-drain'] as const;
export type JobName = (typeof JOB_NAMES)[number];

/** `Bearer <token>` comparison that never leaks the secret through timing, and rejects anything else. */
export function cronTokenMatches(header: string | undefined, secret: string): boolean {
  const value = (header ?? '').trim();
  const prefix = 'Bearer ';
  if (!value.startsWith(prefix)) return false;
  const got = Buffer.from(value.slice(prefix.length).trim());
  const want = Buffer.from(secret);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Which lock a job holds. `release-sync` must be the *scheduler's own* name
 * (`services/release-sync/src/index.ts` takes `withLock('release-sync', …)`) or a cron run and a
 * worker tick would happily import the same page twice; the rest are reachable only from here.
 */
export function lockNameFor(job: JobName): string {
  return job === 'release-sync' ? job : `job:${job}`;
}

function isJobName(raw: string): raw is JobName {
  return (JOB_NAMES as readonly string[]).includes(raw);
}

/** Per-job ceilings, so a cron URL cannot ask for an unbounded run. */
const LOCK_TTL_MS: Record<JobName, number> = {
  'release-sync': 20 * 60_000,
  recommendations: 10 * 60_000,
  reindex: 15 * 60_000,
  trending: 5 * 60_000,
  'queue-drain': 4 * 60_000,
};

export default async function jobRoutes(app: FastifyInstance) {
  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('cache-control', 'no-store');
    if (!env.CRON_SECRET) {
      // Returned rather than thrown: an unconfigured scheduler is a normal state, not a fault, and
      // routing it through the error handler would log a 501 at ERROR on every cron attempt.
      return reply
        .code(501)
        .send(
          envelopeFor(
            new ApiError(501, 'CRON_NOT_CONFIGURED', 'Set CRON_SECRET to allow scheduled job runs; this endpoint is closed until it is set.'),
            request.id,
          ),
        );
    }
    if (!cronTokenMatches(request.headers.authorization, env.CRON_SECRET)) {
      throw ApiError.unauthorized('This endpoint requires the scheduler token in an Authorization: Bearer header.');
    }
    const job = String((request.params as { job: string }).job ?? '');
    if (!isJobName(job)) {
      throw new ApiError(404, 'UNKNOWN_JOB', `No job named "${job}". Available: ${JOB_NAMES.join(', ')}.`);
    }
    const query = request.query as Record<string, string | undefined>;
    const started = Date.now();

    const outcome = await app.d7.cache.withLock(lockNameFor(job), LOCK_TTL_MS[job], async () => {
      switch (job) {
        case 'release-sync': {
          const result = await app.d7.releaseSync.runOnce({
            lookbackDays: intField(query.lookbackDays, env.RELEASE_SYNC_LOOKBACK_DAYS, 1, 3650),
            maxAlbums: intField(query.maxAlbums, env.RELEASE_SYNC_MAX_ALBUMS_PER_RUN, 1, 500),
            indexOnly: query.indexOnly === 'true',
            triggeredBy: 'schedule',
          });
          return {
            status: result.status,
            fetchedAlbums: result.fetchedAlbums,
            insertedAlbums: result.insertedAlbums,
            insertedTracks: result.insertedTracks,
            skippedDuplicates: result.skippedDuplicates,
            rejectedInvalid: result.rejectedInvalid,
            errors: result.errors.slice(0, 5),
          };
        }
        case 'recommendations': {
          const stats = await app.d7.recommendations.computeAndPersist(app.d7.db, {
            limit: intField(query.limit, 60, 1, 500),
          });
          return stats;
        }
        case 'reindex': {
          const rebuilt = await rebuildSearchIndex(app.d7.db);
          const catalogVersion = await app.d7.cache.incr('catalog_version');
          return { ...rebuilt, catalogVersion };
        }
        case 'trending': {
          const limit = intField(query.limit, 25, 5, 100);
          await app.d7.releaseSync.refreshTrending(limit);
          return { refreshed: limit };
        }
        case 'queue-drain': {
          const processed = await app.d7.queue.drain(intField(query.limit, 10, 1, 50));
          return { processed };
        }
      }
    });

    if (!outcome.ok) {
      reply.code(200);
      return { job, skipped: 'locked', note: 'Another run holds the lock; nothing was duplicated.' };
    }
    return { job, ok: true, tookMs: Date.now() - started, result: outcome.value };
  };

  // Vercel Cron issues GETs only; POST is here for manual triggers and CI.
  app.get('/api/jobs/:job', handler);
  app.post('/api/jobs/:job', handler);
}
