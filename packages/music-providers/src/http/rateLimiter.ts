/**
 * Token-bucket limiter + retry with full jitter.
 *
 * Providers that return 429/5xx are retried with exponential backoff and a
 * `Retry-After` override. The limiter tracks aggregate wait time so a sync run
 * can report "rate limit wait" in admin telemetry.
 */
export interface RateLimiterOptions {
  /** Requests per second. */
  rps: number;
  burst?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class TokenBucketLimiter {
  private tokens: number;
  private last: number;
  waitedMs = 0;
  private readonly burst: number;

  constructor(private readonly opts: RateLimiterOptions) {
    this.burst = opts.burst ?? Math.max(1, Math.ceil(opts.rps));
    this.tokens = this.burst;
    this.last = (opts.now ?? Date.now)();
  }

  private refill() {
    const now = (this.opts.now ?? Date.now)();
    const elapsed = Math.max(0, now - this.last);
    this.last = now;
    this.tokens = Math.min(this.burst, this.tokens + (elapsed / 1000) * this.opts.rps);
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const need = ((1 - this.tokens) / this.opts.rps) * 1000;
    this.waitedMs += need;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    await sleep(Math.ceil(need));
    this.refill();
    this.tokens = Math.max(0, this.tokens - 1);
  }

  /** Used by the sync runner to pause between provider "pages". */
  async pause(ms: number) {
    const sleep = this.opts.sleep ?? ((v: number) => new Promise<void>((r) => setTimeout(r, v)));
    this.waitedMs += ms;
    await sleep(ms);
  }
}

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

export function isRetryableStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function backoffDelay(attempt: number, baseMs = 250, maxMs = 30_000) {
  const cap = Math.min(maxMs, baseMs * 2 ** attempt);
  // Full jitter: avoids thundering-herd retries across workers.
  return Math.round(Math.random() * cap);
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastErr: unknown;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt += 1) {
    if (opts.signal?.aborted) throw new Error('aborted');
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const retryable =
        (err as { retryable?: boolean }).retryable === true ||
        (err as { status?: number }).status !== undefined
          ? isRetryableStatus((err as { status: number }).status)
          : /network|timeout|ECONN|socket|fetch failed|Temporarily/i.test(String((err as Error)?.message));
      if (attempt >= opts.maxRetries || !retryable) throw err;
      const retryAfterHeader = (err as { retryAfterMs?: number })?.retryAfterMs;
      const delay = retryAfterHeader && retryAfterHeader > 0 ? Math.min(retryAfterHeader, 60_000) : backoffDelay(attempt, opts.baseDelayMs, opts.maxDelayMs);
      opts.onRetry?.(attempt + 1, err, delay);
      await sleep(delay);
    }
  }
  throw lastErr;
}
