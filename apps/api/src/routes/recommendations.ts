/**
 * Recommendations + radio + new releases (spec §6, §7).
 *
 * Results are served from the persisted `recommendations` table when fresh and recomputed
 * inline when stale, so a first visit after a sync never shows an empty shelf.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '@d7/config';
import { getAlbumById, listAlbumsByIds, listLatestAlbums, listTracksByIds, queryNewReleases } from '@d7/database';
import { ApiError, cachedJson, guardRate, idSchema, intField, parseBody } from '../lib/http.js';
import { allowExplicitFor, hydrateTracks } from '../lib/media.js';

export default async function recommendationsRoutes(app: FastifyInstance) {
  const db = () => app.d7.db;

  app.get('/api/recommendations', async (request, reply) => {
    const query = request.query as { limit?: string; seedTrackId?: string; refresh?: string };
    const user = await request.optionalUser();
    const limit = intField(query.limit, 20, 4, 50);
    await guardRate(app, request, reply, { bucket: 'recommendations', limit: env.RATE_LIMIT_SEARCH });

    if (query.seedTrackId) {
      const { id } = parseBody(z.object({ id: idSchema }), { id: query.seedTrackId });
      const items = await app.d7.recommendations.similarTo(db(), id, { limit, viewerId: user?.id ?? null });
      const tracks = await hydrateTracks(app, items.map((i) => i.track), user);
      const byId = new Map(tracks.map((t) => [t.id, t]));
      return {
        mode: 'similar_tracks' as const,
        seedTrackId: id,
        items: items.map((i) => ({ ...i, track: byId.get(i.track.id) ?? i.track })),
        generatedAt: new Date().toISOString(),
        stale: false,
      };
    }

    const payload = await cachedJson(
      app,
      'recommendations',
      [user?.id ?? 'anon', limit],
      120,
      async () => {
        const { items, mode, signals } = await app.d7.recommendations.forUser(db(), user?.id ?? null, { limit });
        const hydrated = await hydrateTracks(app, items.map((i) => i.track), user);
        const byId = new Map(hydrated.map((t) => [t.id, t]));
        return {
          mode,
          items: items.map((i) => ({ ...i, track: byId.get(i.track.id) ?? i.track })),
          signals,
          generatedAt: new Date().toISOString(),
          stale: false,
        };
      },
    );
    const allow = allowExplicitFor(user);
    return { ...payload, items: allow ? payload.items : payload.items.filter((i: { track: { explicit: boolean } }) => !i.track.explicit) };
  });

  /** Force a recompute for this user (also what the CLI job does for a batch of users). */
  app.post('/api/recommendations/refresh', async (request, reply) => {
    const user = await request.requireUser();
    await guardRate(app, request, reply, { bucket: 'rec:refresh', limit: 6, message: 'Recomputing recommendations is expensive — wait a minute.', windowSec: 600 });
    const result = await app.d7.recommendations.computeAndPersist(db(), { userIds: [user.id], limit: intField((request.body as { limit?: number } | null)?.limit, 24, 4, 50) });
    return { ok: true, ...result };
  });

  app.get('/api/recommendations/signals', async (request) => {
    const user = await request.requireUser();
    const signals = await app.d7.recommendations.signals(db(), user.id);
    return { signals, engine: app.d7.recommendations.name };
  });

  /* --------------------------------- releases --------------------------------- */

  app.get('/api/releases/new', async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const user = await request.optionalUser();
    const window = (['today', 'week', 'month', 'all'].includes(String(query.window)) ? String(query.window) : 'week') as 'today' | 'week' | 'month' | 'all';
    const scope = (['all', 'following', 'for_you'].includes(String(query.scope)) ? String(query.scope) : 'all') as 'all' | 'following' | 'for_you';
    if (scope !== 'all' && !user) throw ApiError.unauthorized('Sign in to see releases from artists you follow.');
    const result = await queryNewReleases(db(), {
      window,
      scope,
      genre: query.genre,
      artistId: query.artistId,
      limit: intField(query.limit, 24, 1, 60),
      offset: intField(query.offset, 0, 0, 500),
      viewerId: user?.id ?? null,
    });
    return {
      window,
      scope,
      releases: result.releases,
      counts: result.counts,
      followedArtists: user ? await db().queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM followed_artists WHERE user_id = $1::uuid`, [user.id]).then((r) => Number(r?.c ?? 0)) : 0,
    };
  });

  /** Recently *added* albums — the distinction the sync run summary also reports. */
  app.get('/api/releases/added', async (request) => {
    const days = intField((request.query as { days?: string }).days, 14, 1, 90);
    const limit = intField((request.query as { limit?: string }).limit, 24, 1, 60);
    const albums = await listLatestAlbums(db(), { days, limit });
    return { days, albums };
  });

  /** Preview of what the next sync run would insert (also what `jobs/release-sync --dry-run` shows). */
  app.get('/api/releases/preview', async (request) => {
    const user = await request.optionalUser();
    const limit = intField((request.query as { limit?: string }).limit, 12, 1, 30);
    return cachedJson(app, 'releases-preview', [user?.id ?? 'anon', limit], 120, async () => {
      const result = await queryNewReleases(db(), { window: 'week', scope: 'all', limit, offset: 0, viewerId: user?.id ?? null });
      const ids = result.releases.slice(0, 3).map((r) => r.album.id);
      const albums = await listAlbumsByIds(db(), ids);
      const withTracks = await Promise.all(
        albums.map(async (album) => ({
          album,
          tracks: await hydrateTracks(app, await listTracksByIds(db(), album.trackIds.slice(0, 1), { allowUnlicensed: false }), null),
        })),
      );
      return {
        window: 'week',
        total: result.releases.length,
        releases: result.releases,
        previews: withTracks.map((w) => ({ albumId: w.album.id, previewTrack: w.tracks[0] ?? null })),
      };
    });
  });

  /** An artist's newest release, for the "New release from X" banner on the artist page. */
  app.get('/api/releases/latest-for-artist/:artistId', async (request) => {
    const { artistId } = parseBody(z.object({ artistId: idSchema }), request.params as { artistId: string });
    const albums = await listLatestAlbums(db(), { days: 365, limit: 20, artistIds: [artistId] });
    const album = albums[0];
    if (!album) return { album: null };
    const full = await getAlbumById(db(), album.id);
    return { album: full, tracks: await hydrateTracks(app, await listTracksByIds(db(), (full?.trackIds ?? []).slice(0, 5)), null) };
  });
}
