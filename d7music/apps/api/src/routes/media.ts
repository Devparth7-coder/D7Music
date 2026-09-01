/**
 * Media delivery (spec §12): public artwork, signed downloads, and the range-capable audio
 * stream that the <audio> element actually points at.
 *
 * Three paths, three policies:
 *   /media/*   public, images only, long-lived cache headers (artwork is derivative metadata)
 *   /cdn/*     signature required (exp + sig), any object — used for downloads
 *   /api/stream  signature bound to the requesting user, audio only, supports Range
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { extname } from 'node:path';
import { verifyStreamToken } from '@d7/audio-storage';
import { env } from '@d7/config';
import { getTrackForStreaming } from '@d7/database';
import { ApiError } from '../lib/http.js';

const IMAGE_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
};

const AUDIO_TYPES: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
};

function safeKey(raw: string) {
  const key = decodeURIComponent(raw).replace(/^\/+/, '');
  if (!key || key.includes('\0') || key.includes('..')) throw ApiError.forbidden('That media path is not valid.', 'BAD_MEDIA_KEY');
  return key;
}

/**
 * Decide how to hand the client the bytes.
 *
 * A serverless function that streams a 4 MB file is a function that spends its whole allowance on
 * one request, so when the driver can presign a URL on *another* origin we 302 to it instead. The
 * local driver's "signed" URL points back at this same API (`publicBase`), and redirecting to
 * ourselves would loop — hence the origin comparison rather than a `supportsPresign` check.
 */
export function resolveStreamDelivery(input: {
  enabled: boolean;
  url: string | null | undefined;
  apiBaseUrl: string;
}): { mode: 'redirect'; url: string } | { mode: 'proxy' } {
  if (!input.enabled || !input.url) return { mode: 'proxy' };
  try {
    const target = new URL(input.url, input.apiBaseUrl);
    const self = new URL(input.apiBaseUrl);
    if (target.origin === self.origin) return { mode: 'proxy' };
    if (target.protocol !== 'https:' && target.protocol !== 'http:') return { mode: 'proxy' };
    return { mode: 'redirect', url: target.toString() };
  } catch {
    return { mode: 'proxy' };
  }
}

export default async function mediaRoutes(app: FastifyInstance) {
  /* ------------------------------ public artwork ------------------------------ */

  app.get('/media/*', async (request: FastifyRequest, reply: FastifyReply) => {
    const key = safeKey(String((request.params as { '*': string })['*'] ?? ''));
    const ext = extname(key).toLowerCase();
    const contentType = IMAGE_TYPES[ext];
    // Deliberately image-only: audio must never be reachable without a signed, expiring URL.
    if (!contentType || !key.startsWith('artwork/')) throw ApiError.notFound('Media');
    const stat = await app.d7.storage.stat(key);
    if (!stat) throw ApiError.notFound('Media');
    const stream = await app.d7.storage.open(key, { start: 0 });
    reply.header('content-type', stat.contentType ?? contentType);
    reply.header('cache-control', 'public, max-age=604800, immutable');
    reply.header('content-length', String(stat.bytes));
    reply.header('x-content-type-options', 'nosniff');
    return reply.send(stream);
  });

  /* ---------------------------- signed downloads ---------------------------- */

  app.get('/cdn/*', async (request, reply) => {
    const query = request.query as { exp?: string; sig?: string };
    const key = safeKey(String((request.params as { '*': string })['*'] ?? ''));
    const exp = Number(query.exp ?? 0);
    const userId = (await request.optionalUser())?.id ?? null;
    // The local driver signs `key|exp|userId`; a CDN in front would use its own signing.
    const ok = verifyStreamToken(env.APP_SECRET, key, exp, null, String(query.sig ?? '')) || verifyStreamToken(env.APP_SECRET, key, exp, userId, String(query.sig ?? ''));
    if (!ok) throw new ApiError(403, 'BAD_SIGNATURE', 'That media link has expired or was tampered with.');
    const stat = await app.d7.storage.stat(key);
    if (!stat) throw ApiError.notFound('Media');
    const ext = extname(key).toLowerCase();
    if ((request.query as { dl?: string }).dl) {
      const filename = String((request.query as { filename?: string }).filename ?? key.split('/').pop() ?? 'download').replace(/["\r\n]/g, '');
      reply.header('content-disposition', `attachment; filename="${filename}"`);
    }
    reply.header('content-type', stat.contentType ?? IMAGE_TYPES[ext] ?? AUDIO_TYPES[ext] ?? 'application/octet-stream');
    reply.header('content-length', String(stat.bytes));
    reply.header('accept-ranges', 'bytes');
    reply.header('cache-control', 'private, max-age=0, no-store');
    return reply.send(await app.d7.storage.open(key, { start: 0 }));
  });

  /* ------------------------------ audio streaming ------------------------------ */

  /**
   * Range requests are required for scrubbing: without `206` support the browser cannot seek
   * in a long file, and the player's progress bar lies to the user.
   */
  app.get('/api/stream/:key', async (request, reply) => {
    const query = request.query as { exp?: string; sig?: string; track?: string };
    const key = safeKey(String((request.params as { key: string }).key ?? ''));
    const user = await request.optionalUser();
    const exp = Number(query.exp ?? 0);
    const sig = String(query.sig ?? '');
    if (!verifyStreamToken(env.APP_SECRET, key, exp, user?.id ?? null, sig)) {
      throw new ApiError(403, 'BAD_SIGNATURE', 'This stream link is not valid for your account or has expired.');
    }
    // A stream URL is bound to the key AND, when issued for a user, to that user; also make sure
    // the object still belongs to a track we are allowed to serve (deletion / licence revocation).
    if (query.track) {
      const row = await getTrackForStreaming(app.d7.db, String(query.track));
      if (!row || row.storage_key !== key) throw new ApiError(403, 'TRACK_KEY_MISMATCH', 'This stream link does not match the requested track.');
      if (!row.streamable || (row.license_status !== 'licensed' && !env.ALLOW_UNLICENSED_STREAM)) {
        throw new ApiError(423, 'NOT_STREAMABLE', 'Playback for this track has been disabled.');
      }
    }
    if (env.STREAM_REDIRECT && app.d7.storage.supportsPresign) {
      const presigned = await app.d7.storage.getStreamUrl(key, {
        userId: user?.id ?? null,
        expiresSec: env.STREAM_URL_TTL_SEC,
      });
      const delivery = resolveStreamDelivery({ enabled: true, url: presigned, apiBaseUrl: env.API_PUBLIC_URL });
      if (delivery.mode === 'redirect') {
        // No body, so no byte limits; the bucket enforces the same expiry we would have.
        return reply.code(302).header('location', delivery.url).send();
      }
    }
    const stat = await app.d7.storage.stat(key);
    if (!stat) throw ApiError.notFound('Audio object');
    const ext = extname(key).toLowerCase();
    const type = AUDIO_TYPES[ext] ?? stat.contentType ?? 'application/octet-stream';

    const range = request.headers.range;
    reply.header('accept-ranges', 'bytes');
    reply.header('content-type', type);
    reply.header('cache-control', 'private, no-store');
    reply.header('x-content-type-options', 'nosniff');
    // Media Session / HLS-less players want the duration even before decoding starts.
    reply.header('x-audio-duration-ms', String(Number((request.query as { d?: string }).d ?? 0)));

    if (!range) {
      reply.header('content-length', String(stat.bytes));
      return reply.send(await app.d7.storage.open(key, { start: 0 }));
    }
    const parsed = parseRange(range, stat.bytes);
    if (!parsed) {
      reply.header('content-range', `bytes */${stat.bytes}`);
      return reply.code(416).send();
    }
    reply.code(206);
    reply.header('content-length', String(parsed.end - parsed.start + 1));
    reply.header('content-range', `bytes ${parsed.start}-${parsed.end}/${stat.bytes}`);
    return reply.send(await app.d7.storage.open(key, { start: parsed.start, end: parsed.end }));
  });
}

/** `bytes=0-`, `bytes=500-1000`, `bytes=-500` (suffix range). Clamped to the object size. */
export function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const rawStart = match[1] ?? '';
  const rawEnd = match[2] ?? '';
  if (rawStart === '' && rawEnd === '') return null;
  if (rawStart === '') {
    const suffix = Math.min(Number(rawEnd), size);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isFinite(start) || start < 0 || start > end || end >= size) return null;
  return { start, end };
}
