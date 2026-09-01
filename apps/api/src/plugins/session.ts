/**
 * Session + authorization plugin (spec §18).
 *
 * - Passwords: bcrypt (cost from BCRYPT_ROUNDS). Plaintext is never stored or logged.
 * - Sessions: httpOnly, SameSite=Lax cookie carrying a signed token whose SHA-256 digest is
 *   stored in `auth_sessions` — so logout, "sign out everywhere" and admin suspension all
 *   actually revoke, rather than merely deleting a client-side token.
 * - CSRF: same-site cookie plus an Origin allow-list on every mutating request.
 * - Roles: `requireRole(...)` is enforced on the route, never in the UI.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
// Registers the `request.cookies` / `reply.setCookie` type augmentations used below.
import '@fastify/cookie';
import fp from 'fastify-plugin';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { env, planFor } from '@d7/config';
import {
  findUserById,
  getPreferences,
  hashToken,
  type Db,
} from '@d7/database';
import type { CurrentUser } from '@d7/types';
import { getSubscription, listSessions } from '@d7/database';

export type Role = 'listener' | 'artist' | 'admin';

/** `request.user` — the shape every route reads. `plan` drives feature gating (§19). */
export interface SessionUser extends CurrentUser {
  plan: ReturnType<typeof planFor>;
  status: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
    optionalUser(): Promise<SessionUser | null>;
    requireUser(): Promise<SessionUser>;
    requireRole(...roles: Role[]): Promise<SessionUser>;
  }
  interface FastifyInstance {
    d7: import('../context.js').AppContext;
    issueSession(reply: FastifyReply, userId: string, meta?: { userAgent?: string | null }): Promise<string>;
    dropSession(request: { cookies: Record<string, string | undefined> }, reply: FastifyReply): Promise<void>;
  }
}

export const SESSION_COOKIE = 'd7_session';
export const SESSION_TTL_SEC = env.SESSION_TTL_DAYS * 86_400;

export function signSession(userId: string) {
  return jwt.sign({ sub: userId, sid: randomBytes(8).toString('hex') }, env.APP_SECRET, {
    algorithm: 'HS256',
    expiresIn: SESSION_TTL_SEC,
    issuer: 'd7music-api',
    audience: 'd7music-web',
  });
}

export function readSessionClaims(token: string): { sub: string; sid: string } | null {
  try {
    const decoded = jwt.verify(token, env.APP_SECRET, { algorithms: ['HS256'], issuer: 'd7music-api', audience: 'd7music-web' });
    if (typeof decoded === 'string') return null;
    const { sub, sid } = decoded as { sub?: string; sid?: string };
    return sub && sid ? { sub, sid } : null;
  } catch {
    return null;
  }
}

export function buildCurrentUser(db: Db, userId: string): Promise<SessionUser | null> {
  return (async () => {
    const row = await findUserById(db, userId);
    if (!row || row.status === 'deleted') return null;
    const [prefs, subscription, counts] = await Promise.all([
      getPreferences(db, userId),
      getSubscription(db, userId),
      db.queryOne<Record<string, number>>(
        `SELECT
           (SELECT count(*) FROM user_follows WHERE followee_id = $1::uuid)::int AS followers,
           (SELECT count(*) FROM user_follows WHERE follower_id = $1::uuid)::int AS following,
           (SELECT count(*) FROM playlists WHERE owner_id = $1::uuid AND visibility <> 'private')::int AS playlists`,
        [userId],
      ),
    ]);
    const tier = subscription?.tier === 'premium' ? 'premium' : 'free';
    return {
      id: String(row.id),
      username: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      bio: row.bio,
      role: row.role,
      status: row.status,
      tier,
      followersCount: Number(counts?.followers ?? 0),
      followingCount: Number(counts?.following ?? 0),
      publicPlaylistCount: Number(counts?.playlists ?? 0),
      createdAt: String(row.created_at),
      email: row.email,
      emailVerified: Boolean(row.email_verified),
      preferences: prefs,
      subscription: subscription ?? { tier: 'free', status: 'active', provider: 'manual', currentPeriodEnd: null, cancelAtPeriodEnd: false },
      plan: planFor(tier),
    };
  })();
}

const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const sessionPlugin = fp(
  async function session(app: FastifyInstance) {
    const db = () => app.d7.db;

    app.decorateRequest('user', null);

    app.addHook('onRequest', async (request) => {
      if (!MUTATIONS.has(request.method.toUpperCase())) return;
      const origin = request.headers.origin;
      if (!origin) return; // non-browser clients (curl, server-to-server) send no Origin
      const normalized = origin.replace(/\/+$/, '');
      if (ALLOWED_ORIGINS(app).has(normalized)) return;
      if (/^https?:\/\/[a-z0-9-]+\.e2b\.app$/i.test(normalized)) return; // live-preview hosts
      if (env.isDev) return; // local tooling on arbitrary ports
      throw httpError(403, 'CROSS_ORIGIN', 'Cross-origin form submissions are not allowed.');
    });

    app.decorate('issueSession', async (reply, userId, meta = {}) => {
      const token = signSession(userId);
      await db().execute(
        `INSERT INTO auth_sessions (id, user_id, token_hash, user_agent, expires_at, created_at, last_seen_at)
         VALUES (d7_uuid(), $1::uuid, $2, $3, now() + make_interval(secs => $4::int), now(), now())`,
        [userId, hashToken(token), meta.userAgent?.slice(0, 300) ?? null, SESSION_TTL_SEC],
      );
      reply.setCookie(SESSION_COOKIE, token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: env.isProd,
        maxAge: SESSION_TTL_SEC,
      });
      return token;
    });

    app.decorate('dropSession', async (request, reply) => {
      const token = request.cookies[SESSION_COOKIE];
      if (token) await db().execute(`UPDATE auth_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [hashToken(token)]);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
    });

    app.decorateRequest('optionalUser', async function optionalUser() {
      if (this.user) return this.user;
      const token = this.cookies[SESSION_COOKIE];
      if (!token) return null;
      const claims = readSessionClaims(token);
      if (!claims) return null;
      const live = await db().queryOne<{ user_id: string }>(
        `SELECT user_id::text FROM auth_sessions WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
        [hashToken(token)],
      );
      if (!live) return null;
      const user = await buildCurrentUser(db(), claims.sub);
      if (!user) return null;
      this.user = user;
      void db().execute(`UPDATE auth_sessions SET last_seen_at = now(), user_id = user_id WHERE token_hash = $1`, [hashToken(token)]).catch(() => undefined);
      return user;
    });

    app.decorateRequest('requireUser', async function requireUser() {
      const user = await this.optionalUser();
      if (!user) throw httpError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
      if (user.status === 'suspended') throw httpError(403, 'SUSPENDED', 'This account has been suspended.');
      return user;
    });

    app.decorateRequest('requireRole', async function requireRole(...roles) {
      const user = await this.requireUser();
      if (!roles.includes(user.role)) throw httpError(403, 'FORBIDDEN_ROLE', `This action requires the ${roles.join(' or ')} role.`);
      return user;
    });
  },
  { name: 'd7-session' },
);

function ALLOWED_ORIGINS(app: FastifyInstance) {
  void app;
  return new Set(
    [env.WEB_ORIGIN, env.API_PUBLIC_URL, `http://localhost:${env.API_PORT}`, `http://127.0.0.1:${env.API_PORT}`, 'http://localhost:3000', 'http://localhost:5173']
      .filter(Boolean)
      .map((u) => String(u).replace(/\/+$/, '')),
  );
}

export function httpError(statusCode: number, code: string, message: string, extra?: Record<string, unknown>) {
  return Object.assign(new Error(message), { statusCode, code, ...extra });
}

export { listSessions };
