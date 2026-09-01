/**
 * Playback telemetry + queue resume (spec §10).
 *
 * The client batches events; this endpoint is the only writer. Everything downstream
 * (trending, recommendations, listening history, resume) is derived from these rows, so
 * validation is strict about the basics (track exists, position within duration) and forgiving
 * about the rest — a dropped heartbeat must never break playback.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '@d7/config';
import {
  getQueueSnapshot,
  getResumeState,
  ingestPlaybackEvents,
  listListeningHistory,
  listTracksByIds,
  saveQueueSnapshot,
  topTrackIdsByPlays,
} from '@d7/database';
import type { PlaybackContext, PlaybackEvent } from '@d7/types';
import { ApiError, guardRate, idSchema, intField, parseBody } from '../lib/http.js';
import { hydrateTracks } from '../lib/media.js';

const eventSchema = z.object({
  type: z.enum(['track_started', 'track_completed', 'track_skipped', 'track_replayed', 'track_liked', 'track_unliked', 'track_added_to_playlist', 'progress_heartbeat']),
  trackId: idSchema,
  context: z.record(z.string(), z.unknown()).optional(),
  positionMs: z.number().int().min(0).max(24 * 3600_000),
  durationMs: z.number().int().min(0).max(24 * 3600_000),
  occurredAt: z.string().datetime({ offset: true }).or(z.string().min(4)).optional(),
  shuffle: z.boolean().optional(),
  repeat: z.enum(['off', 'all', 'one']).optional(),
  source: z.string().max(60).optional(),
});

const batchSchema = z.object({
  events: z.array(eventSchema).max(100).min(1, 'Send at least one event.'),
  anonymousId: z.string().max(80).optional(),
  device: z.string().max(40).optional(),
});

export default async function playbackRoutes(app: FastifyInstance) {
  const db = () => app.d7.db;

  app.post('/api/playback/events', async (request, reply) => {
    const body = parseBody(batchSchema, request.body);
    await guardRate(app, request, reply, {
      bucket: 'playback:events',
      limit: env.RATE_LIMIT_PLAYBACK,
      message: 'Playback events are arriving faster than we can accept them.',
    });
    const user = await request.optionalUser();
    const known = new Set(
      (await db().query<{ id: string }>(`SELECT id FROM tracks WHERE id = ANY($1::uuid[])`, [[...new Set(body.events.map((e) => e.trackId))]])).map((r) => String(r.id)),
    );
    const events: PlaybackEvent[] = body.events
      .filter((e) => known.has(e.trackId))
      .map((e) => ({
        type: e.type,
        trackId: e.trackId,
        context: normalizeContext(e.context),
        positionMs: e.positionMs,
        durationMs: e.durationMs,
        occurredAt: e.occurredAt ?? new Date().toISOString(),
        shuffle: Boolean(e.shuffle),
        repeat: e.repeat ?? 'off',
        source: e.source ?? 'web',
      }));
    const dropped = body.events.length - events.length;
    const result = await ingestPlaybackEvents(db(), events, {
      userId: user?.id ?? null,
      anonymousId: user ? null : body.anonymousId ?? null,
      device: body.device ?? (request.headers['user-agent']?.includes('Mozilla') ? 'browser' : 'other'),
    });
    if (dropped) app.d7.log.debug('playback events dropped', { dropped, reason: 'unknown track id' });
    return { ...result, droppedUnknownTracks: dropped };
  });

  app.get('/api/playback/resume', async (request) => {
    const user = await request.requireUser();
    const state = await getResumeState(db(), user.id);
    if (!state) return { resume: null };
    const tracks = await hydrateTracks(app, await listTracksByIds(db(), [state.trackId], { viewerId: user.id }), user);
    return { resume: state, track: tracks[0] ?? null };
  });

  app.get('/api/playback/queue', async (request) => {
    const user = await request.requireUser();
    const snap = await getQueueSnapshot(db(), user.id);
    if (!snap) return { queue: null };
    const tracks = await hydrateTracks(app, await listTracksByIds(db(), snap.trackIds, { viewerId: user.id }), user);
    return { queue: { ...snap, tracks }, missingTrackIds: snap.trackIds.filter((id) => !tracks.some((t) => t.id === id)) };
  });

  app.put('/api/playback/queue', async (request) => {
    const user = await request.requireUser();
    const body = parseBody(
      z.object({
        contextType: z.enum(['album', 'playlist', 'artist', 'liked', 'search', 'radio', 'assistant', 'mood', 'mix']).default('mix'),
        contextId: z.string().max(64).nullable().optional(),
        trackIds: z.array(idSchema).max(1000),
        index: z.number().int().min(0).default(0),
        positionMs: z.number().int().min(0).max(24 * 3600_000).default(0),
        shuffle: z.boolean().default(false),
        repeatMode: z.enum(['off', 'all', 'one']).default('off'),
      }),
      request.body,
    );
    await saveQueueSnapshot(db(), user.id, {
      contextType: body.contextType,
      contextId: body.contextId ?? null,
      trackIds: body.trackIds,
      index: Math.min(body.index, Math.max(0, body.trackIds.length - 1)),
      positionMs: body.positionMs,
      shuffle: body.shuffle,
      repeatMode: body.repeatMode,
    });
    return { saved: true, length: body.trackIds.length };
  });

  app.get('/api/playback/history', async (request) => {
    const user = await request.requireUser();
    const limit = intField((request.query as { limit?: string }).limit, 25, 1, 100);
    const offset = intField((request.query as { offset?: string }).offset, 0, 0, 5000);
    const [items, total] = await Promise.all([
      listListeningHistory(db(), user.id, { limit, offset }),
      db().queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM listening_history WHERE user_id = $1::uuid`, [user.id]),
    ]);
    return { items, total: Number(total?.c ?? 0), limit, offset, hasMore: offset + items.length < Number(total?.c ?? 0) };
  });

  /** Right-to-be-forgotten for your own history (admin-driven account deletion covers the rest). */
  app.delete('/api/playback/history', async (request) => {
    const user = await request.requireUser();
    const before = (request.query as { before?: string }).before;
    const params: unknown[] = [user.id];
    let sql = `DELETE FROM listening_history WHERE user_id = $1::uuid`;
    if (before) {
      params.push(before);
      sql += ` AND last_played < $${params.length}::timestamptz`;
    }
    const removed = await db().execute(sql, params);
    await db().execute(`DELETE FROM recently_played WHERE user_id = $1::uuid`, [user.id]);
    app.d7.log.info('listening history cleared', { userId: user.id, removed, before: before ?? 'all' });
    return { removed };
  });

  /** "Because you played X often" — used by the home fallback and radio seeding. */
  app.get('/api/playback/heavy-rotation', async (request) => {
    const user = await request.optionalUser();
    const limit = intField((request.query as { limit?: string }).limit, 10, 3, 30);
    const days = 28;
    const ids = await topTrackIdsByPlays(db(), { days, limit, excludeIds: [] });
    const tracks = await hydrateTracks(app, await listTracksByIds(db(), ids, { viewerId: user?.id ?? null }), user);
    // `topTrackIdsByPlays` answers the ordering; per-track counts are already on the
    // listening-history projection, so this route does not duplicate that aggregation.
    return { tracks, days, orderedBy: 'playback_events in the last 28 days' };
  });
}

/**
 * The client sends a tagged context object; anything unrecognisable degrades to `unknown`
 * rather than being rejected, because losing context is better than losing the play count.
 */
function normalizeContext(raw: Record<string, unknown> | undefined): PlaybackContext {
  const type = String(raw?.type ?? 'unknown');
  const id = raw?.id !== undefined && raw?.id !== null ? String(raw.id) : undefined;
  switch (type) {
    case 'album':
      return id ? { type: 'album', id } : { type: 'unknown' };
    case 'playlist':
      return id ? { type: 'playlist', id } : { type: 'unknown' };
    case 'artist':
      return id ? { type: 'artist', id } : { type: 'unknown' };
    case 'liked':
      return { type: 'liked' };
    case 'search':
      return { type: 'search', query: String(raw?.query ?? '') };
    case 'radio':
      return raw?.seedTrackId ? { type: 'radio', seedTrackId: String(raw.seedTrackId) } : { type: 'unknown' };
    case 'assistant':
      return raw?.conversationId ? { type: 'assistant', conversationId: String(raw.conversationId) } : { type: 'unknown' };
    case 'mix':
      return { type: 'mix', id: id ?? 'default' };
    default:
      return { type: 'unknown' };
  }
}

export function _testOnlyNormalizeContext(raw: unknown) {
  return normalizeContext(raw as Record<string, unknown>);
}
