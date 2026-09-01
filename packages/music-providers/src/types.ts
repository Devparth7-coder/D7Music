/**
 * Provider contracts.
 *
 * Two families, deliberately separated:
 *  - `MusicProvider`      : may hand us audio (playable content). Requires a license.
 *  - `MetadataProvider`   : discovery/catalog data only. Never yields a playable URL.
 *
 * Nothing in this package knows about any specific commercial service; adapters are
 * chosen by env config (see registry.ts).
 */

export interface ProviderArtist {
  providerName: string;
  providerArtistId: string;
  name: string;
  bio?: string | null;
  imageUrl?: string | null;
  popularity?: number;
  genres?: string[];
  externalIds?: Record<string, string>;
}

export interface ProviderAlbum {
  providerName: string;
  providerAlbumId: string;
  providerArtistId?: string;
  title: string;
  artist: ProviderArtist;
  albumType: 'album' | 'single' | 'ep' | 'compilation';
  /** ISO date (YYYY-MM-DD). Providers frequently return partial dates. */
  releaseDate: string;
  imageUrl?: string | null;
  labelName?: string | null;
  copyrightNote?: string | null;
  upc?: string | null;
  popularity?: number;
  genres?: string[];
  tracks: ProviderTrack[];
  /** Raw provider payload, retained for auditability and future re-mapping. */
  raw?: unknown;
}

export interface ProviderTrack {
  providerName: string;
  providerTrackId: string;
  providerAlbumId?: string | null;
  title: string;
  artistName: string;
  providerArtistId?: string;
  durationMs: number;
  trackNumber?: number;
  discNumber?: number;
  explicit?: boolean;
  isrc?: string | null;
  popularity?: number;
  previewUrl?: string | null;
  /** True only when this platform is licensed to serve full audio from the provider. */
  fullAudioLicensed?: boolean;
  genres?: string[];
  moods?: string[];
  features?: TrackFeatures;
  raw?: unknown;
}

/** Audio-analysis features. Kept as a named type so DB + providers agree exactly. */
export interface TrackFeatures {
  energy?: number;
  valence?: number;
  danceability?: number;
  acousticness?: number;
  instrumentalness?: number;
  bpm?: number;
  keyScale?: string;
}

export interface PlaybackSource {
  /** Absolute or relative URL the player can request (already authorized/expiring). */
  url: string;
  expiresAt?: string | null;
  mimeType?: string;
  bitrateKbps?: number | null;
  quality?: 'low' | 'normal' | 'high';
  protocol?: 'progressive' | 'hls' | 'dash';
  drmProtected?: boolean;
  /** Whether we may seek; some licensed previews do not allow it. */
  seekable?: boolean;
}

export interface Page<T> {
  items: T[];
  /** Opaque cursor supplied back to the next call. `null` = end of feed. */
  nextCursor: string | null;
  totalEstimate?: number | null;
}

export interface NewReleasesQuery {
  since?: string;
  cursor?: string | null;
  limit: number;
  genre?: string;
  country?: string;
}

export interface MusicProvider {
  readonly name: string;
  readonly kind: 'audio';
  /** Capability advertisement used by the UI to label provenance honestly. */
  readonly capabilities: {
    search: boolean;
    newReleases: boolean;
    artistDiscography: boolean;
    fullAudio: boolean;
    lyrics: boolean;
  };
  healthCheck(): Promise<{ ok: boolean; latencyMs: number; message?: string }>;
  searchTracks(query: string, opts: { limit: number; offset: number }): Promise<Page<ProviderTrack>>;
  getTrack(providerTrackId: string): Promise<ProviderTrack | null>;
  getAlbum(providerAlbumId: string): Promise<ProviderAlbum | null>;
  getArtist(providerArtistId: string): Promise<ProviderArtist | null>;
  getNewReleases(query: NewReleasesQuery): Promise<Page<ProviderAlbum>>;
  getTrendingTracks(opts: { limit: number; window?: 'day' | 'week' | 'month' }): Promise<ProviderTrack[]>;
  getArtistReleases(providerArtistId: string, opts: { limit: number }): Promise<ProviderAlbum[]>;
  /** The only path allowed to produce a playable URL. */
  getPlaybackSource(providerTrackId: string, ctx: { userId?: string | null; quality?: string }): Promise<PlaybackSource | null>;
  getLyrics?(providerTrackId: string): Promise<{ text: string; synced: boolean; language: string } | null>;
}

export interface MetadataProvider {
  readonly name: string;
  readonly kind: 'metadata';
  healthCheck(): Promise<{ ok: boolean; latencyMs: number; message?: string }>;
  searchArtists(query: string, limit: number): Promise<ProviderArtist[]>;
  getArtist(providerArtistId: string): Promise<ProviderArtist | null>;
  getArtistReleases(providerArtistId: string, opts: { limit: number }): Promise<ProviderAlbum[]>;
  getAlbum(providerAlbumId: string): Promise<ProviderAlbum | null>;
  lookupByIsrc?(isrc: string): Promise<{ albumTitle: string; artistName: string; releaseDate: string } | null>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export class ProviderNotConfiguredError extends ProviderError {
  constructor(provider: string, reason: string) {
    super(`${provider} is not configured: ${reason}`, provider, false);
    this.name = 'ProviderNotConfigured';
  }
}
