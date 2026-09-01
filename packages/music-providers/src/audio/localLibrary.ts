/**
 * LocalLibraryProvider — "Platform-Owned Music" as a first-class provider.
 *
 * Admin/artist uploads are just another source, so the player, sync job, search
 * index and recommender treat them identically to a licensed partner feed.
 * The DB lives behind `LocalCatalogSource` so this package stays storage-agnostic.
 */
import type { MusicProvider, NewReleasesQuery, Page, PlaybackSource, ProviderAlbum, ProviderArtist, ProviderTrack } from '../types.js';

export interface LocalCatalogSource {
  listNewReleases(q: { since?: string; limit: number; cursor?: string | null }): Promise<{ items: ProviderAlbum[]; nextCursor: string | null }>;
  listTrending(q: { limit: number }): Promise<ProviderTrack[]>;
  getAlbumByLocalId(id: string): Promise<ProviderAlbum | null>;
  getTrackByLocalId(id: string): Promise<ProviderTrack | null>;
  listArtistReleases(artistId: string, limit: number): Promise<ProviderAlbum[]>;
  searchTracks(q: string, limit: number): Promise<ProviderTrack[]>;
  /** Returns OUR signed stream URL (never a storage path) for platform-owned audio. */
  getPlaybackSource(trackId: string, ctx: { userId?: string | null; quality?: string }): Promise<PlaybackSource | null>;
  listArtists(limit: number): Promise<ProviderArtist[]>;
}

export class LocalLibraryProvider implements MusicProvider {
  readonly kind = 'audio' as const;
  readonly name = 'local_library';
  readonly capabilities = { search: true, newReleases: true, artistDiscography: true, fullAudio: true, lyrics: true } as const;

  constructor(private readonly source: LocalCatalogSource, private readonly opts: { maxRetries?: number } = {}) {}

  async healthCheck() {
    const started = Date.now();
    try {
      const rows = await this.source.listNewReleases({ limit: 1 });
      return { ok: true, latencyMs: Date.now() - started, message: `${rows.items.length} release(s) readable` };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, message: (err as Error).message };
    }
  }

  searchTracks(query: string, opts: { limit: number }): Promise<Page<ProviderTrack>> {
    return this.source.searchTracks(query, opts.limit).then((items) => ({ items, nextCursor: null }));
  }
  getTrack(providerTrackId: string) {
    return this.source.getTrackByLocalId(providerTrackId);
  }
  getAlbum(providerAlbumId: string) {
    return this.source.getAlbumByLocalId(providerAlbumId);
  }
  getArtist(providerArtistId: string) {
    return this.source.listArtists(500).then((all) => all.find((a) => a.providerArtistId === providerArtistId) ?? null);
  }
  getNewReleases(q: NewReleasesQuery): Promise<Page<ProviderAlbum>> {
    return this.source.listNewReleases({ since: q.since, limit: q.limit, cursor: q.cursor });
  }
  getTrendingTracks(opts: { limit: number }) {
    return this.source.listTrending({ limit: opts.limit });
  }
  getArtistReleases(providerArtistId: string, opts: { limit: number }) {
    return this.source.listArtistReleases(providerArtistId, opts.limit);
  }
  getPlaybackSource(providerTrackId: string, ctx: { userId?: string | null; quality?: string }) {
    return this.source.getPlaybackSource(providerTrackId, ctx);
  }
}
