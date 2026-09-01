/**
 * Catalog surface: tracks, albums, artists, genres, lyrics, trending and "new".
 * Every response goes through the same projection, so a track object looks identical in
 * search results, a playlist, a shelf and `GET /api/tracks/:id`.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '@d7/config';
import {
  createContentReport,
  getAlbumById,
  getArtistById,
  getGenreBySlug,
  getLyrics,
  getTrackById,
  getTrackForStreaming,
  isFollowingArtist,
  listAlbumTracks,
  listArtistPopularTracks,
  listArtistReleases,
  listGenres,
  listLikedTrackIds,
  listNewTracks,
  listRelatedArtists,
  listTracksByIds,
  listTrendingTracks,
  listPopularArtists,
  setArtistFollow,
  setLikedAlbum,
  setLikedTrack,
  type Db,
} from '@d7/database';
import { ApiError, boolField, cachedJson, guardRate, idSchema, intField, parseBody, slugSchema } from '../lib/http.js';
import { allowExplicitFor, applyExplicitFilter, hydrateTracks, streamUrlFor } from '../lib/media.js';

const uuidList = (raw: unknown): string[] => {
  const parts = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  const ids = parts.map((v) => String(v).trim()).filter(Boolean);
  const parsed = ids.filter((id) => idSchema.safeParse(id).success);
  if (parsed.length !== ids.length) throw ApiError.badRequest('`ids` must be a comma-separated list of track ids.', [{ path: 'ids', message: 'One or more values are not uuids' }]);
  return parsed.slice(0, 200);
};

export default async function catalogRoutes(app: FastifyInstance) {
  const db = () => app.d7.db;

  /* --------------------------------- tracks --------------------------------- */

  /** Queue hydration: order-preserving bulk lookup, never a per-track request from the client. */
  app.get('/api/tracks', async (request) => {
    const query = request.query as { ids?: string | string[]; limit?: string };
    const user = await request.optionalUser();
    let ids = uuidList(query.ids);
    if (!ids.length) {
      // No ids → "your most recent plays", which is what the web app asks for on boot.
      const rows = user
        ? await db().query<{ track_id: string }>(
            `SELECT track_id FROM listening_history WHERE user_id = $1::uuid ORDER BY last_played_at DESC LIMIT $2`,
            [user.id, intField(query.limit, 25, 1, 50)],
          )
        : [];
      ids = rows.map((r) => String(r.track_id));
    }
    const tracks = await listTracksByIds(db(), ids, { viewerId: user?.id ?? null });
    return { tracks: await hydrateTracks(app, tracks, user) };
  });

  app.get('/api/tracks/:id', async (request) => {
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const user = await request.optionalUser();
    const track = await getTrackById(db(), id, user?.id ?? null);
    if (!track) throw ApiError.notFound('Track');
    const [hydrated] = await hydrateTracks(app, [track], user);
    const following = user ? await isFollowingArtist(db(), user.id, track.primaryArtistId) : false;
    return { track: hydrated, artistFollowed: Boolean(following), blocked: !hydrated?.audio ? reasonFor(track) : null };
  });

  /**
   * A signed playback URL, minted on demand. The player calls this when its cached URL is
   * close to expiry instead of re-fetching the whole track object.
   */
  app.get('/api/tracks/:id/stream', async (request, reply) => {
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const user = await request.optionalUser();
    const row = await getTrackForStreaming(db(), id);
    if (!row || row.status !== 'published') throw ApiError.notFound('Track');
    if (!row.streamable) throw new ApiError(423, 'NOT_STREAMABLE', 'This track is not available for streaming on D7music.');
    if (row.license_status !== 'licensed' && !env.ALLOW_UNLICENSED_STREAM) {
      throw new ApiError(423, 'LICENSE_PENDING', 'Playback is disabled while this track waits for licence review.');
    }
    if (!row.storage_key) throw new ApiError(409, 'NO_AUDIO', 'No audio object is stored for this track.');
    const url = await streamUrlFor(app, row.storage_key, user);
    if (boolField((request.query as { redirect?: string }).redirect)) return reply.redirect(url, 302);
    return { url, expiresAt: new Date(Date.now() + env.STREAM_URL_TTL_SEC * 1000).toISOString(), mimeType: row.mime_type ?? 'audio/wav', durationMs: Number(row.duration_ms) };
  });

  app.get('/api/tracks/:id/lyrics', async (request) => {
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    await request.optionalUser();
    const lyrics = await getLyrics(db(), id);
    if (!lyrics) return { lyrics: null, note: 'No lyrics have been licensed for this track.' };
    return { lyrics };
  });

  app.post('/api/tracks/:id/like', async (request, reply) => {
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const user = await request.requireUser();
    await guardRate(app, request, reply, { bucket: 'like', limit: env.RATE_LIMIT_WRITE });
    const result = await setLikedTrack(db(), user.id, id, true, (request.body as { source?: string } | null)?.source ?? 'player');
    return reply.code(201).send(result);
  });

  app.delete('/api/tracks/:id/like', async (request) => {
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const user = await request.requireUser();
    await setLikedTrack(db(), user.id, id, false);
    return { liked: false };
  });

  /** Add this track to one or more of the viewer's editable playlists. */
  app.post('/api/tracks/:id/playlists', async (request) => {
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const user = await request.requireUser();
    const body = parseBody(z.object({ playlistIds: z.array(idSchema).min(1).max(10), position: z.number().int().min(0).optional() }), request.body);
    const { addTracks, canEditPlaylist } = await import('@d7/database');
    const outcomes = [];
    for (const playlistId of body.playlistIds) {
      if (!(await canEditPlaylist(db(), playlistId, user.id))) throw ApiError.forbidden(`You cannot edit "${playlistId}".`, 'NOT_PLAYLIST_EDITOR');
      outcomes.push({ playlistId, ...(await addTracks(db(), playlistId, [id], { actorId: user.id, position: body.position, allowMissing: true })) });
    }
    return { outcomes };
  });

  app.get('/api/tracks/:id/radio', async (request) => {
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const user = await request.optionalUser();
    const limit = intField((request.query as { limit?: string }).limit, 20, 5, 50);
    const items = await app.d7.recommendations.similarTo(db(), id, { limit, viewerId: user?.id ?? null });
    return {
      seedTrackId: id,
      items: items.map((item) => ({ ...item, track: item.track })),
      generatedAt: new Date().toISOString(),
    };
  });

  app.post('/api/tracks/:id/report', async (request, reply) => {
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const user = await request.optionalUser();
    const body = parseBody(z.object({ reason: z.string().min(4).max(80), details: z.string().max(600).optional() }), request.body);
    await guardRate(app, request, reply, { bucket: 'report', limit: 10, message: 'You have submitted several reports recently. Try again in a minute.' });
    const reportId = await createContentReport(db(), { reporterId: user?.id ?? null, entityType: 'track', entityId: id, reason: body.reason, details: body.details ?? null });
    app.d7.log.info('content report filed', { reportId, entityType: 'track', entityId: id, reason: body.reason });
    return reply.code(202).send({ accepted: true, reportId });
  });

  /* --------------------------------- albums --------------------------------- */

  app.get('/api/albums/:id', async (request) => {
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const user = await request.optionalUser();
    const album = await getAlbumById(db(), id, { includeUnpublished: user?.role === 'admin' });
    if (!album) throw ApiError.notFound('Album');
    const [tracks, credits] = await Promise.all([listAlbumTracks(db(), id, user?.id ?? null), creditsFor(db(), id)]);
    const hydrated = await hydrateTracks(app, tracks, user);
    const allow = allowExplicitFor(user, boolField((request.query as { explicit?: string }).explicit));
    return {
      album: { ...album, trackIds: hydrated.map((t) => t.id) },
      tracks: applyExplicitFilter(hydrated, allow),
      credits,
      likedByMe: user ? await likedAlbum(db(), user.id, id) : false,
      canPlay: hydrated.some((t) => t.audio),
    };
  });

  /** Play-all context: the web player asks for ids + a context key, then streams per track. */
  app.get('/api/albums/:id/play', async (request) => {
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const user = await request.optionalUser();
    const album = await getAlbumById(db(), id);
    if (!album) throw ApiError.notFound('Album');
    const tracks = await hydrateTracks(app, await listAlbumTracks(db(), id, user?.id ?? null), user);
    const playable = tracks.filter((t) => t.audio);
    return {
      context: { type: 'album', id, title: album.title, imageUrl: album.imageUrl },
      trackIds: playable.map((t) => t.id),
      shuffleEligible: playable.length > 1,
      note: playable.length === 0 ? 'No licensed audio for this album yet.' : null,
    };
  });

  app.post('/api/albums/:id/like', async (request) => {
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const user = await request.requireUser();
    await setLikedAlbum(db(), user.id, id, true);
    return { liked: true };
  });

  app.delete('/api/albums/:id/like', async (request) => {
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const user = await request.requireUser();
    await setLikedAlbum(db(), user.id, id, false);
    return { liked: false };
  });

  app.get('/api/albums/:id/lyrics-preview', async (request) => {
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const tracks = await listAlbumTracks(db(), id);
    const withLyrics = [];
    for (const t of tracks.filter((x) => x.lyricCount > 0).slice(0, 3)) withLyrics.push({ trackId: t.id, title: t.title });
    return { tracks: withLyrics };
  });

  /* --------------------------------- artists --------------------------------- */

  app.get('/api/artists', async (request) => {
    const user = await request.optionalUser();
    const limit = intField((request.query as { limit?: string }).limit, 24, 4, 100);
    const version = await app.d7.catalogVersion();
    return cachedJson(app, 'artists-popular', [user?.id ?? 'anon', limit, version], 120, async () => ({ artists: await listPopularArtists(db(), limit) }));
  });

  app.get('/api/artists/:idOrSlug', async (request) => {
    const { idOrSlug } = parseBody(z.object({ idOrSlug: slugSchema }), request.params as { idOrSlug: string });
    const user = await request.optionalUser();
    const artist = await getArtistById(db(), idOrSlug);
    if (!artist) throw ApiError.notFound('Artist');
    const [popular, releases, related, following] = await Promise.all([
      listArtistPopularTracks(db(), artist.id, 10, user?.id ?? null),
      listArtistReleases(db(), artist.id, { limit: 30, includeUnpublished: user?.role === 'admin' }),
      listRelatedArtists(db(), artist.id, 8),
      user ? isFollowingArtist(db(), user.id, artist.id) : Promise.resolve(false),
    ]);
    return {
      artist,
      popular: await hydrateTracks(app, popular, user),
      releases,
      related,
      followed: Boolean(following),
      canClaim: user?.role === 'listener' && !artist.verified ? 'Ask an admin to link your account to this artist page.' : null,
    };
  });

  app.get('/api/artists/:idOrSlug/releases', async (request) => {
    const { idOrSlug } = parseBody(z.object({ idOrSlug: slugSchema }), request.params as { idOrSlug: string });
    const user = await request.optionalUser();
    const artist = await getArtistById(db(), idOrSlug);
    if (!artist) throw ApiError.notFound('Artist');
    const includeUnpublished = user?.role === 'admin' || (user && artist.id ? await ownsArtist(db(), user.id, artist.id) : false);
    const limit = intField((request.query as { limit?: string }).limit, 40, 1, 100);
    const type = (request.query as { type?: string }).type;
    let releases = await listArtistReleases(db(), artist.id, { limit, includeUnpublished });
    if (type && type !== 'all') releases = releases.filter((r) => r.releaseType === type);
    return { releases };
  });

  app.post('/api/artists/:id/follow', async (request) => {
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const user = await request.requireUser();
    return setArtistFollow(db(), user.id, id, true);
  });

  app.delete('/api/artists/:id/follow', async (request) => {
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const user = await request.requireUser();
    await setArtistFollow(db(), user.id, id, false);
    return { following: false };
  });

  /* --------------------------------- genres --------------------------------- */

  app.get('/api/genres', async () => cachedJson(app, 'genres', [], 300, () => listGenres(db())));

  app.get('/api/genres/:slug', async (request) => {
    const { slug } = parseBody(z.object({ slug: slugSchema }), request.params as { slug: string });
    const user = await request.optionalUser();
    const limit = intField((request.query as { limit?: string }).limit, 20, 4, 60);
    const genre = await getGenreBySlug(db(), slug);
    if (!genre) throw ApiError.notFound(`Genre "${slug}"`);
    const [trackRows, albumRows, artistRows] = await Promise.all([
      db().query<{ id: string }>(
        `SELECT t.id FROM tracks t
           JOIN track_genres tg ON tg.track_id = t.id JOIN genres g ON g.id = tg.genre_id
          WHERE g.slug = $1 AND t.status = 'published' AND t.streamable
          ORDER BY t.popularity DESC, t.release_date DESC LIMIT $2`,
        [slug, limit],
      ),
      db().query<{ id: string }>(
        `SELECT al.id FROM albums al
           JOIN album_genres ag ON ag.album_id = al.id JOIN genres g ON g.id = ag.genre_id
          WHERE g.slug = $1 AND al.status = 'published'
          ORDER BY al.release_date DESC LIMIT $2`,
        [slug, Math.min(limit, 24)],
      ),
      db().query<{ id: string }>(
        `SELECT ar.id FROM artists ar
           JOIN tracks t ON t.primary_artist_id = ar.id
           JOIN track_genres tg ON tg.track_id = t.id JOIN genres g ON g.id = tg.genre_id
          WHERE g.slug = $1 AND t.status = 'published'
          GROUP BY ar.id ORDER BY count(*) DESC LIMIT 12`,
        [slug],
      ),
    ]);
    const [tracks, albums, artists] = await Promise.all([
      hydrateTracks(app, await listTracksByIds(db(), trackRows.map((r) => String(r.id)), { viewerId: user?.id ?? null }), user),
      (await import('@d7/database')).listAlbumsByIds(db(), albumRows.map((r) => String(r.id))),
      Promise.all(artistRows.map((r) => getArtistById(db(), String(r.id)))).then((a) => a.filter(Boolean)),
    ]);
    const allow = allowExplicitFor(user, boolField((request.query as { explicit?: string }).explicit));
    return { genre, tracks: applyExplicitFilter(tracks, allow), albums, artists };
  });

  /* ------------------------------ discovery lists ------------------------------ */

  app.get('/api/trending', async (request) => {
    const user = await request.optionalUser();
    const limit = intField((request.query as { limit?: string }).limit, 24, 4, 60);
    const days = intField((request.query as { days?: string }).days, 7, 1, 90);
    const tracks = await hydrateTracks(app, await listTrendingTracks(db(), { days, limit, viewerId: user?.id ?? null }), user);
    return { tracks: applyExplicitFilter(tracks, allowExplicitFor(user)), days };
  });

  app.get('/api/new-tracks', async (request) => {
    const user = await request.optionalUser();
    const limit = intField((request.query as { limit?: string }).limit, 24, 4, 60);
    const days = intField((request.query as { days?: string }).days, 14, 1, 180);
    const tracks = await hydrateTracks(app, await listNewTracks(db(), { days, limit, viewerId: user?.id ?? null }), user);
    return { tracks: applyExplicitFilter(tracks, allowExplicitFor(user)), days };
  });

  app.get('/api/library/liked', async (request) => {
    const user = await request.requireUser();
    const ids = await listLikedTrackIds(db(), user.id, intField((request.query as { limit?: string }).limit, 100, 1, 500));
    const tracks = await hydrateTracks(app, await listTracksByIds(db(), ids, { viewerId: user.id }), user);
    return { tracks, total: tracks.length };
  });
}

/* ---------------------------------- helpers ---------------------------------- */

function reasonFor(track: { streamable: boolean; licenseStatus: string; hasAudio: boolean; providerName: string | null }) {
  if (!track.hasAudio) return track.providerName ? `This track is listed from ${track.providerName} but no audio is licensed to D7music.` : 'No audio object stored for this track yet.';
  if (!track.streamable) return 'Playback is disabled for this track.';
  if (track.licenseStatus !== 'licensed') return `Licence status is "${track.licenseStatus}", so streaming is blocked until review completes.`;
  return null;
}

async function likedAlbum(db: Db, userId: string, albumId: string) {
  const row = await db.queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM liked_albums WHERE user_id = $1::uuid AND album_id = $2::uuid`, [userId, albumId]);
  return Number(row?.c ?? 0) > 0;
}

async function ownsArtist(db: Db, userId: string, artistId: string) {
  // Editing rights come from an approved claim (0009), not from `users.role`.
  const row = await db.queryOne<{ c: number }>(
    `SELECT count(*)::int AS c FROM artist_claims ac
      WHERE ac.artist_id = $1::uuid AND ac.user_id = $2::uuid AND ac.status = 'approved'`,
    [artistId, userId],
  );
  return Number(row?.c ?? 0) > 0;
}

/** Liner notes: producers, featured artists, label, copyright — everything the detail page shows. */
async function creditsFor(db: Db, albumId: string) {
  const rows = await db.query<Record<string, any>>(
    `SELECT t.id, t.title, t.track_number, t.disc_number,
            coalesce(jsonb_agg(DISTINCT jsonb_build_object('id', a.id, 'name', a.name, 'creditType', ta.credit_type))
                      FILTER (WHERE a.id IS NOT NULL), '[]'::jsonb) AS people
       FROM tracks t
       LEFT JOIN track_artists ta ON ta.track_id = t.id
       LEFT JOIN artists a ON a.id = ta.artist_id
      WHERE t.album_id = $1::uuid
      GROUP BY t.id, t.title, t.track_number, t.disc_number
      ORDER BY t.disc_number, t.track_number`,
    [albumId],
  );
  const head = await db.queryOne<Record<string, any>>(
    `SELECT al.label_name, al.copyright_note, al.upc, al.pitch, ar.name AS artist_name, ar.id AS artist_id,
            to_char(al.release_date,'YYYY-MM-DD') AS release_date, al.content_source, al.license_status
       FROM albums al JOIN artists ar ON ar.id = al.artist_id WHERE al.id = $1::uuid`,
    [albumId],
  );
  return {
    album: head
      ? {
          label: head.label_name ?? null,
          copyright: head.copyright_note ?? null,
          upc: head.upc ?? null,
          description: head.pitch ?? null,
          artist: { id: String(head.artist_id), name: String(head.artist_name) },
          releaseDate: String(head.release_date ?? ''),
          contentSource: head.content_source,
          licenseStatus: head.license_status,
        }
      : null,
    tracks: rows.map((r) => ({ trackId: String(r.id), title: String(r.title), position: `${r.disc_number ?? 1}.${r.track_number ?? 0}`, people: Array.isArray(r.people) ? r.people : [] })),
  };
}
