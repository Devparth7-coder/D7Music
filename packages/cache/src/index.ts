/**
 * Cache + single-flight lock.
 *
 * Two drivers behind one interface:
 *   - `redis`  (REDIS_URL set): shared cache, cross-process locks, works with N API nodes
 *   - `memory` (default): bounded LRU for one process — same API, honest `driver` label
 *
 * `getOrSet` never caches a rejected promise, and `withLock` (SET NX + compare-and-delete on
 * Redis) is what keeps the release-sync scheduler from running twice across processes.
 */
import { env } from '@d7/config';

export interface Cache {
  readonly driver: 'redis' | 'memory';
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSec?: number): Promise<void>;
  del(...keys: string[]): Promise<void>;
  getOrSet<T>(key: string, ttlSec: number, producer: () => Promise<T>): Promise<T>;
  incr(key: string, ttlSec?: number): Promise<number>;
  withLock<T>(name: string, ttlMs: number, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }>;
  clearNamespace(): Promise<void>;
  close(): Promise<void>;
}

interface Entry {
  value: string;
  expiresAt: number;
  lastUsed: number;
}

class MemoryCache implements Cache {
  readonly driver = 'memory' as const;
  private store = new Map<string, Entry>();
  private hits = 0;
  private misses = 0;

  constructor(private readonly maxEntries = 2000) {}

  private key(k: string) {
    return `${env.QUEUE_NAMESPACE}:${k}`;
  }

  private sweep() {
    const now = Date.now();
    for (const [k, v] of this.store) if (v.expiresAt <= now) this.store.delete(k);
    if (this.store.size > this.maxEntries) {
      const ordered = [...this.store.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      for (const [k] of ordered.slice(0, this.store.size - this.maxEntries)) this.store.delete(k);
    }
  }

  async get<T>(key: string): Promise<T | null> {
    const hit = this.store.get(this.key(key));
    if (!hit || hit.expiresAt <= Date.now()) {
      if (hit) this.store.delete(this.key(key));
      this.misses += 1;
      return null;
    }
    hit.lastUsed = Date.now();
    this.hits += 1;
    try {
      return JSON.parse(hit.value) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSec = 60): Promise<void> {
    this.sweep();
    this.store.set(this.key(key), {
      value: JSON.stringify(value),
      expiresAt: Date.now() + ttlSec * 1000,
      lastUsed: Date.now(),
    });
  }

  async del(...keys: string[]): Promise<void> {
    for (const k of keys) this.store.delete(this.key(k));
  }

  async getOrSet<T>(key: string, ttlSec: number, producer: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;
    const value = await producer();
    if (value !== undefined && value !== null) await this.set(key, value, ttlSec);
    return value;
  }

  async incr(key: string, ttlSec = 3600): Promise<number> {
    const full = this.key(key);
    const cur = this.store.get(full);
    const next = (cur ? Number(JSON.parse(cur.value)) : 0) + 1;
    this.store.set(full, { value: JSON.stringify(next), expiresAt: cur?.expiresAt ?? Date.now() + ttlSec * 1000, lastUsed: Date.now() });
    return next;
  }

  async withLock<T>(name: string, ttlMs: number, fn: () => Promise<T>) {
    const lockKey = this.key(`lock:${name}`);
    if (this.store.has(lockKey) && this.store.get(lockKey)!.expiresAt > Date.now()) return { ok: false } as const;
    this.store.set(lockKey, { value: '1', expiresAt: Date.now() + ttlMs, lastUsed: Date.now() });
    try {
      return { ok: true as const, value: await fn() };
    } finally {
      this.store.delete(lockKey);
    }
  }

  async clearNamespace() {
    for (const k of [...this.store.keys()]) if (k.startsWith(`${env.QUEUE_NAMESPACE}:`)) this.store.delete(k);
  }

  async close() {
    this.store.clear();
  }

  stats() {
    return { hits: this.hits, misses: this.misses, entries: this.store.size };
  }
}

class RedisCache implements Cache {
  readonly driver = 'redis' as const;
  private inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly client: import('ioredis').Redis, private readonly prefix: string) {}

  private key(k: string) {
    return `${this.prefix}${k}`;
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(this.key(key));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as unknown as T;
    }
  }

  async set<T>(key: string, value: T, ttlSec = 60): Promise<void> {
    await this.client.set(this.key(key), JSON.stringify(value), 'EX', Math.max(1, ttlSec));
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length) await this.client.del(...keys.map((k) => this.key(k)));
  }

  async getOrSet<T>(key: string, ttlSec: number, producer: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;
    // Single-flight: concurrent misses share one producer call (thundering herd guard).
    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const p = producer()
      .then(async (value) => {
        if (value !== null && value !== undefined) await this.set(key, value, ttlSec);
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  async incr(key: string, ttlSec = 3600): Promise<number> {
    const full = this.key(key);
    const n = await this.client.incr(full);
    if (n === 1) await this.client.expire(full, ttlSec);
    return n;
  }

  async withLock<T>(name: string, ttlMs: number, fn: () => Promise<T>) {
    const lockKey = this.key(`lock:${name}`);
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const got = await this.client.set(lockKey, token, 'PX', ttlMs, 'NX');
    if (!got) return { ok: false } as const;
    try {
      return { ok: true as const, value: await fn() };
    } finally {
      // Release only our own lock (Lua compare-and-delete).
      await this.client
        .eval(`if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`, 1, lockKey, token)
        .catch(() => undefined);
    }
  }

  async clearNamespace() {
    const stream = this.client.scanStream({ match: `${this.prefix}*`, count: 200 });
    const pipeline = this.client.pipeline();
    let seen = 0;
    for await (const keys of stream as AsyncIterable<string[]>) {
      for (const k of keys) {
        pipeline.del(k);
        seen += 1;
      }
      if (seen > 5000) break;
    }
    await pipeline.exec();
  }

  async close() {
    await this.client.quit().catch(() => undefined);
  }
}

let cache: Cache | null = null;

export async function getCache(): Promise<Cache> {
  if (cache) return cache;
  if (env.REDIS_URL) {
    try {
      const { Redis } = await import('ioredis');
      const client = new Redis(env.REDIS_URL, {
        maxRetriesPerRequest: 2,
        enableReadyCheck: true,
        lazyConnect: false,
        keyPrefix: '',
      });
      client.on('error', () => {
        /* surfaced via health endpoint; never crash the API on a cache blip */
      });
      cache = new RedisCache(client, `${env.QUEUE_NAMESPACE}:`);
      return cache;
    } catch (err) {
      process.emitWarning(`Redis unavailable (${(err as Error).message}); falling back to in-process cache`, 'D7music');
    }
  }
  cache = new MemoryCache();
  return cache;
}

export function setCache(c: Cache) {
  cache = c;
}

export function cacheKey(parts: (string | number | null | undefined)[]) {
  return parts.map((p) => (p === null || p === undefined ? 'anon' : String(p))).join('|');
}
