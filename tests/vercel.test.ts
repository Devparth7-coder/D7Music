/**
 * Serverless (Vercel) plumbing tests.
 *
 * What is being proved here, in order of how much it can go wrong silently:
 *   1. the `(req, res)` bridge actually serves the real Fastify app over a real socket;
 *   2. a request whose URL was rewritten to the single function still routes to the right place;
 *   3. the cron gate fails closed and the stream-redirect decision never sends us to ourselves.
 *
 * The authorised cron path is not exercised by a request test: `env` is a frozen module singleton,
 * so `CRON_SECRET` is always empty in this process and the route can only answer 501. That path is
 * covered by the `cronTokenMatches` unit tests below and by the manual `curl` check in
 * docs/DEPLOY-VERCEL.md — which is what actually has to work on a real deploy.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { env } from '@d7/config';
import { createEphemeralDb, type Db } from '@d7/database';
import type { FastifyInstance } from 'fastify';
import {
  ApiError,
  buildServer,
  createHandler,
  cronTokenMatches,
  JOB_NAMES,
  lockNameFor,
  resolveRequestPath,
  resolveStreamDelivery,
} from '@d7/api';

let db: Db;
let app: FastifyInstance;
let socket: ReturnType<typeof createServer>;
let base = '';

beforeAll(async () => {
  db = await createEphemeralDb();
  const built = await buildServer({ db, headless: true, skipMigrations: true, logLevel: 'warn' });
  app = built.app;
  // Not `app.inject`: the whole point of the bridge is Fastify's raw request listener, and inject
  // never goes through it (it also bypasses `resolveRequestPath`, which is where a rewrite bites).
  socket = createServer(async (req, res) => {
    await createHandler(app)(req, res);
  });
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  base = `http://127.0.0.1:${(socket.address() as AddressInfo).port}`;
}, 180_000);

afterAll(async () => {
  socket?.close();
  await app?.close();
});

/* ------------------------------- the bridge ------------------------------- */

describe('vercel bridge', () => {
  it('serves a real route over a real socket', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; checks: { database: { driver: string } } };
    expect(body.status).toBe('ok');
    expect(body.checks.database.driver).toBe('pglite');
  });

  it('keeps method and query intact for a normal request', async () => {
    const res = await fetch(`${base}/api/version`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; node: string };
    expect(body.name).toBe('d7music-api');
    expect(body.node).toBe(process.version);
  });

  it('recovers the route when the rewrite replaced the path with the function name', async () => {
    // Exactly what a runtime that hands the function `/api/index` looks like. `__d7path` is the
    // documented escape-hatch destination; the marker must not survive into the app's query.
    const res = await fetch(`${base}/api/index?__d7path=/api/health&limit=5`);
    expect(res.status).toBe(200);
    const health = (await res.json()) as { status: string };
    expect(health.status).toBe('ok');
  });

  it('answers with a diagnosable 404 when no candidate matches a served prefix', async () => {
    const res = await fetch(`${base}/index.html`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; candidates: string[] } };
    expect(body.error.code).toBe('ROUTE_NOT_MOUNTED');
    expect(body.error.candidates).toContain('/index.html');
  });

  it('resolves paths from the headers Vercel sets, in trust order', () => {
    const req = (url: string, headers: Record<string, string> = {}) =>
      ({ url, headers }) as unknown as IncomingMessage;

    expect(resolveRequestPath(req('/api/home?x=1')).path).toBe('/api/home?x=1');
    expect(resolveRequestPath(req('/api/index', { 'x-matched-path': '/api/search' })).path).toBe('/api/search');
    expect(resolveRequestPath(req('/api/index?__d7path=/media/cover/a.jpg')).path).toBe('/media/cover/a.jpg');
    // The marker is plumbing: a path that came from a header keeps the real query, minus __d7path.
    expect(resolveRequestPath(req('/api/index?__d7path=/api/x&q=beatles', { 'x-original-url': '/api/y' })).path).toBe(
      '/api/y?q=beatles',
    );
    // Nothing usable: the un-matched path is returned so the caller can report it, not invent one.
    const lost = resolveRequestPath(req('/nothing/here'));
    expect(lost.path).toBe('/nothing/here');
    expect(lost.candidates).toEqual(['/nothing/here']);
  });
});

/* ------------------------------- the cron gate ------------------------------- */

describe('cron token gate', () => {
  const SECRET = 'correct horse battery staple';
  it('accepts only an exact bearer token', () => {
    expect(cronTokenMatches(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(cronTokenMatches(`Bearer  ${SECRET}  `, SECRET)).toBe(true);
    expect(cronTokenMatches(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(cronTokenMatches(`Bearer short`, SECRET)).toBe(false);
    expect(cronTokenMatches(SECRET, SECRET)).toBe(false);
    expect(cronTokenMatches(`Basic ${SECRET}`, SECRET)).toBe(false);
    expect(cronTokenMatches(undefined, SECRET)).toBe(false);
    expect(cronTokenMatches('', SECRET)).toBe(false);
  });
  it('rejects everything when no secret is configured — the gate is the config, not the header', () => {
    expect(cronTokenMatches('Bearer ', '')).toBe(false);
    expect(cronTokenMatches(undefined, '')).toBe(false);
  });
});

describe('/api/jobs', () => {
  it('is closed unless the deployment opts in, and closed before it even reads the job name', async () => {
    const withoutSecret = env.CRON_SECRET ? 401 : 501;
    for (const url of ['/api/jobs/release-sync', '/api/jobs/not-a-job']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(withoutSecret);
      const body = res.json<{ error: { code: string } }>();
      expect(body.error.code).toBe(env.CRON_SECRET ? 'UNAUTHENTICATED' : 'CRON_NOT_CONFIGURED');
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('accepts the GET a scheduler issues and the POST an operator issues', async () => {
    const get = await app.inject({ method: 'GET', url: '/api/jobs/trending' });
    const post = await app.inject({ method: 'POST', url: '/api/jobs/trending' });
    expect(get.statusCode).toBe(post.statusCode);
    // Both verbs are routed: a 405 from either would mean Vercel Cron can never reach it.
    expect(get.statusCode).not.toBe(405);
  });
});

describe('job locks', () => {
  it('shares the scheduler\'s lock name for release-sync and namespaces the rest', () => {
    // If this drifts, a cron run and a worker tick stop contending and start duplicating work.
    expect(lockNameFor('release-sync')).toBe('release-sync');
    expect(['recommendations', 'reindex', 'trending', 'queue-drain'].map((j) => lockNameFor(j as never))).toEqual([
      'job:recommendations',
      'job:reindex',
      'job:trending',
      'job:queue-drain',
    ]);
    expect(new Set(JOB_NAMES.map(lockNameFor)).size).toBe(JOB_NAMES.length);
  });
});

/* ------------------------------ stream delivery ------------------------------ */

describe('resolveStreamDelivery', () => {
  it('proxies unless a redirect was asked for', () => {
    expect(resolveStreamDelivery({ enabled: false, url: 'https://cdn.example/a', apiBaseUrl: 'https://api.example' })).toEqual({
      mode: 'proxy',
    });
    expect(resolveStreamDelivery({ enabled: true, url: null, apiBaseUrl: 'https://api.example' })).toEqual({ mode: 'proxy' });
  });

  it('refuses to redirect to itself — the local driver signs URLs on its own origin', () => {
    expect(
      resolveStreamDelivery({
        enabled: true,
        url: 'https://d7.example.com/api/stream/t.flac',
        apiBaseUrl: 'https://d7.example.com',
      }),
    ).toEqual({ mode: 'proxy' });
    expect(
      resolveStreamDelivery({ enabled: true, url: '/cdn/t.flac', apiBaseUrl: 'https://d7.example.com' }),
    ).toEqual({ mode: 'proxy' });
  });

  it('redirects when the object lives on another origin, and hands over the presigned URL untouched', () => {
    const presigned = 'https://bucket.s3.eu-north-1.amazonaws.com/t.flac?X-Amz-Signature=abc%2B1';
    expect(resolveStreamDelivery({ enabled: true, url: presigned, apiBaseUrl: 'https://d7.example.com' })).toEqual({
      mode: 'redirect',
      url: presigned,
    });
  });

  it('never redirects to a non-http scheme and never throws on junk', () => {
    expect(resolveStreamDelivery({ enabled: true, url: 'javascript:alert(1)', apiBaseUrl: 'https://a.example' })).toEqual({
      mode: 'proxy',
    });
    expect(resolveStreamDelivery({ enabled: true, url: 'https://b.example/x', apiBaseUrl: 'not a url' })).toEqual({
      mode: 'proxy',
    });
  });
});

/* ------------------------------ error envelope ------------------------------ */

describe('ApiError contract used by the job route', () => {
  it('carries the status the route wants the scheduler to see', () => {
    const err = new ApiError(501, 'CRON_NOT_CONFIGURED', 'nope');
    expect(err.statusCode).toBe(501);
    expect(err.code).toBe('CRON_NOT_CONFIGURED');
  });
});
