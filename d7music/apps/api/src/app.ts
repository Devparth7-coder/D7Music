/**
 * Fastify application factory.
 *
 * `buildServer()` takes an already-composed context, which is how the vitest suite boots the
 * real routes against a throwaway PGlite database — no mocked HTTP layer, no test-only branches
 * in the route files.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { env } from '@d7/config';
import { createContext, type AppContext, type CreateContextOptions } from './context.js';
import { sessionPlugin } from './plugins/session.js';
import { installErrorHandler } from './lib/http.js';
import healthRoutes from './routes/health.js';
import authRoutes from './routes/auth.js';
import homeRoutes from './routes/home.js';
import catalogRoutes from './routes/catalog.js';
import searchRoutes from './routes/search.js';
import playlistRoutes from './routes/playlists.js';
import playbackRoutes from './routes/playback.js';
import libraryRoutes from './routes/library.js';
import recommendationRoutes from './routes/recommendations.js';
import assistantRoutes from './routes/assistant.js';
import mediaRoutes from './routes/media.js';
import subscriptionRoutes from './routes/subscription.js';
import creatorRoutes from './routes/creator.js';
import adminRoutes from './routes/admin.js';
import jobRoutes from './routes/jobs.js';

export interface BuildServerOptions extends CreateContextOptions {
  context?: AppContext;
}

export async function buildServer(opts: BuildServerOptions = {}): Promise<{ app: FastifyInstance; context: AppContext }> {
  const context = opts.context ?? (await createContext(opts));

  const app = Fastify({
    logger: false,
    bodyLimit: 2 * 1024 * 1024,
    // Only parse X-Forwarded-For when we are actually behind a proxy: request.ip keys the
    // anonymous rate limiters, so trusting these headers by default lets a client forge an IP.
    trustProxy: env.TRUST_PROXY,
    disableRequestLogging: true,
  });

  // `app.d7` is declared on FastifyInstance by the session plugin's module augmentation.
  app.decorate('d7', context);

  await app.register(cors, {
    origin: corsOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'x-csrf-token', 'x-request-id'],
    exposedHeaders: ['x-request-id', 'x-ratelimit-remaining', 'x-ratelimit-limit', 'retry-after', 'accept-ranges', 'content-range'],
    maxAge: 600,
  });

  // `secret` enables signed cookies; our session value is a JWT and is verified again in the
  // plugin, so signing is belt-and-braces rather than the authority.
  await app.register(cookie, { secret: env.APP_SECRET });
  await app.register(multipart, {
    limits: { fileSize: env.UPLOAD_MAX_MB * 1024 * 1024, files: 1, fields: 30 },
    attachFieldsToBody: false,
  });

  // Keep the raw JSON text for signature verification without buffering everything else.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const raw = typeof body === 'string' ? body : String(body);
    (request as unknown as { rawBody?: string }).rawBody = raw;
    if (!raw) return done(null, undefined);
    try {
      done(null, JSON.parse(raw));
    } catch (err) {
      done(Object.assign(err as Error, { statusCode: 400 }));
    }
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    if (env.isDev) app.d7.log.debug(`${request.method} ${request.url}`, { ip: request.ip });
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    return payload;
  });

  installErrorHandler(app);
  await app.register(sessionPlugin);

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(homeRoutes);
  await app.register(catalogRoutes);
  await app.register(searchRoutes);
  await app.register(playlistRoutes);
  await app.register(playbackRoutes);
  await app.register(libraryRoutes);
  await app.register(recommendationRoutes);
  await app.register(assistantRoutes);
  await app.register(mediaRoutes);
  await app.register(subscriptionRoutes);
  await app.register(creatorRoutes);
  await app.register(adminRoutes);
  await app.register(jobRoutes);

  app.addHook('onClose', async () => {
    await context.close();
  });

  return { app, context };
}

/**
 * Cookies are used for auth, so `origin: true` is not acceptable: the browser must be told
 * exactly which site may send them, and the answer must be a concrete origin rather than a
 * wildcard. Live-preview hosts are allowed in dev so the sandbox proxy can talk to the API.
 */
export async function corsOrigin(origin: string | undefined): Promise<string | boolean> {
  if (!origin) return true; // same-origin/server-to-server: no CORS involved
  const normalized = origin.replace(/\/+$/, '');
  const allowed = new Set([env.WEB_ORIGIN, env.API_PUBLIC_URL, `http://localhost:${env.API_PORT}`, 'http://localhost:3000'].map((u) => String(u).replace(/\/+$/, '')));
  if (allowed.has(normalized)) return normalized;
  if (env.isDev && /^https?:\/\/[a-z0-9.-]+\.e2b\.app$/.test(normalized)) return normalized;
  return false;
}

export { createContext, type AppContext, type CreateContextOptions };
