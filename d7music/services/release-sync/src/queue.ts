/**
 * Queue adapter — BullMQ when Redis is configured, Postgres-backed otherwise.
 *
 * The Postgres path is not a toy: jobs are claimed with `FOR UPDATE SKIP LOCKED`,
 * carry attempt counts and exponential backoff, and land in a `dead` state that the
 * admin dashboard shows. Swapping in BullMQ is a config change (REDIS_URL), not a
 * code change, which is the point of the abstraction.
 */
import type { Db } from '@d7/database';
import { claimSyncJobs, completeSyncJob, enqueueSyncJob } from '@d7/database';

export interface JobPayload {
  provider: string;
  kind: string;
  payload: Record<string, unknown>;
}

export interface JobHandler {
  (job: JobPayload): Promise<void>;
}

export interface JobQueue {
  readonly driver: 'bullmq' | 'postgres';
  add(kind: string, payload: Record<string, unknown>, opts?: { provider?: string; runAfterSec?: number; maxAttempts?: number }): Promise<void>;
  /**
   * Returns the number of jobs processed in this tick. `handler` overrides the registered one; omit
   * it to use whatever `register()` installed (that is what the scheduler and `/api/jobs` do).
   */
  drain(limit: number, handler?: JobHandler): Promise<number>;
  register(handler: JobHandler): void;
  start(intervalMs?: number): void;
  stop(): Promise<void>;
  stats(): Promise<{ queued: number; failed: number; dead: number; running: number }>;
  close(): Promise<void>;
}

export interface CreateQueueOptions {
  db: Db;
  namespace: string;
  redisUrl?: string;
}

class PostgresQueue implements JobQueue {
  readonly driver = 'postgres' as const;
  private timer: NodeJS.Timeout | null = null;
  private handler: JobHandler | null = null;

  constructor(private readonly db: Db) {}

  async add(kind: string, payload: Record<string, unknown>, opts: { provider?: string; runAfterSec?: number; maxAttempts?: number } = {}) {
    await enqueueSyncJob(this.db, {
      provider: opts.provider ?? 'local_library',
      kind,
      payload,
      runAfter: opts.runAfterSec ? new Date(Date.now() + opts.runAfterSec * 1000).toISOString() : undefined,
      maxAttempts: opts.maxAttempts,
    });
  }

  async drain(limit: number, handler?: JobHandler) {
    const h = handler ?? this.handler;
    if (!h) throw new Error('no job handler registered');
    const jobs = await claimSyncJobs(this.db, limit);
    let done = 0;
    for (const job of jobs) {
      try {
        await h({ provider: job.provider, kind: job.kind, payload: job.payload ?? {} });
        await completeSyncJob(this.db, Number(job.id), { ok: true });
        done += 1;
      } catch (err) {
        const attempts = Number(job.attempts ?? 1);
        await completeSyncJob(this.db, Number(job.id), {
          ok: false,
          error: (err as Error).message,
          retryInSec: Math.min(3600, 30 * 2 ** attempts),
        });
      }
    }
    return done;
  }

  register(handler: JobHandler) {
    this.handler = handler;
  }

  start(intervalMs = 15_000) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.handler) return;
      void this.drain(5).catch(() => undefined);
    }, intervalMs);
    this.timer.unref?.();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async stats() {
    const row = await this.db.queryOne<Record<string, number>>(
      `SELECT count(*) FILTER (WHERE status='queued')::int AS queued,
              count(*) FILTER (WHERE status='failed')::int AS failed,
              count(*) FILTER (WHERE status='dead')::int AS dead,
              count(*) FILTER (WHERE status='running')::int AS running
         FROM sync_jobs`,
    );
    return {
      queued: Number(row?.queued ?? 0),
      failed: Number(row?.failed ?? 0),
      dead: Number(row?.dead ?? 0),
      running: Number(row?.running ?? 0),
    };
  }

  async close() {
    await this.stop();
  }
}

/** BullMQ-backed queue (only constructed when REDIS_URL is present). */
class BullQueue implements JobQueue {
  readonly driver = 'bullmq' as const;
  private queue: import('bullmq').Queue | null = null;
  private worker: import('bullmq').Worker | null = null;
  private handler: JobHandler | null = null;

  constructor(private readonly opts: { redisUrl: string; namespace: string }) {}

  private async ensureQueue() {
    if (this.queue) return this.queue;
    const { Queue } = await import('bullmq');
    this.queue = new Queue(`${this.opts.namespace}:release-sync`, {
      connection: { url: this.opts.redisUrl, maxRetriesPerRequest: null as unknown as number },
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: { age: 3600 * 24, count: 1000 },
        removeOnFail: { age: 3600 * 24 * 7 },
      },
    });
    return this.queue;
  }

  async add(kind: string, payload: Record<string, unknown>, opts: { provider?: string; runAfterSec?: number; maxAttempts?: number } = {}) {
    const q = await this.ensureQueue();
    await q.add(kind, { provider: opts.provider ?? 'local_library', kind, payload }, {
      delay: opts.runAfterSec ? opts.runAfterSec * 1000 : undefined,
      attempts: opts.maxAttempts,
      // Dedupe key makes enqueuing the same album import twice a no-op.
      deduplication: { id: `${kind}:${opts.provider ?? ''}:${JSON.stringify(payload)}`, ttl: 3_600_000 },
    });
  }

  register(handler: JobHandler) {
    this.handler = handler;
  }

  start() {
    if (this.worker) return;
    void (async () => {
      const { Worker } = await import('bullmq');
      this.worker = new Worker(
        `${this.opts.namespace}:release-sync`,
        async (job) => {
          if (!this.handler) throw new Error('no handler registered');
          await this.handler(job.data as JobPayload);
        },
        { connection: { url: this.opts.redisUrl, maxRetriesPerRequest: null as unknown as number }, concurrency: 2 },
      );
    })();
  }

  async drain(limit: number, handler?: JobHandler) {
    // BullMQ pulls itself; drain() exists so callers can use one code path.
    const h = handler ?? this.handler;
    if (!h) return 0;
    const q = await this.ensureQueue();
    const counts = await q.getJobCounts('waiting', 'delayed', 'active');
    let processed = 0;
    const waiting = (counts.waiting ?? 0) + (counts.delayed ?? 0);
    if (waiting === 0) return 0;
    // Manual drain is intentionally a no-op here: the worker owns execution.
    void limit;
    return processed;
  }

  async stop() {
    await this.worker?.close().catch(() => undefined);
    this.worker = null;
  }

  async stats() {
    const q = await this.ensureQueue();
    const c = await q.getJobCounts('wait', 'failed', 'delayed', 'active');
    return {
      queued: Number(c.wait ?? 0) + Number(c.delayed ?? 0),
      failed: Number(c.failed ?? 0),
      dead: 0,
      running: Number(c.active ?? 0),
    };
  }

  async close() {
    await this.stop();
    await this.queue?.close().catch(() => undefined);
    this.queue = null;
  }
}

export async function createJobQueue(opts: CreateQueueOptions): Promise<JobQueue> {
  if (opts.redisUrl) {
    try {
      return new BullQueue({ redisUrl: opts.redisUrl, namespace: opts.namespace });
    } catch (err) {
      process.emitWarning(`BullMQ unavailable (${(err as Error).message}); using the Postgres-backed queue`, 'D7music');
    }
  }
  return new PostgresQueue(opts.db);
}

export { PostgresQueue };
