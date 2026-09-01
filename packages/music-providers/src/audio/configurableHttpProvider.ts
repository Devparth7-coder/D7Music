/**
 * ConfigurableHttpProvider — a *real* adapter for licensed catalog APIs.
 *
 * Many licensing deals end with a private JSON HTTP endpoint, not an SDK. Rather
 * than hard-coding a vendor, the field mapping lives in env/JSON config, so the
 * platform can integrate any licensed source without a code change.
 *
 * Env shape (see .env.example):
 *   MUSIC_PROVIDER=json_http
 *   MUSIC_PROVIDER_BASE_URL=https://catalog.partner.example/v1
 *   MUSIC_PROVIDER_API_KEY=...
 *   MUSIC_PROVIDER_MAP={"listPath":"data","trackId":"id","trackTitle":"name",...}
 */
import { requestJson } from '../http/client.js';
import { TokenBucketLimiter, withRetry } from '../http/rateLimiter.js';
import { ProviderError, type MusicProvider, type Page, type PlaybackSource, type NewReleasesQuery, type ProviderAlbum, type ProviderArtist, type ProviderTrack } from '../types.js';

export interface JsonMap {
  listPath?: string;
  cursorPath?: string;
  trackId?: string;
  trackTitle?: string;
  trackDurationMs?: string;
  trackIsrc?: string;
  trackExplicit?: string;
  trackArtistName?: string;
  trackArtistId?: string;
  albumId?: string;
  albumTitle?: string;
  albumDate?: string;
  albumImage?: string;
  albumType?: string;
  albumLabel?: string;
  albumTracksPath?: string;
  playbackUrl?: string;
  playbackExpiresIn?: string;
  popularity?: string;
}

export interface ConfigurableProviderOptions {
  name: string;
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  rps: number;
  maxRetries: number;
  map: JsonMap;
  endpoints?: Partial<Record<'search' | 'track' | 'album' | 'artist' | 'newReleases' | 'trending' | 'artistReleases' | 'playback', string>>;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const pick = (obj: any, path?: string) => {
  if (!path || obj == null) return undefined;
  return path.split('.').reduce<any>((acc, key) => (acc == null ? acc : acc[key]), obj);
};

const toArray = (v: unknown): any[] => (Array.isArray(v) ? v : v == null ? [] : typeof v === 'object' ? Object.values(v) : []);

const toInt = (v: unknown, def = 0) => {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(n) ? Math.round(n as number) : def;
};

/** Accepts ms or seconds or ISO8601 duration (PT3M20S). */
export function parseDuration(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 10_000 ? Math.round(value) : Math.round(value * 1000);
  if (typeof value === 'string') {
    const iso = /^PT(?:(\d+)M)?(?:([\d.]+)S)?$/.exec(value.trim().toUpperCase());
    if (iso) return (toInt(iso[1]) * 60 + Math.round(Number(iso[2] ?? 0))) * 1000;
    const num = Number(value);
    if (Number.isFinite(num)) return num > 10_000 ? Math.round(num) : Math.round(num * 1000);
  }
  return 0;
}

export class ConfigurableHttpProvider implements MusicProvider {
  readonly kind = 'audio' as const;
  readonly capabilities = {
    search: true,
    newReleases: true,
    artistDiscography: true,
    fullAudio: true,
    lyrics: false,
  };
  private readonly limiter: TokenBucketLimiter;

  constructor(private readonly o: ConfigurableProviderOptions) {
    this.limiter = new TokenBucketLimiter({ rps: o.rps, sleep: undefined });
  }

  get name() {
    return this.o.name;
  }
  get rateLimitWaitMs() {
    return Math.round(this.limiter.waitedMs);
  }

  private ep(key: keyof NonNullable<ConfigurableProviderOptions['endpoints']>, fallback: string) {
    return this.o.endpoints?.[key] ?? fallback;
  }

  private async call<T>(path: string, query?: Record<string, unknown>): Promise<T> {
    await this.limiter.acquire();
    return withRetry(
      async () =>
        requestJson<T>(
          {
            baseUrl: this.o.baseUrl,
            timeoutMs: this.o.timeoutMs,
            provider: this.name,
            headers: { ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}), ...(this.o.headers ?? {}) },
            fetchImpl: this.o.fetchImpl,
          },
          { path, query: query as Record<string, string>, signal: undefined },
        ),
      { maxRetries: this.o.maxRetries },
    );
  }

  private mapTrack(raw: any): ProviderTrack {
    const m = this.o.map;
    return {
      providerName: this.name,
      providerTrackId: String(pick(raw, m.trackId ?? 'id')),
      providerAlbumId: pick(raw, 'album.id') !== undefined ? String(pick(raw, 'album.id')) : (pick(raw, 'albumId') != null ? String(pick(raw, 'albumId')) : null),
      title: String(pick(raw, m.trackTitle ?? 'title') ?? ''),
      artistName: String(pick(raw, m.trackArtistName ?? 'artist.name') ?? pick(raw, 'artist') ?? ''),
      providerArtistId: pick(raw, m.trackArtistId ?? 'artist.id') != null ? String(pick(raw, m.trackArtistId ?? 'artist.id')) : undefined,
      durationMs: parseDuration(pick(raw, m.trackDurationMs ?? 'duration_ms')),
      trackNumber: toInt(pick(raw, 'track_number'), 1),
      discNumber: toInt(pick(raw, 'disc_number'), 1),
      explicit: Boolean(pick(raw, m.trackExplicit ?? 'explicit')),
      isrc: (pick(raw, m.trackIsrc ?? 'isrc') as string | undefined) ?? null,
      popularity: Number(pick(raw, m.popularity ?? 'popularity') ?? 0) || undefined,
      previewUrl: (pick(raw, 'preview_url') as string | undefined) ?? null,
      fullAudioLicensed: true,
      raw,
    };
  }

  private mapAlbum(raw: any): ProviderAlbum {
    const m = this.o.map;
    const artistRaw = raw.artist ?? raw.artists?.[0] ?? {};
    const albumId = String(pick(raw, m.albumId ?? 'id'));
    return {
      providerName: this.name,
      providerAlbumId: albumId,
      providerArtistId: pick(artistRaw, 'id') != null ? String(pick(artistRaw, 'id')) : undefined,
      title: String(pick(raw, m.albumTitle ?? 'title') ?? ''),
      artist: this.mapArtist(artistRaw, albumId),
      albumType: (['album', 'single', 'ep', 'compilation'].includes(String(pick(raw, m.albumType ?? 'album_type')))
        ? String(pick(raw, m.albumType ?? 'album_type'))
        : 'album') as ProviderAlbum['albumType'],
      releaseDate: normalizeDate(pick(raw, m.albumDate ?? 'release_date')),
      imageUrl: (pick(raw, m.albumImage ?? 'image_url') as string | undefined) ?? null,
      labelName: (pick(raw, m.albumLabel ?? 'label') as string | undefined) ?? null,
      upc: (pick(raw, 'upc') as string | undefined) ?? null,
      popularity: Number(pick(raw, m.popularity ?? 'popularity') ?? 0) || undefined,
      tracks: toArray(pick(raw, m.albumTracksPath ?? 'tracks.items')).map((t) => ({ ...this.mapTrack(t), providerAlbumId: albumId })),
      raw,
    };
  }

  private mapArtist(raw: any, fallbackId: string): ProviderArtist {
    const id = raw?.id != null ? String(raw.id) : fallbackId;
    return {
      providerName: this.name,
      providerArtistId: id,
      name: String(raw?.name ?? ''),
      popularity: Number(raw?.popularity ?? 0) || undefined,
      imageUrl: raw?.images?.[0]?.url ?? raw?.image_url ?? null,
      externalIds: { [this.name]: id },
    };
  }

  async healthCheck() {
    const started = Date.now();
    try {
      await this.call(this.ep('search', '/health'), { limit: 1, q: 'a' });
      return { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      const status = (err as ProviderError).status;
      if (status === 401 || status === 403) return { ok: false, latencyMs: Date.now() - started, message: 'credential rejected (HTTP ' + status + ')' };
      return { ok: false, latencyMs: Date.now() - started, message: (err as Error).message };
    }
  }

  async searchTracks(query: string, opts: { limit: number; offset: number }): Promise<Page<ProviderTrack>> {
    const res = await this.call<any>(this.ep('search', '/tracks/search'), { q: query, limit: opts.limit, offset: opts.offset });
    const items = toArray(pick(res, this.o.map.listPath ?? 'items'));
    return { items: items.map((t) => this.mapTrack(t)), nextCursor: (pick(res, this.o.map.cursorPath ?? 'next_cursor') as string) ?? null };
  }

  async getTrack(providerTrackId: string) {
    const res = await this.call<any>(this.ep('track', `/tracks/{id}`).replace('{id}', encodeURIComponent(providerTrackId)));
    return res ? this.mapTrack(res) : null;
  }

  async getAlbum(providerAlbumId: string) {
    const res = await this.call<any>(this.ep('album', `/albums/{id}`).replace('{id}', encodeURIComponent(providerAlbumId)));
    return res ? this.mapAlbum(res) : null;
  }

  async getArtist(providerArtistId: string) {
    const res = await this.call<any>(this.ep('artist', `/artists/{id}`).replace('{id}', encodeURIComponent(providerArtistId)));
    return res ? this.mapArtist(res, providerArtistId) : null;
  }

  async getNewReleases(q: NewReleasesQuery): Promise<Page<ProviderAlbum>> {
    const res = await this.call<any>(this.ep('newReleases', '/albums/new'), {
      since: q.since,
      cursor: q.cursor ?? undefined,
      limit: q.limit,
      genre: q.genre,
      country: q.country,
    });
    const items = toArray(pick(res, this.o.map.listPath ?? 'items'));
    return { items: items.map((a) => this.mapAlbum(a)), nextCursor: (pick(res, this.o.map.cursorPath ?? 'next_cursor') as string) ?? null };
  }

  async getTrendingTracks(opts: { limit: number; window?: 'day' | 'week' | 'month' }) {
    const res = await this.call<any>(this.ep('trending', '/tracks/trending'), { limit: opts.limit, window: opts.window ?? 'week' });
    return toArray(pick(res, this.o.map.listPath ?? 'items')).map((t) => this.mapTrack(t));
  }

  async getArtistReleases(providerArtistId: string, opts: { limit: number }) {
    const res = await this.call<any>(this.ep('artistReleases', `/artists/{id}/albums`).replace('{id}', encodeURIComponent(providerArtistId)), { limit: opts.limit });
    return toArray(pick(res, this.o.map.listPath ?? 'items')).map((a) => this.mapAlbum(a));
  }

  /**
   * Licensed playback: the provider hands us a short-lived URL. We never persist it;
   * the browser receives it via our own signed stream endpoint.
   */
  async getPlaybackSource(providerTrackId: string, ctx: { userId?: string | null; quality?: string }): Promise<PlaybackSource | null> {
    const res = await this.call<any>(this.ep('playback', `/tracks/{id}/stream`).replace('{id}', encodeURIComponent(providerTrackId)), {
      user: ctx.userId ?? undefined,
      quality: ctx.quality,
    });
    const url = pick(res, this.o.map.playbackUrl ?? 'url');
    if (!url) return null;
    const expiresIn = toInt(pick(res, this.o.map.playbackExpiresIn ?? 'expires_in'), 3600);
    return {
      url: String(url),
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      mimeType: (pick(res, 'mime_type') as string) ?? 'audio/mpeg',
      bitrateKbps: pick(res, 'bitrate_kbps') ? toInt(pick(res, 'bitrate_kbps')) : null,
      protocol: 'progressive',
      seekable: true,
    };
  }
}

export function normalizeDate(value: unknown): string {
  if (value == null) return new Date().toISOString().slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = String(value).trim();
  if (/^\d{4}$/.test(s)) return `${s}-01-01`;
  if (/^\d{4}-\d{2}$/.test(s)) return `${s}-01`;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}
