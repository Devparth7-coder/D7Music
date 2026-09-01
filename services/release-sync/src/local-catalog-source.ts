/**
 * Bridges the Postgres catalog to the `LocalCatalogSource` port so platform-owned music
 * is exposed through exactly the same `MusicProvider` interface as a licensed feed.
 * (Kept in the service layer so `@d7/music-providers` stays storage-agnostic.)
 */
import type { Db } from '@d7/database';
import { albumsAddedSince, listArtistReleases, listNewTracks, listTracksByIds, searchDocuments, getAlbumById, getTrackById } from '@d7/database';
import { ALBUM_RELEASE_COLS, mapTrack } from '@d7/database';
import type { LocalCatalogSource } from '@d7/music-providers';
import type { ProviderAlbum, ProviderTrack } from '@d7/music-providers';
import type { Album, Track } from '@d7/types';

export function makeLocalCatalogSource(db: Db): LocalCatalogSource {
  return {
    async listNewReleases({ since, limit }) {
      const albums = await albumsAddedSince(db, since ?? new Date(Date.now() - 45 * 86_400_000).toISOString(), limit);
      const items = await toProviderAlbums(db, albums);
      return { items, nextCursor: items.length === limit ? String(items.length) : null };
    },
    async listTrending({ limit }) {
      const tracks = await listNewTracks(db, { days: 14, limit });
      return tracks.map((t) => trackToProvider(t, String(t.id)));
    },
    async getAlbumByLocalId(id) {
      const album = await getAlbumById(db, id, { includeUnpublished: true });
      if (!album) return null;
      const [provider] = await toProviderAlbums(db, [album]);
      return provider ?? null;
    },
    async getTrackByLocalId(id) {
      const t = await getTrackById(db, id);
      return t ? trackToProvider(t, t.id) : null;
    },
    async listArtistReleases(artistId, limit) {
      const releases = await listArtistReleases(db, artistId, { limit });
      return toProviderAlbums(db, releases);
    },
    async searchTracks(q, limit) {
      const { docs } = await searchDocuments(db, { query: q, limit, types: ['track'] });
      return docs.map((d) => ({
        providerName: 'local_library',
        providerTrackId: d.entity_id,
        title: d.title,
        artistName: (d.body ?? '').split(' ')[0] ?? '',
        durationMs: 0,
        raw: d,
      }));
    },
    async getPlaybackSource(trackId) {
      const t = await getTrackById(db, trackId);
      if (!t) return null;
      return { url: `/api/tracks/${t.id}/stream`, mimeType: 'audio/wav', quality: 'normal', protocol: 'progressive', seekable: true, expiresAt: null };
    },
    async listArtists(limit) {
      const rows = await db.query<Record<string, unknown>>(`SELECT id, name, popularity FROM artists ORDER BY popularity DESC LIMIT $1`, [limit]);
      return rows.map((r) => ({
        providerName: 'local_library',
        providerArtistId: String(r.id),
        name: String(r.name),
        popularity: Number(r.popularity ?? 0),
      }));
    },
  };
}

/**
 * `Album` → `ProviderAlbum`.
 *
 * The catalog repos hand back *mapped* `Album` objects, so this function must not run them through
 * `mapAlbum` again: the second pass reads snake_case keys that no longer exist and silently yields
 * `releaseType: undefined`, `artist.id: ''`, `genres: []` — which the sync then tried to insert as an
 * album with a NULL type and no artist. One shape, in and out.
 */
/**
 * Resolve the album's own tracks in one batch, then map. A feed that references tracks by id must
 * hand the importer real titles/durations: `validateTrackInput` rejects a titleless row, so stub
 * entries would make every local re-sync "succeed" while rejecting every track it touched.
 */
async function toProviderAlbums(db: Db, albums: (Album & { trackIds?: string[] })[]): Promise<ProviderAlbum[]> {
  const ids = [...new Set(albums.flatMap((a) => a.trackIds ?? []))];
  const tracks = ids.length ? await listTracksByIds(db, ids, { includeUnpublished: true }) : [];
  const byId = new Map(tracks.map((t) => [String(t.id), t]));
  return albums.map((a) =>
    albumToProvider(
      a,
      String(a.id),
      (a.trackIds ?? []).map((id) => byId.get(String(id))).filter((t): t is NonNullable<typeof t> => Boolean(t)),
    ),
  );
}

function albumToProvider(album: Album & { trackIds?: string[] }, localId: string, albumTracks: Track[]): ProviderAlbum {
  return {
    providerName: 'local_library',
    providerAlbumId: `local:${localId}`,
    providerArtistId: album.artist.id,
    title: album.title,
    artist: { providerName: 'local_library', providerArtistId: album.artist.id, name: album.artist.name },
    albumType: album.releaseType ?? 'album',
    releaseDate: album.releaseDate,
    imageUrl: album.imageUrl,
    labelName: album.label,
    copyrightNote: album.copyright,
    upc: album.upc,
    popularity: album.popularity,
    genres: album.genres,
    tracks: albumTracks.map((t) => trackToProvider(t, localId)),
  };
}

function trackToProvider(t: Track, localAlbumId: string): ProviderTrack {
  return {
    providerName: 'local_library',
    providerTrackId: `local:${t.id}`,
    providerAlbumId: `local:${localAlbumId}`,
    title: t.title,
    artistName: t.artists[0]?.name ?? 'Unknown',
    providerArtistId: t.primaryArtistId,
    durationMs: t.durationMs,
    explicit: t.explicit,
    isrc: t.isrc,
    popularity: t.popularity,
    fullAudioLicensed: true,
  };
}

export { ALBUM_RELEASE_COLS };
