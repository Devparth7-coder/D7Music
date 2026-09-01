/** New-release discovery queries (spec §12) — driven purely by `albums.added_at`/`new_releases`. */
import type { Db } from './client.js';
import type { Album } from '@d7/types';
import { Sql } from './sql.js';
import { mapAlbum } from './map.js';
import { ALBUM_RELEASE_COLS } from './columns.js';
import { listTracksByIds } from './catalog.js';
import type { NewReleasesQuery, ReleaseSummary, ReleaseWindow } from '@d7/types';

const WINDOWS: Record<ReleaseWindow, string> = {
  today: 'now()::date',
  week: `now() - interval '7 days'`,
  month: `now() - interval '30 days'`,
  all: `to_timestamp(0)`,
};

export async function queryNewReleases(
  db: Db,
  input: NewReleasesQuery & { viewerId?: string | null },
): Promise<{ releases: (ReleaseSummary & { album: ReturnType<typeof mapAlbum> })[]; counts: Record<ReleaseWindow, number> }> {
  const q = new Sql();
  const win = q.bind(input.window === 'today' ? 1 : input.window === 'week' ? 7 : input.window === 'month' ? 30 : 100_000);
  const lim = q.bind(Math.min(input.limit, 60));
  const off = q.bind(input.offset);

  const filters: string[] = [`al.status = 'published'`, `al.added_at > now() - make_interval(days => ${win}::int)`];
  if (input.window === 'today') filters.unshift(`al.added_at::date = now()::date`);
  if (input.artistId) filters.push(`al.artist_id = ${q.bind(input.artistId)}::uuid`);
  if (input.genre) {
    filters.push(`EXISTS (SELECT 1 FROM album_genres ag JOIN genres g ON g.id = ag.genre_id
                           WHERE ag.album_id = al.id AND g.slug = ${q.bind(input.genre)})`);
  }
  if (input.scope === 'following' && input.viewerId) {
    filters.push(`EXISTS (SELECT 1 FROM followed_artists fa WHERE fa.artist_id = al.artist_id AND fa.user_id = ${q.bind(input.viewerId)}::uuid)`);
  } else if (input.scope === 'for_you' && input.viewerId) {
    filters.push(`(EXISTS (SELECT 1 FROM followed_artists fa WHERE fa.artist_id = al.artist_id AND fa.user_id = ${q.bind(input.viewerId)}::uuid)
        OR EXISTS (SELECT 1 FROM liked_albums la WHERE la.album_id = al.id AND la.user_id = ${q.bind(input.viewerId)}::uuid)
        OR al.popularity > 30)`);
  }

  const rows = await db.query<Record<string, any>>(
    `SELECT ${ALBUM_RELEASE_COLS},
            coalesce((SELECT count(*) FROM playback_events pe JOIN tracks t2 ON t2.id = pe.track_id
                       WHERE t2.album_id = al.id AND pe.event IN ('track_started','track_completed')
                         AND pe.occurred_at > now() - interval '7 days'), 0)::int AS total_plays,
            EXISTS (SELECT 1 FROM followed_artists fa WHERE fa.artist_id = al.artist_id AND fa.user_id = ${q.bind(input.viewerId ?? null)}::uuid) AS followed_artist
       FROM albums al JOIN artists ar ON ar.id = al.artist_id
      WHERE ${filters.join(' AND ')}
      ORDER BY al.release_date DESC, al.added_at DESC
      LIMIT ${lim} OFFSET ${off}`,
    q.values,
  );

  const allTrackIds = rows.flatMap((r) => (r.track_ids as string[]) ?? []);
  const tracks = await listTracksByIds(db, allTrackIds.slice(0, 600), { viewerId: input.viewerId });
  const byAlbum = new Map<string, typeof tracks>();
  for (const t of tracks) {
    const list = byAlbum.get(t.albumId) ?? [];
    list.push(t);
    byAlbum.set(t.albumId, list);
  }

  const maxPlays = Math.max(1, ...rows.map((r) => Number(r.total_plays ?? 0)));
  const releases = rows.map((r) => {
    const album = mapAlbum(r);
    const plays = Number(r.total_plays ?? 0);
    return {
      album,
      tracks: byAlbum.get(album.id) ?? [],
      totalPlays: plays,
      isTrending: plays >= Math.max(3, maxPlays * 0.35),
      followedArtist: Boolean(r.followed_artist),
    } as ReleaseSummary & { album: ReturnType<typeof mapAlbum> };
  });

  const counts = await countWindows(db, input);
  return { releases, counts };
}

async function countWindows(db: Db, input: NewReleasesQuery): Promise<Record<ReleaseWindow, number>> {
  const q = new Sql();
  const genreFilter = input.genre ? `AND EXISTS (SELECT 1 FROM album_genres ag JOIN genres g ON g.id = ag.genre_id WHERE ag.album_id = al.id AND g.slug = ${q.bind(input.genre)})` : '';
  const artistFilter = input.artistId ? `AND al.artist_id = ${q.bind(input.artistId)}::uuid` : '';
  const row = await db.queryOne<Record<string, number>>(
    `SELECT
       count(*) FILTER (WHERE al.added_at::date = now()::date)::int AS today,
       count(*) FILTER (WHERE al.added_at > now() - interval '7 days')::int AS week,
       count(*) FILTER (WHERE al.added_at > now() - interval '30 days')::int AS month,
       count(*)::int AS all_time
       FROM albums al WHERE al.status = 'published' ${genreFilter} ${artistFilter}`,
    q.values,
  );
  return {
    today: Number(row?.today ?? 0),
    week: Number(row?.week ?? 0),
    month: Number(row?.month ?? 0),
    all: Number(row?.all_time ?? 0),
  };
}

/** Releases added since a cursor — used by the sync job to detect "new to us". */
/**
 * Albums that recently became visible on the platform — the source for the "new releases" shelf and
 * for the local_library provider feed, which needs the track ids too.
 */
export async function albumsAddedSince(db: Db, sinceIso: string, limit = 100): Promise<(Album & { trackIds: string[] })[]> {
  const rows = await db.query<Record<string, any>>(
    `SELECT ${ALBUM_RELEASE_COLS} FROM albums al JOIN artists ar ON ar.id = al.artist_id
      WHERE al.added_at > $1::timestamptz ORDER BY al.added_at DESC LIMIT $2`,
    [sinceIso, limit],
  );
  // mapAlbum drops `track_ids` (the UI gets `trackCount`), so keep it for provider feeds.
  return rows.map((r) => ({ ...mapAlbum(r), trackIds: (r.track_ids as string[]) ?? [] }));
}

export async function latestReleaseForArtist(db: Db, artistId: string) {
  const row = await db.queryOne<Record<string, any>>(
    `SELECT ${ALBUM_RELEASE_COLS} FROM albums al JOIN artists ar ON ar.id = al.artist_id
      WHERE al.artist_id = $1::uuid AND al.status = 'published'
      ORDER BY al.release_date DESC, al.added_at DESC LIMIT 1`,
    [artistId],
  );
  return row ? mapAlbum(row) : undefined;
}

export async function markTrending(db: Db, albumIds: string[], trending: boolean) {
  if (!albumIds.length) return 0;
  return db.execute(`UPDATE new_releases SET is_trending = $2 WHERE entity_type='album' AND entity_id = ANY($1::uuid[])`, [albumIds, trending]);
}

