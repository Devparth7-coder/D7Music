/**
 * Vercel (and any other Node `(req, res)` serverless runtime) entry point.
 *
 * The API is a normal Fastify server; a serverless function cannot `listen()`. Fastify already
 * exposes the request listener it would have handed to `http.createServer`, so the bridge is:
 * boot once per warm instance, then call `app.routing(req, res)`. Everything else here is the
 * bookkeeping a long-lived process gets for free — a ready latch, a poisoned-boot retry, and the
 * request path, which a rewrite to a single function may or may not preserve.
 */
import type { FastifyInstance } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildServer } from './app.js';
import { env } from '@d7/config';

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** Prefixes the app actually serves. Anything else is a routing-config mistake, not a 404. */
const KNOWN_PREFIXES = ['/api', '/media', '/cdn'] as const;

/**
 * Where our single function is mounted. These look like app routes but are the rewrite target, so
 * they must not outrank a header or `__d7path` that says where the request was really aimed —
 * `/api/index` starts with `/api/` and would otherwise be "trusted" into a Fastify 404.
 */
const FUNCTION_MOUNTS = new Set(['/api', '/api/', '/api/index', '/api/index/']);

function header(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.length ? value : undefined;
}

/**
 * Work out the path to route on.
 *
 * `rewrites` to a single function is how a framework-less Vercel project mounts a whole app, and
 * what `req.url` contains afterwards is the one thing that differs between runtimes — so the
 * candidates are tried in order of trust: the real URL, the path Vercel recorded for the rewrite,
 * then an explicit `__d7path` query arg a rewrite can carry. If none of them matches a prefix this
 * app serves, the request answers 404 *with the candidates in the message*, because a mis-mounted
 * deploy is otherwise indistinguishable from a broken router.
 */
export function resolveRequestPath(req: IncomingMessage): { path: string; candidates: string[] } {
  const raw = req.url ?? '/';
  const pathOnly = (u: string) => {
    const i = u.indexOf('?');
    return i === -1 ? u : u.slice(0, i);
  };
  const known = (u: string) =>
    !FUNCTION_MOUNTS.has(pathOnly(u)) && KNOWN_PREFIXES.some((p) => pathOnly(u) === p || pathOnly(u).startsWith(`${p}/`));
  const candidates = [
    raw,
    header(req, 'x-matched-path'),
    header(req, 'x-original-url'),
    header(req, 'x-invoke-path'),
    // Escape hatch for a runtime that replaces `req.url` with the rewrite destination: vercel.json
    // documents the alternative destination `"/api/index?__d7path=/$1"`, which carries the path here.
    queryOf(raw).get('__d7path') ? `/${queryOf(raw).get('__d7path')!.replace(/^\/+/, '')}` : undefined,
  ].filter((c): c is string => Boolean(c));

  const chosen = candidates.find(known) ?? pathOnly(raw);
  const own = chosen.includes('?') ? chosen.slice(chosen.indexOf('?')) : '';
  const fallbackQuery = (() => {
    const q = queryOf(raw);
    q.delete('__d7path');
    return q.toString();
  })();
  return { path: `${pathOnly(chosen)}${own || (fallbackQuery ? `?${fallbackQuery}` : '')}`, candidates };
}

const pathOnlyOf = (u: string) => {
  const i = u.indexOf('?');
  return i === -1 ? u : u.slice(0, i);
};

function queryOf(u: string): URLSearchParams {
  const i = u.indexOf('?');
  return new URLSearchParams(i === -1 ? '' : u.slice(i + 1));
}

/** Wrap an already-built app as a `(req, res)` function. Exported so tests can drive the real bridge. */
export function createHandler(app: FastifyInstance): Handler {
  // `ready()` resolves to the instance itself, so the latch is `Promise<unknown>`.
  let ready: Promise<unknown> | null = null;
  return async (req, res) => {
    // `ready()` returns the instance as a thenable, not a Promise — wrap it so a rejection cannot
    // leave an unresolved promise behind.
    ready ??= Promise.resolve(app.ready());
    try {
      await ready;
    } catch (err) {
      ready = null; // never poison a warm instance with a failed boot
      throw err;
    }
    const { path, candidates } = resolveRequestPath(req);
    if (!KNOWN_PREFIXES.some((p) => pathOnlyOf(path) === p || pathOnlyOf(path).startsWith(`${p}/`))) {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          error: {
            code: 'ROUTE_NOT_MOUNTED',
            message: `No request path candidate starts with ${KNOWN_PREFIXES.join(', ')}. Check the Vercel rewrites in vercel.json.`,
            candidates,
          },
        }),
      );
      return;
    }
    req.url = path;
    app.routing(req, res);
  };
}

let boot: Promise<{ app: FastifyInstance }> | null = null;

/**
 * One app per warm instance. Connections (Postgres pool, cache) stay open on purpose: a `close()`
 * per request would put a TCP handshake and a schema check on every API call. Idle sockets are
 * reclaimed by the pool's `idleTimeoutMillis`, not by us.
 *
 * `headless` is what makes this safe to run at all: it keeps `createContext()` from arming its
 * `setInterval` scheduler and queue pump, which are the long-lived-process halves of the app. A
 * serverless isolate has no business owning them — Vercel Cron (`/api/jobs/*`) does instead, and
 * `RELEASE_SYNC_ENABLED` is ignored on this path by construction rather than by convention.
 */
export function getServer(): Promise<{ app: FastifyInstance }> {
  boot ??= buildServer({ logLevel: env.LOG_LEVEL, headless: true }).catch((err) => {
    boot = null;
    throw err;
  });
  return boot;
}

export function getHandler(): Promise<Handler> {
  return getServer().then(({ app }) => createHandler(app));
}

/** The function Vercel calls. */
export default async function vercelHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const handler = await getHandler();
    await handler(req, res);
  } catch (err) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (env.LOG_LEVEL === 'debug') console.error('[vercel] handler failed', err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: { code: 'BOOT_FAILED', message: (err as Error).message } }));
  }
}
