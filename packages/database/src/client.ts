/**
 * Database access layer.
 *
 * Two drivers, one interface:
 *  - `postgres`: node-postgres pool against a real/managed PostgreSQL (production).
 *  - `pglite`  : @electric-sql/pglite — an actual PostgreSQL compiled to WASM, file
 *                backed. Used for local dev and tests so the *same* SQL, triggers and
 *                unique indexes are exercised without requiring a server. It is not a
 *                production datastore (env validation refuses `DB_DRIVER=pglite` in prod).
 */
import { env, resolveDataPath } from '@d7/config';

export type Params = unknown[];

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: Params): Promise<T[]>;
  queryOne<T = Record<string, unknown>>(sql: string, params?: Params): Promise<T | undefined>;
  /** Returns number of affected rows. */
  execute(sql: string, params?: Params): Promise<number>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  readonly driver: 'postgres' | 'pglite';
  close(): Promise<void>;
  /** Escapes values for safe ad-hoc logging only (never for query building in prod paths). */
  readonly logLabel: string;
}

/** Deterministic, driver-independent value coercion so API JSON is stable. */
function coerce(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(coerce);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = coerce(v);
    return out;
  }
  if (typeof value === 'string') {
    // numeric() / int8 arrive as strings from pg unless a parser is registered
    return value;
  }
  return value;
}

class PostgresDb implements Db {
  readonly driver = 'postgres' as const;
  readonly logLabel = 'postgres';
  private closed = false;

  constructor(private readonly pool: import('pg').Pool) {}

  async query<T>(sql: string, params: Params = []): Promise<T[]> {
    const res = await this.pool.query(sql, params as never[]);
    return res.rows.map((r) => coerce(r) as T);
  }
  async queryOne<T>(sql: string, params: Params = []): Promise<T | undefined> {
    const rows = await this.query<T>(sql, params);
    return rows[0];
  }
  async execute(sql: string, params: Params = []): Promise<number> {
    const res = await this.pool.query(sql, params as never[]);
    return res.rowCount ?? 0;
  }
  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const tx = new PostgresClientDb(client as unknown as import('pg').Pool);
      const out = await fn(tx);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }
}

class PostgresClientDb extends PostgresDb {
  constructor(private readonly client: import('pg').Pool) {
    super(client);
  }
  override async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    // Savepoint-based nesting so repos can compose.
    const id = `sp_${Math.random().toString(36).slice(2, 9)}`;
    await this.client.query(`SAVEPOINT ${id}`);
    try {
      const out = await fn(this);
      await this.client.query(`RELEASE SAVEPOINT ${id}`);
      return out;
    } catch (err) {
      await this.client.query(`ROLLBACK TO SAVEPOINT ${id}`).catch(() => {});
      throw err;
    }
  }
}

class PgliteDb implements Db {
  readonly driver = 'pglite' as const;
  readonly logLabel = `pglite@${env.PGLITE_DIR}`;
  /** Serializes access: PGlite is one connection, interleaved queries would corrupt results. */
  private chain: Promise<unknown> = Promise.resolve();
  /**
   * Reentrancy latch. While a transaction is in flight the outer queue entry already
   * owns the connection, so nested calls must run directly — queueing them behind the
   * transaction would deadlock (the queue can never drain until the tx finishes).
   */
  private inTx = false;

  constructor(private readonly db: import('@electric-sql/pglite').PGlite) {}

  private run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inTx) return fn();
    const next = this.chain.then(fn, fn);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async query<T>(sql: string, params: Params = []): Promise<T[]> {
    return this.run(async () => {
      const res = await this.db.query(sql, params as never[]);
      const rows = (res.rows ?? []) as unknown as Record<string, unknown>[];
      return rows.map((r) => coerce(r) as T);
    });
  }
  async queryOne<T>(sql: string, params: Params = []): Promise<T | undefined> {
    const rows = await this.query<T>(sql, params);
    return rows[0];
  }
  async execute(sql: string, params: Params = []): Promise<number> {
    return this.run(async () => {
      // Whole-file DDL/scripts use the simple protocol (multi-statement) — extended
      // protocol rejects multiple commands in one call.
      if (!params.length) {
        await this.db.exec(sql);
        return 0;
      }
      const res = await this.db.query(sql, params as never[]);
      const affected = (res as unknown as { affectedRows?: number }).affectedRows;
      return typeof affected === 'number' ? affected : (res.rows?.length ?? 0);
    });
  }
  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.inTx) {
      // Nested transaction: Postgres has no nested BEGIN, use a savepoint.
      const id = `sp_${Math.random().toString(36).slice(2, 9)}`;
      await this.db.query(`SAVEPOINT ${id}`);
      try {
        const out = await fn(this);
        await this.db.query(`RELEASE SAVEPOINT ${id}`);
        return out;
      } catch (err) {
        await this.db.query(`ROLLBACK TO SAVEPOINT ${id}`).catch(() => {});
        throw err;
      }
    }
    return this.run(async () => {
      this.inTx = true;
      try {
        await this.db.query('BEGIN');
        try {
          const out = await fn(this);
          await this.db.query('COMMIT');
          return out;
        } catch (err) {
          await this.db.query('ROLLBACK').catch(() => {});
          throw err;
        }
      } finally {
        this.inTx = false;
      }
    });
  }
  async close(): Promise<void> {
    await this.run(() => this.db.close());
  }
}

let pool: import('pg').Pool | null = null;
let pglite: import('@electric-sql/pglite').PGlite | null = null;
let instance: Db | null = null;

export async function createDb(overrides: { driver?: Db['driver']; url?: string; dir?: string } = {}): Promise<Db> {
  const driver = overrides.driver ?? env.DB_DRIVER;
  if (driver === 'postgres') {
    if (!pool) {
      const { default: pg } = await import('pg');
      if (!env.DATABASE_URL && !overrides.url) {
        throw new Error(
          'DATABASE_URL is required when DB_DRIVER=postgres. ' +
            'For a zero-setup local run use DB_DRIVER=pglite.',
        );
      }
      pool = new pg.Pool({
        connectionString: overrides.url ?? env.DATABASE_URL,
        max: env.DB_POOL_MAX,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
        statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
        ssl: /sslmode=require/.test(overrides.url ?? env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
      });
      // Keep JSON numerics real numbers and timestamps ISO strings across both drivers.
      pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
      pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
      pg.types.setTypeParser(1114, (v) => (v === null ? null : new Date(`${v}Z`).toISOString()));
      pg.types.setTypeParser(1184, (v) => (v === null ? null : new Date(v).toISOString()));
    }
    return new PostgresDb(pool);
  }

  if (!pglite) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { mkdirSync } = await import('node:fs');
    const dir = resolveDataPath(overrides.dir ?? env.PGLITE_DIR);
    // PGlite's node fs does not create intermediate parents.
    if (dir !== ':memory:') mkdirSync(dir, { recursive: true });
    pglite = dir === ':memory:' ? new PGlite() : new PGlite(dir);
  }
  return new PgliteDb(pglite);
}

export async function getDb(): Promise<Db> {
  if (!instance) instance = await createDb();
  return instance;
}

export async function closeDb(): Promise<void> {
  if (instance) await instance.close();
  instance = null;
  pool = null;
  pglite = null;
}

/** Test helper: an isolated in-memory Postgres with the full schema applied. */
export async function createEphemeralDb(): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  const wrapped = new PgliteDb(db);
  const { applyMigrations } = await import('./migrate.js');
  await applyMigrations(wrapped);
  return wrapped;
}
