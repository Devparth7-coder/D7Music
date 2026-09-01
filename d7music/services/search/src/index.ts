/**
 * Search service — the seam between "how we find things" and "who asks".
 *
 * `SearchBackend` is deliberately provider-shaped (index/remove/search/suggest) so an
 * Elasticsearch or OpenSearch implementation can be dropped in without touching routes:
 * documents are written through `index()`, and `PostgresSearchBackend` maintains the
 * `search_documents` projection that ReleaseSyncService updates row-by-row.
 */
import type { Db } from '@d7/database';
import {
  getArtistById,
  listAlbumsByIds,
  listGenres,
  listTracksByIds,
  logSearch,
  recentSearches,
  recordSearchClick,
  rebuildSearchIndex,
  searchDocuments,
  suggestDocuments,
  clearRecentSearches,
  trendingQueries,
  getPlaylist,
  normalizeQuery,
  removeSearchDocument,
  touchSearchDocument,
} from '@d7/database';
import type { Genre, SearchEntityType, SearchFilters, SearchResponse, SearchSuggestion } from '@d7/types';

export interface SearchRequest {
  query: string;
  types?: SearchEntityType[];
  filters?: SearchFilters;
  limit?: number;
  offset?: number;
  viewerId?: string | null;
  followedArtistIds?: string[];
}

export interface SearchBackend {
  readonly name: string;
  search(req: SearchRequest): Promise<SearchResponse>;
  suggest(query: string, limit?: number): Promise<SearchSuggestion[]>;
  index(entityType: SearchEntityType, entityId: string): Promise<void>;
  remove(entityType: SearchEntityType, entityId: string): Promise<void>;
  reindexAll(): Promise<{ documents: number; tookMs: number }>;
}

const GROUP_LIMIT = 6;

export class PostgresSearchBackend implements SearchBackend {
  readonly name = 'postgres';

  constructor(private readonly db: Db) {}

  async search(req: SearchRequest): Promise<SearchResponse> {
    const started = Date.now();
    const limit = Math.min(req.limit ?? 24, 60);
    const wanted = req.types?.length ? new Set(req.types) : null;
    const { docs, usedFuzzy } = await searchDocuments(this.db, {
      query: req.query,
      limit: Math.max(limit * 2, 24),
      offset: req.offset ?? 0,
      types: req.types,
      boostArtistIds: req.followedArtistIds,
    });

    const filtered = await this.applyFilters(docs, req.filters);
    const byType = new Map<SearchEntityType, string[]>();
    for (const d of filtered) {
      const list = byType.get(d.entity_type) ?? [];
      list.push(d.entity_id);
      byType.set(d.entity_type, list);
    }

    const trackIds = byType.get('track') ?? [];
    const albumIds = byType.get('album') ?? [];
    const artistIds = byType.get('artist') ?? [];
    const playlistIds = byType.get('playlist') ?? [];

    const [trackRows, albums, artistRows, genresAll] = await Promise.all([
      listTracksByIds(this.db, trackIds, { viewerId: req.viewerId ?? null }),
      listAlbumsByIds(this.db, albumIds),
      Promise.all(artistIds.map((id) => getArtistById(this.db, id))),
      listGenres(this.db),
    ]);
    const playlists = (
      await Promise.all(playlistIds.map((id) => getPlaylist(this.db, id, req.viewerId ?? null)))
    ).filter(Boolean) as NonNullable<Awaited<ReturnType<typeof getPlaylist>>>[];

    const tracks = orderByIds(trackRows, trackIds);
    const artists = artistRows.filter(Boolean) as NonNullable<(typeof artistRows)[number]>[];
    const genreMatches = new Set(filtered.filter((d) => d.entity_type === 'genre').map((d) => normalizeQuery(String(d.title))));
    const genres: Genre[] = genresAll
      .filter((g) => genreMatches.has(normalizeQuery(g.slug)) || genreMatches.has(normalizeQuery(g.name)))
      .slice(0, GROUP_LIMIT);

    return {
      query: req.query,
      tookMs: Date.now() - started,
      total: filtered.length,
      offset: req.offset ?? 0,
      limit,
      topHit: pickTopHit({ tracks, artists, albums, wanted, usedFuzzy }),
      tracks: wanted && !wanted.has('track') ? [] : tracks.slice(0, limit),
      artists: wanted && !wanted.has('artist') ? [] : artists.slice(0, GROUP_LIMIT),
      albums: wanted && !wanted.has('album') ? [] : albums.slice(0, GROUP_LIMIT),
      playlists: wanted && !wanted.has('playlist') ? [] : playlists,
      genres: wanted && !wanted.has('genre') ? [] : genres,
    };
  }

  /** Attributes the tsvector projection cannot express cheaply are filtered here. */
  private async applyFilters(
    docs: { entity_type: SearchEntityType; entity_id: string; title: string; body: string | null; rank: number; match_kind: 'exact' | 'prefix' | 'fulltext' | 'fuzzy' }[],
    filters?: SearchFilters,
  ) {
    if (!filters) return docs;
    const needsTrackFilter =
      !!filters.genres?.length || filters.explicit !== undefined || filters.hasAudio !== undefined || !!filters.releasedAfter || !!filters.releasedBefore || !!filters.licenseStatus?.length;
    if (!needsTrackFilter) return docs;
    const trackIds = docs.filter((d) => d.entity_type === 'track').map((d) => d.entity_id);
    const tracks = trackIds.length ? await listTracksByIds(this.db, trackIds, { includeUnpublished: true, allowUnlicensed: true }) : [];
    const keep = new Set<string>();
    for (const t of tracks) {
      if (filters.genres?.length && !filters.genres.some((g) => t.genres.includes(g))) continue;
      if (filters.explicit !== undefined && t.explicit !== filters.explicit) continue;
      if (filters.hasAudio !== undefined && t.hasAudio !== filters.hasAudio) continue;
      if (filters.releasedAfter && t.releaseDate < filters.releasedAfter) continue;
      if (filters.releasedBefore && t.releaseDate > filters.releasedBefore) continue;
      if (filters.licenseStatus?.length && !filters.licenseStatus.includes(t.licenseStatus)) continue;
      keep.add(t.id);
    }
    return docs.filter((d) => (d.entity_type === 'track' ? keep.has(d.entity_id) : true));
  }

  async suggest(query: string, limit = 8): Promise<SearchSuggestion[]> {
    const rows = await suggestDocuments(this.db, query, limit);
    return rows.map((r) => ({
      text: r.text,
      type: r.type === 'recent' ? 'track' : r.type,
      entityId: r.entityId,
      subtitle: r.subtitle ?? null,
      imageUrl: null,
      score: r.score,
    }));
  }

  async index(entityType: SearchEntityType, entityId: string) {
    await touchSearchDocument(this.db, entityType, entityId);
  }

  async remove(entityType: SearchEntityType, entityId: string) {
    await removeSearchDocument(this.db, entityType, entityId);
  }

  async reindexAll() {
    return rebuildSearchIndex(this.db);
  }

  async history(userId: string, limit = 8) {
    return recentSearches(this.db, userId, limit);
  }

  async clearHistory(userId: string) {
    return clearRecentSearches(this.db, userId);
  }

  async clicked(input: { query: string; entityType: SearchEntityType; entityId: string }) {
    await recordSearchClick(this.db, input);
  }

  async trending(limit = 6) {
    return trendingQueries(this.db, limit);
  }
}

function orderByIds<T extends { id: string }>(items: T[], ids: string[]): T[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  return ids.map((id) => byId.get(id)).filter(Boolean) as T[];
}

function pickTopHit(groups: {
  tracks: SearchResponse['tracks'];
  artists: { id: string; name: string }[];
  albums: { id: string }[];
  wanted: Set<SearchEntityType> | null;
  usedFuzzy: boolean;
}): SearchResponse['topHit'] {
  // A confident exact artist match outranks a track — that is what users expect to type.
  if (!groups.wanted || groups.wanted.has('artist')) {
    const artist = groups.artists[0];
    if (artist && !groups.usedFuzzy) return { type: 'artist', artist: artist as never };
  }
  if (!groups.wanted || groups.wanted.has('track')) {
    const track = groups.tracks[0];
    if (track) return { type: 'track', track };
  }
  if (!groups.wanted || groups.wanted.has('album')) {
    const album = groups.albums[0];
    if (album) return { type: 'album', album: album as never };
  }
  if (!groups.wanted || groups.wanted.has('artist')) {
    const artist = groups.artists[0];
    if (artist) return { type: 'artist', artist: artist as never };
  }
  return null;
}

export function scoreQueryMatch(query: string, candidate: string) {
  const a = normalizeQuery(query);
  const b = normalizeQuery(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.startsWith(a)) return 0.9;
  if (b.includes(a)) return 0.7;
  const tokens = a.split(' ');
  const hits = tokens.filter((t) => b.includes(t)).length;
  return (hits / Math.max(1, tokens.length)) * 0.6;
}
