/**
 * Search routes (spec §5). Query logging, history and click attribution all happen here —
 * the ranking service reads those tables, so the API is the only place they should be written.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '@d7/config';
import { listFollowedArtistIds, logSearch } from '@d7/database';
import type { SearchEntityType } from '@d7/types';
import { ApiError, boolField, guardRate, idSchema, intField, listField, parseBody } from '../lib/http.js';
import { allowExplicitFor, applyExplicitFilter, hydrateTracks } from '../lib/media.js';

const TYPES: SearchEntityType[] = ['track', 'artist', 'album', 'playlist', 'genre'];

export default async function searchRoutes(app: FastifyInstance) {
  app.get('/api/search', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const q = String(query.q ?? query.query ?? '').trim().slice(0, 120);
    const user = await request.optionalUser();
    const limit = intField(query.limit, 24, 1, 60);
    const offset = intField(query.offset, 0, 0, 500);
    if (!q) {
      return {
        query: '',
        tookMs: 0,
        total: 0,
        offset,
        limit,
        topHit: null,
        tracks: [],
        artists: [],
        albums: [],
        playlists: [],
        genres: [],
        hint: 'Type at least one character. D7music searches titles, artists, albums, playlists and genres.',
      };
    }
    await guardRate(app, request, reply, { bucket: 'search', limit: env.RATE_LIMIT_SEARCH, message: 'Search is rate limited to keep the index warm for everyone.' });

    const types = listField(query.types).filter((t): t is SearchEntityType => (TYPES as string[]).includes(t));
    const filters = {
      types: types.length ? types : undefined,
      genres: listField(query.genres).length ? listField(query.genres) : undefined,
      explicit: boolField(query.explicit),
      hasAudio: boolField(query.hasAudio),
      releasedAfter: query.releasedAfter,
      releasedBefore: query.releasedBefore,
      minDurationMs: query.minDurationMs ? Number(query.minDurationMs) : undefined,
      maxDurationMs: query.maxDurationMs ? Number(query.maxDurationMs) : undefined,
    };

    const followed = user ? await listFollowedArtistIds(app.d7.db, user.id, 200) : [];
    const result = await app.d7.search.search({
      query: q,
      types: filters.types,
      filters,
      limit,
      offset,
      viewerId: user?.id ?? null,
      followedArtistIds: followed,
    });
    const tracks = await hydrateTracks(app, result.tracks, user);
    const allow = allowExplicitFor(user, boolField(query.explicit));

    void logSearch(app.d7.db, {
      userId: user?.id ?? null,
      query: q,
      results: result.total,
      filters: { types: filters.types?.join(',') ?? 'all', genres: filters.genres?.join(',') ?? null },
    }).catch((err) => app.d7.log.warn('search logging failed', { message: (err as Error).message }));

    reply.header('cache-control', 'private, max-age=5');
    return { ...result, tracks: applyExplicitFilter(tracks, allow), followedArtistBoost: followed.length };
  });

  app.get('/api/search/suggest', async (request) => {
    const q = String((request.query as { q?: string }).q ?? '').trim().slice(0, 60);
    if (q.length < 2) return { suggestions: [] };
    const user = await request.optionalUser();
    const limit = intField((request.query as { limit?: string }).limit, 8, 3, 12);
    const [suggestions, history] = await Promise.all([
      app.d7.search.suggest(q, limit),
      user ? recentHistory(app, user.id, q) : Promise.resolve([] as { text: string; type: 'recent'; subtitle: string; score: number }[]),
    ]);
    return { suggestions: [...history, ...suggestions].slice(0, limit) };
  });

  app.get('/api/search/history', async (request) => {
    const user = await request.requireUser();
    const items = await app.d7.search.history(user.id, intField((request.query as { limit?: string }).limit, 10, 1, 20));
    return { items };
  });

  app.delete('/api/search/history', async (request) => {
    const user = await request.requireUser();
    await app.d7.search.clearHistory(user.id);
    return { cleared: true };
  });

  /** Click-through logging: the ranking signal that makes "second result for this query" rise. */
  app.post('/api/search/click', async (request) => {
    const body = parseBody(
      z.object({ query: z.string().min(1).max(120), entityType: z.enum(TYPES), entityId: idSchema }),
      request.body,
    );
    await app.d7.search.clicked(body);
    return { ok: true };
  });

  app.get('/api/search/trending', async (request) => ({
    queries: await app.d7.search.trending(intField((request.query as { limit?: string }).limit, 8, 3, 12)),
  }));
}

async function recentHistory(app: FastifyInstance, userId: string, q: string) {
  try {
    const items = await app.d7.search.history(userId, 20);
    // `recent` chips carry no entity id: selecting one refines the query, it does not navigate.
    return items
      .filter((i) => i.text.toLowerCase().includes(q.toLowerCase()))
      .slice(0, 3)
      .map((i) => ({ text: i.text, type: 'recent' as const, subtitle: i.subtitle, score: i.score }));
  } catch {
    return [];
  }
}
