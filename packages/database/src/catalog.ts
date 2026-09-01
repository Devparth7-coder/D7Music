/**
 * Catalog read model — artists, albums, tracks, genres, lyrics.
 *
 * One canonical projection per entity, shared by every endpoint, so the home page,
 * search, playlists and the API all return byte-identical track objects.
 */
import type { Db } from './client.js';
import { Sql } from './sql.js';
import { mapAlbum, mapArtist, mapLyrics, mapTrack } from './map.js';
import type { Album, Artist, Genre, Lyrics, Track } from '@d7/types';

export interface VisibilityOpts {
  /** Include drafts / scheduled / unpublished rows (creator + admin views only). */
  includeUnpublished?: boolean;
  /** Admin override to preview content whose license is still pending review. */
  allowUnlicensed?: boolean;
  viewerId?: string | null;
}

/* --------------------------------- tracks --------------------------------- */

export async function getTrackById(db: Db, id: string, viewerId?: string | null): Promise<Track | undefined> {
  const q = new Sql();
  const viewer = q.bind(viewerId ?? null);
  const track = q.bind(id);
  const sql = `SELECT ${trackColumns(viewer)}
     FROM tracks t JOIN albums al ON al.id = t.album_id JOIN artists ar ON ar.id = t.primary_artist_id
     WHERE t.id = ${track}::uuid`;
  const row = await db.queryOne<Record<string, any>>(sql, q.values);
  return row ? mapTrack(row) : undefined;
}

/** Raw lookup that ignores visibility rules — used by licensing/streaming guards. */
export async function getTrackForStreaming(db: Db, id: string) {
  return db.queryOne<{
    id: string;
    title: string;
    storage_key: string | null;
    mime_type: string | null;
    byte_size: number | null;
    duration_ms: number;
    license_status: string;
    content_source: string;
    status: string;
    streamable: boolean;
    explicit: boolean;
    album_id: string;
    artist_id: string;
    isrc: string | null;
    provider_name: string | null;
    provider_track_id: string | null;
  }>(
    `SELECT id, title, storage_key, mime_type, byte_size, duration_ms, license_status, content_source,
            status, streamable, explicit, album_id, primary_artist_id AS artist_id, isrc,
            provider_name, provider_track_id
       FROM tracks WHERE id = $1::uuid`,
    [id],
  );
}

export function trackColumns(viewerToken: string) {
  return `
    t.id, t.title, t.album_id, t.track_number, t.disc_number, t.duration_ms, t.explicit,
    t.isrc, t.primary_artist_id, t.popularity, t.play_count, t.energy, t.valence,
    t.danceability, t.acousticness, to_char(t.release_date, 'YYYY-MM-DD') AS release_date,
    t.added_at, t.content_source,
    t.license_status, t.provider_name, t.provider_track_id, t.streamable, t.status,
    (t.storage_key IS NOT NULL) AS has_audio,
    al.title AS album_title, al.image_url AS album_image_url,
    coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'verified', x.verified) ORDER BY p)
      FROM (SELECT ar2.id, ar2.name, ar2.verified, min(ta.position) AS p
              FROM track_artists ta JOIN artists ar2 ON ar2.id = ta.artist_id
             WHERE ta.track_id = t.id GROUP BY ar2.id, ar2.name, ar2.verified) x
    ), jsonb_build_array(jsonb_build_object('id', ar.id, 'name', ar.name, 'verified', ar.verified))) AS artists_json,
    coalesce((SELECT jsonb_agg(g.slug ORDER BY tg.weight DESC)
                FROM track_genres tg JOIN genres g ON g.id = tg.genre_id
               WHERE tg.track_id = t.id), '[]'::jsonb) AS genre_slugs,
    coalesce((SELECT jsonb_agg(m.tag ORDER BY m.weight DESC)
                FROM track_moods m WHERE m.track_id = t.id), '[]'::jsonb) AS mood_tags,
    (SELECT count(*) FROM liked_tracks lt WHERE lt.track_id = t.id)::int AS liked_count,
    EXISTS (SELECT 1 FROM lyrics l WHERE l.track_id = t.id) AS lyric_count,
    EXISTS (SELECT 1 FROM liked_tracks ul WHERE ul.track_id = t.id AND ul.user_id = ${viewerToken}::uuid) AS liked,
    NULL::text AS audio_url, NULL::text AS audio_expires_at`;
}

/** Fetch tracks preserving the given id order (queue hydration, assistant results). */
export async function listTracksByIds(
  db: Db,
  ids: string[],
  opts: VisibilityOpts = {},
): Promise<Track[]> {
  if (!ids.length) return [];
  const q = new Sql();
  const viewer = q.bind(opts.viewerId ?? null);
  const idArr = q.bindList(ids, 'uuid[]');
  let sql = `SELECT ${trackColumns(viewer)}
     FROM tracks t JOIN albums al ON al.id = t.album_id JOIN artists ar ON ar.id = t.primary_artist_id
     WHERE t.id = ANY(${idArr})`;
  if (!opts.includeUnpublished) {
    sql += ` AND t.streamable AND t.status = 'published' AND al.status = 'published'`;
    if (!opts.allowUnlicensed) sql += ` AND t.license_status = 'licensed'`;
  }
  sql += ` ORDER BY array_position(${idArr}, t.id)`;
  const rows = await db.query<Record<string, any>>(sql, q.values);
  return rows.map(mapTrack);
}

export async function listAlbumTracks(db: Db, albumId: string, viewerId?: string | null): Promise<Track[]> {
  const q = new Sql();
  const viewer = q.bind(viewerId ?? null);
  const aid = q.bind(albumId);
  const sql = `SELECT ${trackColumns(viewer)}
     FROM tracks t JOIN albums al ON al.id = t.album_id JOIN artists ar ON ar.id = t.primary_artist_id
     WHERE t.album_id = ${aid}::uuid
     ORDER BY t.disc_number, t.track_number`;
  const rows = await db.query<Record<string, any>>(sql, q.values);
  return rows.map(mapTrack);
}

export async function listArtistPopularTracks(db: Db, artistId: string, limit = 10, viewerId?: string | null) {
  const q = new Sql();
  const viewer = q.bind(viewerId ?? null);
  const aid = q.bind(artistId);
  const lim = q.bind(limit);
  const sql = `SELECT ${trackColumns(viewer)},
       (SELECT count(*) FROM playback_events pe
         WHERE pe.track_id = t.id AND pe.event IN ('track_completed','track_started'))::int AS play_score
     FROM tracks t JOIN albums al ON al.id = t.album_id JOIN artists ar ON ar.id = t.primary_artist_id
     WHERE (t.primary_artist_id = ${aid}::uuid
            OR EXISTS (SELECT 1 FROM track_artists ta WHERE ta.track_id = t.id AND ta.artist_id = ${aid}::uuid))
       AND t.streamable AND t.status = 'published' AND al.status = 'published'
     ORDER BY play_score DESC, t.popularity DESC, t.play_count DESC, t.release_date DESC
     LIMIT ${lim}`;
  const rows = await db.query<Record<string, any>>(sql, q.values);
  return rows.map(mapTrack);
}

export async function listTrendingTracks(db: Db, opts: { days?: number; limit?: number; viewerId?: string | null } = {}): Promise<Track[]> {
  const q = new Sql();
  const viewer = q.bind(opts.viewerId ?? null);
  const days = q.bind(opts.days ?? 14);
  const lim = q.bind(opts.limit ?? 20);
  const sql = `WITH window_events AS (
       SELECT pe.track_id,
              count(*) FILTER (WHERE pe.event = 'track_completed') AS completes,
              count(*) FILTER (WHERE pe.event = 'track_started')  AS starts,
              count(*) FILTER (WHERE pe.event = 'track_skipped')  AS skips
         FROM playback_events pe
        WHERE pe.occurred_at > now() - make_interval(days => ${days}::int)
        GROUP BY pe.track_id
     )
     SELECT ${trackColumns(viewer)}
       FROM tracks t
       JOIN albums al ON al.id = t.album_id
       JOIN artists ar ON ar.id = t.primary_artist_id
       LEFT JOIN window_events we ON we.track_id = t.id
       WHERE t.streamable AND t.status = 'published' AND al.status = 'published'
       ORDER BY (coalesce(we.completes,0) * 3 + coalesce(we.starts,0) - coalesce(we.skips,0) * 2) DESC,
                t.popularity DESC, t.play_count DESC
       LIMIT ${lim}`;
  const rows = await db.query<Record<string, any>>(sql, q.values);
  return rows.map(mapTrack);
}

export async function listNewTracks(db: Db, opts: { days?: number; limit?: number; viewerId?: string | null } = {}): Promise<Track[]> {
  const q = new Sql();
  const viewer = q.bind(opts.viewerId ?? null);
  const days = q.bind(opts.days ?? 30);
  const lim = q.bind(opts.limit ?? 24);
  const sql = `SELECT ${trackColumns(viewer)}
     FROM tracks t JOIN albums al ON al.id = t.album_id JOIN artists ar ON ar.id = t.primary_artist_id
     WHERE t.streamable AND t.status = 'published' AND al.status = 'published'
       AND al.added_at > now() - make_interval(days => ${days}::int)
     ORDER BY al.added_at DESC, t.added_at DESC
     LIMIT ${lim}`;
  const rows = await db.query<Record<string, any>>(sql, q.values);
  return rows.map(mapTrack);
}

/* --------------------------------- albums --------------------------------- */

const ALBUM_COLS = `
  al.id, al.title, al.slug, al.album_type, to_char(al.release_date, 'YYYY-MM-DD') AS release_date,
  al.added_at, al.image_url,
  al.primary_color, al.label_name, al.copyright_note, al.upc, al.popularity,
  al.content_source, al.license_status, al.status, al.pitch, al.explicit, al.scheduled_at,
  al.artist_id,
  jsonb_build_object('id', ar.id, 'name', ar.name, 'verified', ar.verified) AS artist_json,
  (SELECT count(*) FROM tracks t WHERE t.album_id = al.id AND t.status = 'published')::int AS track_count,
  coalesce((SELECT sum(t.duration_ms) FROM tracks t WHERE t.album_id = al.id AND t.status = 'published'), 0)::int AS duration_ms,
  coalesce((SELECT jsonb_agg(g.slug) FROM album_genres ag JOIN genres g ON g.id = ag.genre_id WHERE ag.album_id = al.id), '[]'::jsonb) AS genre_slugs,
  coalesce((SELECT jsonb_agg(t.id ORDER BY t.disc_number, t.track_number) FROM tracks t WHERE t.album_id = al.id AND t.status='published' LIMIT 60), '[]'::jsonb) AS track_ids,
  coalesce((SELECT jsonb_agg(DISTINCT ta.artist_id) FROM tracks t JOIN track_artists ta ON ta.track_id = t.id WHERE t.album_id = al.id), '[]'::jsonb) AS artist_ids
`;

export async function getAlbumById(db: Db, id: string, opts: { includeUnpublished?: boolean } = {}): Promise<(Album & { trackIds: string[] }) | undefined> {
  const row = await db.queryOne<Record<string, any>>(
    `SELECT ${ALBUM_COLS} FROM albums al JOIN artists ar ON ar.id = al.artist_id
      WHERE al.id = $1::uuid ${opts.includeUnpublished ? '' : "AND al.status = 'published'"}`,
    [id],
  );
  if (!row) return undefined;
  return { ...mapAlbum(row), trackIds: (row.track_ids as string[]) ?? [] };
}

export async function listArtistReleases(
  db: Db,
  artistId: string,
  opts: { limit?: number; includeUnpublished?: boolean } = {},
): Promise<(Album & { trackIds: string[] })[]> {
  const q = new Sql();
  const aid = q.bind(artistId);
  const lim = q.bind(opts.limit ?? 50);
  const sql = `SELECT ${ALBUM_COLS} FROM albums al JOIN artists ar ON ar.id = al.artist_id
     WHERE al.artist_id = ${aid}::uuid ${opts.includeUnpublished ? '' : "AND al.status = 'published'"}
     ORDER BY al.release_date DESC, al.added_at DESC LIMIT ${lim}`;
  const rows = await db.query<Record<string, any>>(sql, q.values);
  return rows.map((r) => ({ ...mapAlbum(r), trackIds: (r.track_ids as string[]) ?? [] }));
}

export async function listAlbumsByIds(db: Db, ids: string[], opts: { includeUnpublished?: boolean } = {}) {
  if (!ids.length) return [];
  const q = new Sql();
  const idArr = q.bindList(ids, 'uuid[]');
  const sql = `SELECT ${ALBUM_COLS} FROM albums al JOIN artists ar ON ar.id = al.artist_id
     WHERE al.id = ANY(${idArr}) ORDER BY array_position(${idArr}, al.id)`;
  const rows = await db.query<Record<string, any>>(sql, q.values);
  return rows.map((r) => ({ ...mapAlbum(r), trackIds: (r.track_ids as string[]) ?? [] }));
}

export async function listLatestAlbums(
  db: Db,
  opts: { days?: number; limit?: number; artistIds?: string[]; genre?: string; windowStart?: string; windowEnd?: string },
) {
  const q = new Sql();
  const lim = q.bind(opts.limit ?? 24);
  const filters: string[] = [`al.status = 'published'`];
  if (opts.windowStart) filters.push(`al.added_at >= ${q.bind(opts.windowStart)}::timestamptz`);
  else if (opts.days) filters.push(`al.added_at > now() - make_interval(days => ${q.bind(opts.days)}::int)`);
  if (opts.windowEnd) filters.push(`al.added_at <= ${q.bind(opts.windowEnd)}::timestamptz`);
  if (opts.artistIds?.length) filters.push(`al.artist_id = ANY(${q.bindList(opts.artistIds, 'uuid[]')})`);
  if (opts.genre)
    filters.push(`EXISTS (SELECT 1 FROM album_genres ag JOIN genres g ON g.id = ag.genre_id
                           WHERE ag.album_id = al.id AND g.slug = ${q.bind(opts.genre)})`);
  const sql = `SELECT ${ALBUM_COLS} FROM albums al JOIN artists ar ON ar.id = al.artist_id
     WHERE ${filters.join(' AND ')} ORDER BY al.release_date DESC, al.added_at DESC LIMIT ${lim}`;
  const rows = await db.query<Record<string, any>>(sql, q.values);
  return rows.map((r) => ({ ...mapAlbum(r), trackIds: (r.track_ids as string[]) ?? [] }));
}

/* --------------------------------- artists --------------------------------- */

const ARTIST_COLS = `
  ar.id, ar.name, ar.slug, ar.bio, ar.image_url, ar.banner_url, ar.verified, ar.verified_kind,
  ar.verified_at, ar.verified_by, ar.monthly_listeners, ar.followers_count, ar.popularity,
  ar.external_links,
  coalesce((SELECT jsonb_agg(g.slug) FROM (
      SELECT g2.slug, sum(tg.weight) AS w
        FROM tracks t JOIN track_genres tg ON tg.track_id = t.id JOIN genres g2 ON g2.id = tg.genre_id
       WHERE t.primary_artist_id = ar.id GROUP BY g2.slug ORDER BY w DESC LIMIT 5) g),'[]'::jsonb) AS genre_slugs,
  (SELECT p.provider FROM provider_artists p WHERE p.artist_id = ar.id ORDER BY p.last_seen_at DESC LIMIT 1) AS source_provider,
  (SELECT p.provider_artist_id FROM provider_artists p WHERE p.artist_id = ar.id ORDER BY p.last_seen_at DESC LIMIT 1) AS provider_artist_id
`;

export async function getArtistById(db: Db, idOrSlug: string): Promise<Artist | undefined> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
  const row = await db.queryOne<Record<string, any>>(
    `SELECT ${ARTIST_COLS} FROM artists ar WHERE ${isUuid ? 'ar.id = $1::uuid' : 'ar.slug = $1'}`,
    [idOrSlug],
  );
  return row ? mapArtist(row) : undefined;
}

export async function listPopularArtists(db: Db, limit = 12): Promise<Artist[]> {
  const rows = await db.query<Record<string, any>>(
    `SELECT ${ARTIST_COLS} FROM artists ar ORDER BY ar.popularity DESC, ar.monthly_listeners DESC LIMIT $1`,
    [limit],
  );
  return rows.map(mapArtist);
}

export async function listArtistsByIds(db: Db, ids: string[]): Promise<Artist[]> {
  if (!ids.length) return [];
  const q = new Sql();
  const idArr = q.bindList(ids, 'uuid[]');
  const rows = await db.query<Record<string, any>>(
    `SELECT ${ARTIST_COLS} FROM artists ar WHERE ar.id = ANY(${idArr}) ORDER BY array_position(${idArr}, ar.id)`,
    q.values,
  );
  return rows.map(mapArtist);
}

export async function listArtistNames(db: Db, limit = 500) {
  const rows = await db.query<{ id: string; name: string }>(
    `SELECT id, name FROM artists ORDER BY popularity DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

/** Related artists: co-listening graph first, shared-genre fallback second. */
export async function listRelatedArtists(db: Db, artistId: string, limit = 8): Promise<Artist[]> {
  const q = new Sql();
  const aid = q.bind(artistId);
  const lim = q.bind(limit);
  const sql = `WITH direct AS (
       SELECT r.related_id AS id, r.weight FROM related_artists r WHERE r.artist_id = ${aid}::uuid
     ), fallback AS (
       SELECT t2.primary_artist_id AS id, count(DISTINCT tg.genre_id)::float8 AS weight
         FROM tracks t
         JOIN track_genres tg ON tg.track_id = t.id
         JOIN track_genres tg2 ON tg2.genre_id = tg.genre_id
         JOIN tracks t2 ON t2.id = tg2.track_id
        WHERE t.primary_artist_id = ${aid}::uuid AND t2.primary_artist_id <> ${aid}::uuid
        GROUP BY t2.primary_artist_id
     ), picked AS (
       SELECT id, max(weight) AS weight FROM (SELECT id, weight FROM direct UNION ALL SELECT id, weight FROM fallback) u
        WHERE id <> ${aid}::uuid GROUP BY id ORDER BY weight DESC LIMIT ${lim}
     )
     SELECT ${ARTIST_COLS}, picked.weight FROM artists ar JOIN picked ON picked.id = ar.id
     ORDER BY picked.weight DESC`;
  const rows = await db.query<Record<string, any>>(sql, q.values);
  return rows.map(mapArtist);
}

/* --------------------------------- genres --------------------------------- */

export async function listGenres(db: Db): Promise<Genre[]> {
  const rows = await db.query<Record<string, any>>(
    `SELECT g.id, g.slug, g.name, g.description, g.accent_color,
            coalesce((SELECT count(*) FROM track_genres tg JOIN tracks t ON t.id = tg.track_id
                       WHERE tg.genre_id = g.id AND t.streamable AND t.status = 'published'), 0)::int AS track_count
       FROM genres g ORDER BY track_count DESC, g.name ASC`,
  );
  return rows.map((r) => ({
    id: String(r.id),
    slug: String(r.slug),
    name: String(r.name),
    description: r.description ?? null,
    trackCount: Number(r.track_count ?? 0),
    accentColor: r.accent_color ?? null,
  }));
}

export async function getGenreBySlug(db: Db, slug: string) {
  return db.queryOne<{ id: string; slug: string; name: string; accent_color: string | null }>(
    `SELECT id, slug, name, accent_color FROM genres WHERE slug = $1`,
    [slug],
  );
}

/* --------------------------------- lyrics --------------------------------- */

export async function getLyrics(db: Db, trackId: string): Promise<Lyrics | undefined> {
  const row = await db.queryOne<Record<string, any>>(
    `SELECT track_id, language, is_synced, provider, updated_at, lines, content
       FROM lyrics WHERE track_id = $1::uuid
       ORDER BY (lines <> '[]'::jsonb) DESC, language = 'en' DESC LIMIT 1`,
    [trackId],
  );
  if (!row) return undefined;
  const lyrics = mapLyrics(row);
  if (!lyrics.lines.length && row.content) {
    return {
      ...lyrics,
      lines: String(row.content)
        .split('\n')
        .filter((l) => l.trim())
        .map((text, i) => ({ lineNumber: i + 1, timeMs: null, text })),
    };
  }
  return lyrics;
}

export async function upsertLyrics(
  db: Db,
  input: { trackId: string; language?: string; content?: string; lines?: unknown[]; synced?: boolean; provider?: string; isPlaceholder?: boolean },
) {
  await db.execute(
    `INSERT INTO lyrics (id, track_id, language, provider, is_synced, is_placeholder, content, lines, updated_at)
     VALUES (d7_uuid(), $1::uuid, $2, $3, $4, $5, $6, $7::jsonb, now())
     ON CONFLICT (track_id, language)
     DO UPDATE SET content = EXCLUDED.content, lines = EXCLUDED.lines,
                   is_synced = EXCLUDED.is_synced, provider = EXCLUDED.provider, updated_at = now()`,
    [
      input.trackId,
      input.language ?? 'en',
      input.provider ?? 'platform',
      input.synced ?? false,
      input.isPlaceholder ?? false,
      input.content ?? null,
      JSON.stringify(input.lines ?? []),
    ],
  );
}
