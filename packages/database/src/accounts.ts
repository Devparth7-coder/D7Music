/**
 * Account operations that the API needs but the catalog layer should not own:
 * credential changes, verification tokens, subscription tier changes, and a
 * database-backed rate-limit bucket (works identically on PGlite and Postgres,
 * and degrades to "no limit" if the table is somehow missing).
 */
import type { Db } from './client.js';
import { hashToken } from './auth-hash.js';
import type { SubscriptionView } from '@d7/types';

/* ------------------------------ credentials ------------------------------ */

export async function setPassword(db: Db, userId: string, passwordHash: string) {
  await db.execute(`UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1::uuid`, [userId, passwordHash]);
}

/** Used by "sign out everywhere": every session row is revoked, so old cookies stop working. */
export async function revokeAllSessions(db: Db, userId: string) {
  return db.execute(`UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1::uuid AND revoked_at IS NULL`, [userId]);
}

export async function listSessions(db: Db, userId: string, currentTokenHash: string | null) {
  return db.query<Record<string, any>>(
    `SELECT id::text, user_agent, created_at::text, last_seen_at::text,
            (token_hash = $2) AS is_current
       FROM auth_sessions
      WHERE user_id = $1::uuid AND revoked_at IS NULL AND expires_at > now()
      ORDER BY last_seen_at DESC NULLS LAST
      LIMIT 20`,
    [userId, currentTokenHash ?? ''],
  );
}

/* -------------------------- verification / reset -------------------------- */

export async function issueToken(db: Db, userId: string, purpose: 'verify_email' | 'password_reset', ttlMinutes: number): Promise<{ token: string; issuedAt: string }> {
  const token = randomToken();
  await db.execute(
    `INSERT INTO email_verification_tokens (id, user_id, token_hash, purpose, expires_at, created_at)
     VALUES (d7_uuid(), $1::uuid, $2, $3, now() + make_interval(mins => $4::int), now())`,
    [userId, hashToken(token), purpose, ttlMinutes],
  );
  return { token, issuedAt: new Date().toISOString() };
}

/** Returns the token row's user id when valid, or a reason string when not. */
export async function consumeToken(db: Db, token: string, purpose: 'verify_email' | 'password_reset'): Promise<{ ok: true; userId: string } | { ok: false; reason: string }> {
  const row = await db.queryOne<{ user_id: string; expired: boolean; consumed: boolean }>(
    `SELECT user_id::text, (expires_at < now()) AS expired, (consumed_at IS NOT NULL) AS consumed
       FROM email_verification_tokens WHERE token_hash = $1 AND purpose = $2`,
    [hashToken(token), purpose],
  );
  if (!row) return { ok: false, reason: 'This link is not valid.' };
  if (row.expired) return { ok: false, reason: 'This link has expired. Request a new one.' };
  if (row.consumed) return { ok: false, reason: 'This link has already been used.' };
  await db.execute(`UPDATE email_verification_tokens SET consumed_at = now() WHERE token_hash = $1 AND purpose = $2`, [hashToken(token), purpose]);
  return { ok: true, userId: row.user_id };
}

export async function markEmailVerified(db: Db, userId: string) {
  await db.execute(`UPDATE users SET email_verified = true, updated_at = now() WHERE id = $1::uuid`, [userId]);
}

export async function hasRecentToken(db: Db, userId: string, purpose: 'verify_email' | 'password_reset', withinMinutes: number) {
  const row = await db.queryOne<{ c: number }>(
    `SELECT count(*)::int AS c FROM email_verification_tokens
      WHERE user_id = $1::uuid AND purpose = $2 AND created_at > now() - make_interval(mins => $3::int)`,
    [userId, purpose, withinMinutes],
  );
  return Number(row?.c ?? 0) > 0;
}

function randomToken() {
  // 32 random bytes, base64url — same shape auth-hash.generateToken() produces, inlined to
  // keep this module free of node:crypto imports for the browser-side typecheck path.
  const bytes = new Uint8Array(32);
  if (typeof globalThis.crypto?.getRandomValues === 'function') globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ------------------------------ subscriptions ------------------------------ */

export async function getSubscription(db: Db, userId: string): Promise<SubscriptionView | null> {
  const row = await db.queryOne<Record<string, any>>(
    `SELECT tier, status, payment_provider, current_period_end, cancel_at_period_end
       FROM subscriptions WHERE user_id = $1::uuid ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  if (!row) return null;
  return {
    tier: row.tier === 'premium' ? 'premium' : 'free',
    status: row.status,
    provider: row.payment_provider,
    currentPeriodEnd: row.current_period_end ? String(row.current_period_end) : null,
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
  };
}

/**
 * Applies a plan change. With PAYMENT_PROVIDER=manual this is the whole flow: no charge,
 * just a tier flip plus an audit trail. A real gateway calls the same function from its
 * webhook handler after verifying the signature.
 */
export async function changeTier(db: Db, userId: string, tier: 'free' | 'premium', opts: { provider?: string; months?: number; reference?: string | null } = {}) {
  const months = Math.max(1, Math.min(120, opts.months ?? 12));
  // An append-only history: the active row is retired and a new one opened, so the
  // subscription_events table can be reconciled against real plan changes.
  await db.transaction(async (tx) => {
    await tx.execute(
      `UPDATE subscriptions SET status = 'canceled', updated_at = now() WHERE user_id = $1::uuid AND status IN ('active','trialing','past_due')`,
      [userId],
    );
    await tx.execute(
      `INSERT INTO subscriptions (id, user_id, tier, status, payment_provider, price_cents, current_period_start, current_period_end, cancel_at_period_end)
       VALUES (d7_uuid(), $1::uuid, $2, 'active', $3, $4, now(), now() + make_interval(months => $5::int), false)`,
      [userId, tier, opts.provider ?? 'manual', tier === 'premium' ? 999 : 0, months],
    );
  });
  await db.execute(
    `INSERT INTO subscription_events (id, user_id, type, tier, provider, reference, created_at)
     VALUES (d7_uuid(), $1::uuid, $2, $3, $4, $5, now())`,
    [userId, tier === 'premium' ? 'upgraded' : 'downgraded', tier, opts.provider ?? 'manual', opts.reference ?? null],
  );
  return getSubscription(db, userId);
}

export async function setCancelAtPeriodEnd(db: Db, userId: string, cancel: boolean) {
  await db.execute(`UPDATE subscriptions SET cancel_at_period_end = $2, updated_at = now() WHERE user_id = $1::uuid`, [userId, cancel]);
  return getSubscription(db, userId);
}

/* -------------------------------- rate limit -------------------------------- */

export interface RateDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

/**
 * Fixed-window limiter keyed on (bucket, actor) with a per-minute window. Uses the cache when
 * present (Redis), and the `rate_limits` table otherwise, so a single-process dev server and a
 * multi-process Postgres deployment both get a working limit.
 */
export async function takeRate(db: Db, input: { bucket: string; actor: string; limit: number; windowSec?: number; cacheHit?: (key: string, max: number, ttlSec: number) => Promise<number | null> }): Promise<RateDecision> {
  const windowSec = Math.max(1, input.windowSec ?? 60);
  if (input.cacheHit) {
    try {
      const count = await input.cacheHit(`rl:${input.bucket}`, input.limit, windowSec);
      if (count !== null) {
        return { allowed: count <= input.limit, remaining: Math.max(0, input.limit - count), retryAfterSec: windowSec };
      }
    } catch {
      /* fall through to SQL */
    }
  }
  const windowStart = new Date(Math.floor(Date.now() / (windowSec * 1000)) * windowSec * 1000);
  let count = 1;
  try {
    const res = await db.query<{ count: number | string }>(
      `INSERT INTO rate_limits (bucket, window_start, count) VALUES ($1, $2, 1)
       ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limits.count + 1
       RETURNING count`,
      [`${input.bucket}:${input.actor}`, windowStart.toISOString()],
    );
    count = Number(res[0]?.count ?? 1);
    // Keep the table small; old windows are cheap to drop inline.
    void db.execute(`DELETE FROM rate_limits WHERE window_start < now() - interval '1 hour'`).catch(() => undefined);
  } catch {
    return { allowed: true, remaining: input.limit, retryAfterSec: 0 };
  }
  return { allowed: count <= input.limit, remaining: Math.max(0, input.limit - count), retryAfterSec: windowSec };
}
