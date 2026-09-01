/**
 * HTTP plumbing shared by every route: one error envelope, zod validation helpers,
 * paged results, and a small cache-through helper.
 */
import type { FastifyError, FastifyReply, FastifyInstance, FastifyRequest } from 'fastify';
import { z, type ZodType } from 'zod';
import { env } from '@d7/config';
import { ProviderError, ProviderNotConfiguredError } from '@d7/music-providers';
import { takeRate } from '@d7/database';
import type { Paged } from '@d7/types';

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    /** Field-level problems for forms (signup, upload, assistant). */
    details?: { path: string; message: string }[];
    requestId?: string;
    retryAfterSec?: number;
  };
}

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: { path: string; message: string }[],
  ) {
    super(message);
  }
  static badRequest(message: string, details?: ApiErrorBody['error']['details']) {
    return new ApiError(400, 'BAD_REQUEST', message, details);
  }
  static validation(issues: { path: string; message: string }[]) {
    return new ApiError(422, 'VALIDATION_FAILED', 'Some fields need attention.', issues);
  }
  static unauthorized(message = 'Sign in to continue.') {
    return new ApiError(401, 'UNAUTHENTICATED', message);
  }
  static forbidden(message = 'You do not have access to this resource.', code = 'FORBIDDEN') {
    return new ApiError(403, code, message);
  }
  static notFound(what = 'Resource') {
    return new ApiError(404, 'NOT_FOUND', `${what} could not be found.`);
  }
  static conflict(message: string, code = 'CONFLICT') {
    return new ApiError(409, code, message);
  }
  static tooMany(message: string, retryAfterSec: number) {
    return new ApiError(429, 'RATE_LIMITED', message, [{ path: '', message: `Try again in ${retryAfterSec}s.` }]);
  }
  static payload(too: string) {
    return new ApiError(413, 'PAYLOAD_TOO_LARGE', too);
  }
}

export function parseBody<S extends ZodType>(schema: S, data: unknown): z.infer<S> {
  const res = schema.safeParse(data ?? {});
  if (!res.success) {
    throw ApiError.validation(
      res.error.issues.map((i) => ({ path: i.path.map(String).join('.') || '(root)', message: i.message })),
    );
  }
  return res.data as z.infer<S>;
}

export const idSchema = z.string().uuid('That identifier is not valid.');
export const slugSchema = z.string().min(2).max(160);

export function intField(raw: unknown, def: number, min: number, max: number): number {
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : typeof raw === 'number' ? raw : Number.NaN;
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export function boolField(raw: unknown): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = String(raw).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return undefined;
}

export function listField(raw: unknown): string[] {
  if (raw === undefined) return [];
  const arr = Array.isArray(raw) ? raw : String(raw).split(',');
  return arr.map((v) => String(v).trim()).filter(Boolean).slice(0, 40);
}

export function paged<T>(items: T[], total: number, limit: number, offset: number): Paged<T> {
  return { items, total, limit, offset, hasMore: offset + items.length < total };
}

/**
 * Rate-limit helper used by credential, AI, upload and telemetry endpoints.
 * Keyed by user id when signed in, client IP otherwise, and always answered with
 * standard `ratelimit-*` headers so the web client can show a countdown.
 */
export async function guardRate(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  input: { bucket: string; limit: number; windowSec?: number; message?: string },
) {
  const windowSec = input.windowSec ?? 60;
  const actor = request.user?.id ?? request.ip;
  if (env.RATE_LIMIT_DISABLED) {
    reply.header('x-ratelimit-limit', String(input.limit));
    reply.header('x-ratelimit-remaining', 'unlimited');
    return;
  }
  const decision = await takeRate(app.d7.db, { bucket: input.bucket, actor, limit: input.limit, windowSec });
  reply.header('x-ratelimit-limit', String(input.limit));
  reply.header('x-ratelimit-remaining', String(decision.remaining));
  reply.header('x-ratelimit-reset', String(windowSec));
  if (!decision.allowed) {
    reply.header('retry-after', String(decision.retryAfterSec));
    throw ApiError.tooMany(input.message ?? 'Too many requests — take a breath and try again.', decision.retryAfterSec);
  }
}

/**
 * Cache-through helper. Keys embed the catalog version and the viewer, so a sync or an
 * admin edit invalidates home/search pages without any explicit purge list.
 */
export async function cachedJson<T>(app: FastifyInstance, scope: string, parts: (string | number | null | undefined)[], ttlSec: number, produce: () => Promise<T>): Promise<T> {
  const cache = app.d7.cache;
  const version = await app.d7.catalogVersion().catch(() => 0);
  const key = [scope, version, ...parts].map((v) => (v === undefined || v === null || v === '' ? '-' : String(v))).join(':');
  const hit = await cache.get<{ value: T }>(`http:${key}`);
  if (hit) return hit.value;
  const value = await produce();
  await cache.set(`http:${key}`, { value }, ttlSec).catch(() => undefined);
  return value;
}

export function installErrorHandler(app: FastifyInstance) {
  app.setErrorHandler(async (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const body = envelopeFor(error, request.id);
    const status = body.error.code === 'PROVIDER_UNAVAILABLE' ? 502 : body.error.code === 'PROVIDER_RATE_LIMIT' ? 429 : error.statusCode ?? 500;
    if (status >= 500) app.d7.log.error('request failed', { url: request.url, method: request.method, message: error.message, stack: error.stack?.split('\n').slice(0, 4).join(' | ') });
    else if (status === 429) reply.header('retry-after', String(body.error.retryAfterSec ?? 30));
    if (status === 401 && request.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
    return reply.code(status).send(body);
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send(envelopeFor(new ApiError(404, 'NOT_FOUND', `No API route for ${request.method} ${request.url}`), request.id));
    }
    return reply.code(404).send(envelopeFor(new ApiError(404, 'NOT_FOUND', 'Not found'), request.id));
  });
}

export function envelopeFor(error: FastifyError | ApiError | Error, requestId?: string): ApiErrorBody {
  if (error instanceof ApiError) {
    return { error: { code: error.code, message: error.message, details: error.details, requestId } };
  }
  const anyErr = error as FastifyError & { code?: string; statusCode?: number };
  if (anyErr.code === 'FST_ERR_VALIDATION' || anyErr.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
    return { error: { code: 'BAD_REQUEST', message: 'The request could not be parsed.', requestId } };
  }
  if (anyErr.code === 'FST_REQ_FILE_TOO_LARGE' || anyErr.code === 'FST_MULTIPART_FIELD_TOO_LARGE' || anyErr.statusCode === 413) {
    return { error: { code: 'PAYLOAD_TOO_LARGE', message: 'That file is larger than this server accepts.', requestId } };
  }
  if (error instanceof ProviderNotConfiguredError) {
    return { error: { code: 'PROVIDER_NOT_CONFIGURED', message: error.message, requestId } };
  }
  if (error instanceof ProviderError) {
    if (error.status === 429) return { error: { code: 'PROVIDER_RATE_LIMIT', message: error.message, retryAfterSec: 30, requestId } };
    return { error: { code: error.retryable ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_ERROR', message: error.message, requestId } };
  }
  const code = anyErr.code && /^[A-Z_]+$/.test(anyErr.code) ? anyErr.code : 'INTERNAL_ERROR';
  const status = anyErr.statusCode ?? 500;
  if (status < 500) return { error: { code, message: error.message, requestId } };
  // Never leak internals for 5xx.
  return { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side. The error has been logged.', requestId } };
}
