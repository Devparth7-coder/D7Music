/**
 * Auth routes (spec §18): registration, login, session revocation, email verification,
 * password reset, and a generic OAuth link that is inert until credentials exist.
 *
 * Two rules shape everything below:
 *  1. Never reveal whether an email/username exists (login and reset respond identically).
 *  2. Cookies are set httpOnly + SameSite=Lax; the JWT alone is not authority — the hashed
 *     session row in `auth_sessions` is what makes a token valid, so revocation works.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '@d7/config';
import {
  ApiError,
  guardRate,
  parseBody,
} from '../lib/http.js';
import { SESSION_COOKIE, buildCurrentUser, httpError } from '../plugins/session.js';
import { sendMail, webLink } from '../lib/mail.js';
import {
  createUser,
  findUserByLogin,
  hashPassword,
  passwordScore,
  verifyPassword,
  issueToken,
  consumeToken,
  markEmailVerified,
  hasRecentToken,
  revokeAllSessions,
  setPassword,
  listSessions,
  updateUser,
  hashToken,
} from '@d7/database';
import type { AuthSessionResponse, CurrentUser } from '@d7/types';

const USERNAME = /^[a-z0-9][a-z0-9._-]{1,28}$/;

const registerSchema = z.object({
  username: z.string().min(3).max(30),
  email: z.email('Enter a valid email address.'),
  password: z.string().min(8, 'Use at least 8 characters.').max(200),
  displayName: z.string().max(80).optional(),
  role: z.enum(['listener', 'artist']).optional(),
  acceptTerms: z.boolean().optional(),
});

const loginSchema = z.object({
  login: z.string().min(3).max(200),
  password: z.string().min(1).max(200),
});

export function isUniqueViolation(err: unknown) {
  const code = (err as { code?: string } | undefined)?.code;
  return code === '23505' || /duplicate key value violates unique constraint/.test(String((err as Error)?.message ?? ''));
}

async function sessionPayload(user: CurrentUser): Promise<AuthSessionResponse> {
  return { user, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + env.SESSION_TTL_DAYS * 86_400_000).toISOString() };
}

export default async function authRoutes(app: FastifyInstance) {
  /* -------------------------------- register -------------------------------- */

  app.post('/api/auth/register', async (request, reply) => {
    await guardRate(app, request, reply, { bucket: 'auth:register', limit: env.RATE_LIMIT_AUTH, message: 'Too many sign-up attempts. Try again in a minute.' });
    const body = parseBody(registerSchema, request.body);
    const username = body.username.trim().toLowerCase();
    if (!USERNAME.test(username)) {
      throw ApiError.badRequest('Pick a username of 3-30 characters: lowercase letters, numbers, dot, dash or underscore.', [
        { path: 'username', message: 'Must match ^[a-z0-9][a-z0-9._-]{1,28}$' },
      ]);
    }
    const strength = passwordScore(body.password);
    if (!strength.ok) throw ApiError.badRequest('That password is too easy to guess.', [{ path: 'password', message: 'Avoid common patterns; mix case, a digit and length.' }]);
    if (body.acceptTerms === false) throw ApiError.badRequest('You must accept the terms to create an account.', [{ path: 'acceptTerms', message: 'Required' }]);

    const passwordHash = await hashPassword(body.password);
    let created;
    try {
      created = await createUser(app.d7.db, {
        username,
        email: body.email.trim().toLowerCase(),
        passwordHash,
        displayName: body.displayName?.trim() || username,
        role: body.role ?? 'listener',
        emailVerified: !env.isProd,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Both cases answer the same way; we cannot tell which field collided without leaking.
        throw new ApiError(409, 'ACCOUNT_EXISTS', 'That username or email is already registered. Try signing in instead.', [
          { path: 'username', message: 'May already be taken' },
          { path: 'email', message: 'May already be registered' },
        ]);
      }
      throw err;
    }

    const verification = await issueToken(app.d7.db, created.id, 'verify_email', 60 * 48);
    const receipt = await sendMail({
      to: created.email,
      subject: 'Confirm your D7music email',
      text: `Welcome to D7music.\n\nConfirm your address: ${webLink(`/auth/verify-email?token=${verification.token}`)}\n\nIf you did not create this account, no action is needed.`,
    });
    app.d7.log.info('verification mail queued', { userId: created.id, mode: receipt.mode });

    await app.issueSession(reply, created.id, { userAgent: request.headers['user-agent'] });
    const user = await buildCurrentUser(app.d7.db, created.id);
    if (!user) throw new ApiError(500, 'INTERNAL_ERROR', 'Account was created but could not be loaded.');
    reply.code(201);
    return await sessionPayload(user);
  });

  /* --------------------------------- login --------------------------------- */

  app.post('/api/auth/login', async (request, reply) => {
    await guardRate(app, request, reply, { bucket: 'auth:login', limit: env.RATE_LIMIT_AUTH, message: 'Too many sign-in attempts. Wait a minute before retrying.' });
    const body = parseBody(loginSchema, request.body);
    const userRow = await findUserByLogin(app.d7.db, body.login.trim());
    const ok = await verifyPassword(body.password, userRow?.password_hash);
    if (!userRow || !ok) {
      throw new ApiError(401, 'BAD_CREDENTIALS', 'Email or password is incorrect.');
    }
    if (userRow.status === 'suspended') throw new ApiError(403, 'SUSPENDED', 'This account has been suspended by a moderator.');
    if (userRow.status === 'deleted') throw new ApiError(404, 'NOT_FOUND', 'Email or password is incorrect.');
    await app.issueSession(reply, userRow.id, { userAgent: request.headers['user-agent'] });
    const user = await buildCurrentUser(app.d7.db, userRow.id);
    if (!user) throw new ApiError(500, 'INTERNAL_ERROR', 'Could not load your profile.');
    return sessionPayload(user);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    await app.dropSession(request, reply);
    return reply.code(204).send();
  });

  app.get('/api/auth/me', async (request) => {
    const user = await request.optionalUser();
    if (!user) return { user: null, authenticated: false, devAccounts: devHints() };
    return { user, authenticated: true, csrf: { cookie: SESSION_COOKIE, strategy: 'same-site + origin allow-list' } };
  });

  app.get('/api/auth/sessions', async (request) => {
    const user = await request.requireUser();
    const rows = await listSessions(app.d7.db, user.id, hashToken(String(request.cookies[SESSION_COOKIE] ?? '')));
    return {
      sessions: rows.map((r) => ({
        id: String(r.id),
        userAgent: r.user_agent,
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at,
        current: Boolean(r.is_current),
      })),
    };
  });

  app.delete('/api/auth/sessions', async (request) => {
    const user = await request.requireUser();
    const revoked = await revokeAllSessions(app.d7.db, user.id);
    return { revoked };
  });

  app.patch('/api/auth/password', async (request, reply) => {
    const user = await request.requireUser();
    const body = parseBody(z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(8).max(200) }), request.body);
    const row = await findUserByLogin(app.d7.db, user.email);
    const ok = await verifyPassword(body.currentPassword, row?.password_hash);
    if (!ok) throw new ApiError(403, 'BAD_CREDENTIALS', 'Your current password is not correct.', [{ path: 'currentPassword', message: 'Incorrect' }]);
    if (!passwordScore(body.newPassword).ok) throw ApiError.badRequest('That new password is too easy to guess.', [{ path: 'newPassword', message: 'Mix length, case and digits.' }]);
    await setPassword(app.d7.db, user.id, await hashPassword(body.newPassword));
    await revokeAllSessions(app.d7.db, user.id);
    await app.issueSession(reply, user.id, { userAgent: request.headers['user-agent'] });
    return { ok: true, note: 'Other devices were signed out.' };
  });

  /* -------------------------- verification + password -------------------------- */

  app.post('/api/auth/email/resend', async (request, reply) => {
    await guardRate(app, request, reply, { bucket: 'auth:resend', limit: 5, message: 'Verification emails are limited to 5 per hour.' , windowSec: 3600 });
    const body = parseBody(z.object({ login: z.string().min(3).max(200) }), request.body);
    const row = await findUserByLogin(app.d7.db, body.login.trim());
    if (row && !(await hasRecentToken(app.d7.db, row.id, 'verify_email', 60))) {
      const t = await issueToken(app.d7.db, row.id, 'verify_email', 60 * 48);
      await sendMail({
        to: row.email,
        subject: 'Confirm your D7music email',
        text: `Confirm your address: ${webLink(`/auth/verify-email?token=${t.token}`)}`,
      });
    }
    // Same answer either way — existence of an account is not disclosed.
    return reply.code(202).send({ accepted: true, note: 'If that address needs verification, a new email is on its way.' });
  });

  app.get('/api/auth/verify-email', async (request, reply) => {
    const token = String((request.query as { token?: string }).token ?? '');
    if (!token) throw ApiError.badRequest('Missing verification token.');
    const res = await consumeToken(app.d7.db, token, 'verify_email');
    if (!res.ok) throw new ApiError(400, 'TOKEN_INVALID', res.reason);
    await markEmailVerified(app.d7.db, res.userId);
    if ((request.query as { redirect?: string }).redirect === 'none') return { ok: true, emailVerified: true };
    return reply.redirect(`${env.WEB_ORIGIN}/settings?verified=1`, 302);
  });

  app.post('/api/auth/password/forgot', async (request, reply) => {
    await guardRate(app, request, reply, { bucket: 'auth:forgot', limit: 5, message: 'Password resets are limited to 5 per hour.', windowSec: 3600 });
    const body = parseBody(z.object({ login: z.string().min(3).max(200) }), request.body);
    const row = await findUserByLogin(app.d7.db, body.login.trim());
    let devToken: string | null = null;
    if (row && !(await hasRecentToken(app.d7.db, row.id, 'password_reset', 15))) {
      const t = await issueToken(app.d7.db, row.id, 'password_reset', 45);
      devToken = t.token;
      await sendMail({
        to: row.email,
        subject: 'Reset your D7music password',
        text: `Use this link within 45 minutes to choose a new password:\n\n${webLink(`/auth/reset-password?token=${t.token}`)}\n\nIf you did not ask for this, ignore the email — your password stays the same.`,
      });
    }
    return reply.code(202).send({
      accepted: true,
      note: 'If that account exists, a reset link is on its way.',
      // Never in production: the only way to try the flow without a mail server.
      devToken: env.isProd ? undefined : devToken,
      devOutbox: env.isProd ? undefined : env.MAIL_OUTBOX_DIR,
    });
  });

  app.post('/api/auth/password/reset', async (request, reply) => {
    const body = parseBody(z.object({ token: z.string().min(10), password: z.string().min(8).max(200) }), request.body);
    if (!passwordScore(body.password).ok) throw ApiError.badRequest('That password is too easy to guess.', [{ path: 'password', message: 'Mix length, case and digits.' }]);
    const res = await consumeToken(app.d7.db, body.token, 'password_reset');
    if (!res.ok) throw new ApiError(400, 'TOKEN_INVALID', res.reason);
    await setPassword(app.d7.db, res.userId, await hashPassword(body.password));
    const signedOut = await revokeAllSessions(app.d7.db, res.userId);
    const user = await buildCurrentUser(app.d7.db, res.userId);
    if (!user) throw new ApiError(500, 'INTERNAL_ERROR', 'Password changed but profile could not be loaded.');
    await app.issueSession(reply, res.userId, { userAgent: request.headers['user-agent'] });
    return { ...(await sessionPayload(user)), otherSessionsRevoked: signedOut };
  });

  /* --------------------------------- profile --------------------------------- */

  app.patch('/api/users/me', async (request) => {
    const user = await request.requireUser();
    const body = parseBody(
      z.object({ displayName: z.string().max(80).nullable().optional(), bio: z.string().max(500).nullable().optional(), avatarUrl: z.string().max(500).nullable().optional() }),
      request.body,
    );
    await updateUser(app.d7.db, user.id, body);
    return { user: await buildCurrentUser(app.d7.db, user.id) };
  });

  /* ---------------------------------- OAuth ---------------------------------- */

  app.get('/api/auth/oauth/:provider', async (request, reply: FastifyReply) => {
    const provider = String((request.params as { provider: string }).provider).toLowerCase();
    const config = oauthConfig(provider);
    if (!config) throw httpError(501, 'OAUTH_NOT_CONFIGURED', `Provider "${provider}" has no credentials configured. Set ${provider.toUpperCase()}_CLIENT_ID / _CLIENT_SECRET (or OIDC_*) and try again.`);
    const state = randomState();
    const url = new URL(config.authorizeUrl);
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', callbackUrl(provider));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', config.scopes);
    url.searchParams.set('state', state);
    reply.setCookie('d7_oauth_state', `${provider}.${state}`, { path: '/', httpOnly: true, sameSite: 'lax', secure: env.isProd, maxAge: 600 });
    return reply.redirect(url.toString(), 302);
  });

  app.get('/api/auth/oauth/:provider/callback', async (request, reply: FastifyReply) => {
    const provider = String((request.params as { provider: string }).provider).toLowerCase();
    const config = oauthConfig(provider);
    if (!config) throw httpError(501, 'OAUTH_NOT_CONFIGURED', `Provider "${provider}" is not configured.`);
    const query = request.query as { code?: string; state?: string; error?: string };
    if (query.error) return reply.redirect(`${env.WEB_ORIGIN}/login?error=${encodeURIComponent(String(query.error))}`, 302);
    const cookieState = String(request.cookies['d7_oauth_state'] ?? '');
    if (!query.code || !query.state || cookieState !== `${provider}.${query.state}`) {
      throw httpError(400, 'OAUTH_STATE', 'That sign-in link has expired or was tampered with. Try again.');
    }
    reply.clearCookie('d7_oauth_state', { path: '/' });

    const tokens = await fetchJson(config.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: query.code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: callbackUrl(provider),
      }).toString(),
    });
    const accessToken = String(tokens?.access_token ?? '');
    if (!accessToken) throw httpError(502, 'OAUTH_TOKEN_FAILED', 'The identity provider did not return an access token.');
    const profile = await fetchJson(config.profileUrl, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'user-agent': 'd7music-api' } });
    const externalId = String(profile?.sub ?? profile?.id ?? profile?.node_id ?? '');
    if (!externalId) throw httpError(502, 'OAUTH_PROFILE', 'The identity provider did not return a stable user id.');
    const email = String(profile?.email ?? profile?.primary_email ?? '').toLowerCase() || null;
    const name = String(profile?.name ?? profile?.login ?? profile?.given_name ?? '') || null;

    const linked = await linkOAuthAccount(app, provider, externalId, email, name);
    await app.issueSession(reply, linked.userId, { userAgent: request.headers['user-agent'] });
    return reply.redirect(`${env.WEB_ORIGIN}${linked.created ? '/onboarding?oauth=1' : '/?signedin=1'}`, 302);
  });
}

/* ---------------------------------- helpers ---------------------------------- */

function randomState() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function callbackUrl(provider: string) {
  return `${(env.API_PUBLIC_URL || env.WEB_ORIGIN).replace(/\/+$/, '')}/api/auth/oauth/${provider}/callback`;
}

interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  profileUrl: string;
  scopes: string;
}

/** Providers come from OAUTH_PROVIDERS; each needs credentials to be usable. */
export function oauthConfig(provider: string): OAuthConfig | null {
  if (!env.OAUTH_PROVIDERS.includes(provider)) return null;
  if (provider === 'google' && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    return {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      profileUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
      scopes: 'openid email profile',
    };
  }
  if (provider === 'github' && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    return {
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      authorizeUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      profileUrl: 'https://api.github.com/user',
      scopes: 'read:user user:email',
    };
  }
  if (provider === 'oidc' && env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET) {
    const issuer = env.OIDC_ISSUER.replace(/\/+$/, '');
    return {
      clientId: env.OIDC_CLIENT_ID,
      clientSecret: env.OIDC_CLIENT_SECRET,
      authorizeUrl: `${issuer}/authorize`,
      tokenUrl: `${issuer}/token`,
      profileUrl: `${issuer}/userinfo`,
      scopes: 'openid email profile',
    };
  }
  return null;
}

async function fetchJson(url: string, init: RequestInit): Promise<Record<string, unknown> | null> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!res || !res.ok) return null;
  return (await res.json().catch(() => null)) as Record<string, unknown> | null;
}

export async function linkOAuthAccount(
  app: FastifyInstance,
  provider: string,
  externalId: string,
  email: string | null,
  name: string | null,
): Promise<{ userId: string; created: boolean }> {
  const db = app.d7.db;
  const existing = await db.queryOne<{ user_id: string }>(`SELECT user_id::text FROM oauth_accounts WHERE provider = $1 AND provider_user_id = $2`, [provider, externalId]);
  if (existing) return { userId: existing.user_id, created: false };

  if (email) {
    const byEmail = await db.queryOne<{ id: string }>(`SELECT id::text FROM users WHERE email_key = d7_normalize_text($1)`, [email]);
    if (byEmail) {
      await db.execute(
        `INSERT INTO oauth_accounts (id, user_id, provider, provider_user_id, email, raw_profile)
         VALUES (d7_uuid(), $1::uuid, $2, $3, $4, '{}'::jsonb) ON CONFLICT DO NOTHING`,
        [byEmail.id, provider, externalId, email],
      );
      return { userId: byEmail.id, created: false };
    }
  }

  const base = (name ?? email?.split('@')[0] ?? `user${externalId.slice(0, 6)}`)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 24) || 'music';
  let username = base;
  for (let i = 2; i < 50; i++) {
    const clash = await db.queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM users WHERE username_key = d7_normalize_text($1)`, [username]);
    if (!Number(clash?.c ?? 0)) break;
    username = `${base}-${i}`.slice(0, 30);
  }
  const created = await createUser(db, {
    username,
    email: email ?? `${provider}-${externalId}@users.noreply.d7music.local`,
    passwordHash: null,
    displayName: name ?? username,
    role: 'listener',
    emailVerified: true,
  });
  await db.execute(
    `INSERT INTO oauth_accounts (id, user_id, provider, provider_user_id, email, raw_profile)
     VALUES (d7_uuid(), $1::uuid, $2, $3, $4, '{}'::jsonb)`,
    [created.id, provider, externalId, email],
  );
  return { userId: created.id, created: true };
}

/** Seeded accounts are surfaced in dev so the README promise "sign in as demo" is true. */
function devHints() {
  if (env.isProd) return undefined;
  return { listener: env.SEED_DEMO_EMAIL, admin: env.SEED_ADMIN_EMAIL, note: 'passwords are in .env.example' };
}
