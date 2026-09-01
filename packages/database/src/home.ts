/** Data fetchers for the personalized home page (spec §4). All shelves are DB-driven. */
import type { Db } from './client.js';
import { listAlbumTracks, listNewTracks, listPopularArtists, listTrendingTracks, trackColumnsForHome } from './columns2.js';
import { Sql } from './sql.js';
import { mapTrack } from './map.js';
import type { Track } from '@d7/types';

export async function getRecentlyPlayedTracks(db: Db, userId: string | null, limit = 8): Promise<Track[]> {
  if (!userId) return [];
  const rows = await db.query<Record<string, any>>(
    `SELECT ${trackColumnsForHome('$1')}, rp.played_at AS _played_at
       FROM recently_played rp
       JOIN tracks t ON t.id = rp.track_id
       JOIN albums al ON al.id = t.album_id
       JOIN artists ar ON ar.id = t.primary_artist_id
      WHERE rp.user_id = $1::uuid
      ORDER BY rp.played_at DESC LIMIT $2`,
    [userId, limit],
  );
  return rows.map(mapTrack);
}

/** Resume strip: only tracks with a saved position > 5s and not finished. */
export async function getContinueListening(db: Db, userId: string | null, limit = 6) {
  if (!userId) return [];
  const rows = await db.query<Record<string, any>>(
    `SELECT ${trackColumnsForHome('$1')}, rp.position_ms AS resume_position_ms, rp.played_at AS resume_played_at
       FROM recently_played rp
       JOIN tracks t ON t.id = rp.track_id
       JOIN albums al ON al.id = t.album_id
       JOIN artists ar ON ar.id = t.primary_artist_id
      WHERE rp.user_id = $1::uuid AND rp.position_ms > 5000
        AND rp.position_ms < (t.duration_ms * 0.95)
      ORDER BY rp.played_at DESC LIMIT $2`,
    [userId, limit],
  );
  return rows.map((r) => ({ track: mapTrack(r), resumePositionMs: Number(r.resume_position_ms ?? 0), playedAt: String(r.resume_played_at ?? '') }));
}

export async function getTopTracksForUser(db: Db, userId: string | null, limit = 10) {
  if (!userId) return [];
  const rows = await db.query<Record<string, any>>(
    `SELECT ${trackColumnsForHome('$1')}
       FROM listening_history lh
       JOIN tracks t ON t.id = lh.track_id
       JOIN albums al ON al.id = t.album_id
       JOIN artists ar ON ar.id = t.primary_artist_id
      WHERE lh.user_id = $1::uuid AND lh.play_count >= 2 AND t.streamable
      ORDER BY lh.play_count DESC, lh.score DESC LIMIT $2`,
    [userId, limit],
  );
  return rows.map(mapTrack);
}

export async function getRecentlyLikedTracks(db: Db, userId: string | null, limit = 12) {
  if (!userId) return [];
  const rows = await db.query<Record<string, any>>(
    `SELECT ${trackColumnsForHome('$1')}
       FROM liked_tracks lt
       JOIN tracks t ON t.id = lt.track_id
       JOIN albums al ON al.id = t.album_id
       JOIN artists ar ON ar.id = t.primary_artist_id
      WHERE lt.user_id = $1::uuid AND t.streamable
      ORDER BY lt.created_at DESC LIMIT $2`,
    [userId, limit],
  );
  return rows.map(mapTrack);
}

export async function getMoodTracks(db: Db, mood: string, limit = 12, viewerId?: string | null): Promise<Track[]> {
  const q = new Sql();
  const tag = q.bind(mood);
  const lim = q.bind(limit);
  const viewer = q.bind(viewerId ?? null);
  const rows = await db.query<Record<string, any>>(
    `SELECT ${trackColumnsForHome(viewer)}
       FROM tracks t
       JOIN albums al ON al.id = t.album_id
       JOIN artists ar ON ar.id = t.primary_artist_id
       JOIN track_moods m ON m.track_id = t.id
      WHERE t.streamable AND t.status = 'published' AND m.tag = ${tag}
      ORDER BY m.weight DESC, t.popularity DESC
      LIMIT ${lim}`,
    q.values,
  );
  return rows.map(mapTrack);
}

export async function getFreshTracks(db: Db, opts: { days?: number; limit?: number } = {}) {
  return listNewTracks(db, { days: opts.days ?? 21, limit: opts.limit ?? 12 });
}

export async function getTrending(db: Db, opts: { limit?: number; viewerId?: string | null } = {}) {
  return listTrendingTracks(db, { limit: opts.limit ?? 12, viewerId: opts.viewerId });
}

export async function getPopularArtists(db: Db, limit = 10) {
  return listPopularArtists(db, limit);
}

export { listAlbumTracks };
