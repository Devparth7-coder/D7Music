/**
 * MusicBrainz — open metadata/discovery source (CC-0 data).
 *
 * IMPORTANT: this is a *metadata* provider. It returns catalog facts and release
 * dates; it never yields playable audio, and nothing here fabricates artwork or
 * streams. Cover Art Archive is intentionally NOT used, because image rights are
 * separate from MusicBrainz's data license.
 */
import { requestJson } from '../http/client.js';
import { TokenBucketLimiter, withRetry } from '../http/rateLimiter.js';
import { normalizeDate } from '../audio/configurableHttpProvider.js';
import type { MetadataProvider, ProviderAlbum, ProviderArtist } from '../types.js';

export interface MusicBrainzOptions {
  baseUrl?: string;
  userAgent: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** MusicBrainz policy: at most ~1 request/second. */
  rps?: number;
  fetchImpl?: typeof fetch;
}

interface MbArtist {
  id: string;
  name: string;
  disambiguation?: string;
  area?: { name?: string };
  'life-span'?: { begin?: string };
  aliases?: { name: string; primary?: boolean; locale?: string }[];
  urlRelations?: { url?: { resource?: string }; type?: string }[];
}

interface MbReleaseGroup {
  id: string;
  title: string;
  primaryType?: 'Album' | 'Single' | 'EP' | 'Broadcast' | 'Other';
  status?: string;
  firstReleaseDate?: string;
  'artist-credit'?: { artist?: MbArtist; name?: string }[];
  'secondary-types'?: string[];
}

export class MusicBrainzProvider implements MetadataProvider {
  readonly kind = 'metadata' as const;
  readonly name = 'musicbrainz';
  private readonly limiter: TokenBucketLimiter;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(private readonly opts: MusicBrainzOptions) {
    this.baseUrl = opts.baseUrl ?? 'https://musicbrainz.org/ws/2';
    this.timeoutMs = opts.timeoutMs ?? 12_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.limiter = new TokenBucketLimiter({ rps: opts.rps ?? 1 });
  }

  get rateLimitWaitMs() {
    return Math.round(this.limiter.waitedMs);
  }

  private async call<T>(path: string, query: Record<string, unknown>): Promise<T> {
    await this.limiter.acquire();
    return withRetry(
      () =>
        requestJson<T>(
          {
            baseUrl: this.baseUrl,
            timeoutMs: this.timeoutMs,
            provider: this.name,
            headers: { 'user-agent': this.opts.userAgent, 'accept-encoding': 'identity' },
            fetchImpl: this.opts.fetchImpl,
          },
          { path, query: { fmt: 'json', ...query } as Record<string, string> },
        ),
      { maxRetries: this.maxRetries },
    );
  }

  async healthCheck() {
    const started = Date.now();
    try {
      const res = await this.call<{ count?: number }>('/artist', { query: 'radiohead', limit: 1 });
      return { ok: typeof res?.count === 'number', latencyMs: Date.now() - started };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, message: (err as Error).message };
    }
  }

  async searchArtists(query: string, limit: number): Promise<ProviderArtist[]> {
    const res = await this.call<{ artists?: MbArtist[] }>('/artist', { query, limit: Math.min(limit, 25) });
    return (res.artists ?? []).map((a) => this.mapArtist(a));
  }

  async getArtist(providerArtistId: string): Promise<ProviderArtist | null> {
    const a = await this.call<MbArtist>(`/artist/${encodeURIComponent(providerArtistId)}`, {
      inc: 'aliases+url-rels',
    }).catch(() => null);
    return a ? this.mapArtist(a) : null;
  }

  private mapArtist(a: MbArtist): ProviderArtist {
    const links: Record<string, string> = {};
    for (const rel of a.urlRelations ?? []) {
      if (!rel.url?.resource || !rel.type) continue;
      if (['discogs', 'official homepage', 'wikidata'].some((k) => rel.type!.toLowerCase().includes(k))) links[rel.type] = rel.url.resource;
    }
    return {
      providerName: this.name,
      providerArtistId: a.id,
      name: a.name,
      bio: a.disambiguation ? `(${a.disambiguation})` : null,
      imageUrl: null, // deliberately: no image licensing from a metadata source
      externalIds: { musicbrainz: a.id, ...(Object.keys(links).length ? links : {}) },
    };
  }

  /** Release groups give the album/single/EP taxonomy we need for `albums.album_type`. */
  async getArtistReleases(providerArtistId: string, opts: { limit: number }): Promise<ProviderAlbum[]> {
    const res = await this.call<{ 'release-groups'?: MbReleaseGroup[] }>('/release-group', {
      query: `arid:"${providerArtistId}"`,
      limit: Math.min(opts.limit, 100),
      offset: 0,
      // eslint-disable-next-line @typescript-eslint/naming-convention
      'meta': 'add/release-group',
    }).catch(() => ({ 'release-groups': [] as MbReleaseGroup[] }));
    return (res['release-groups'] ?? [])
      .filter((g) => ['Album', 'Single', 'EP', 'Broadcast'].includes(g.primaryType ?? ''))
      .slice(0, opts.limit)
      .map((g) => this.mapReleaseGroup(g, providerArtistId));
  }

  private mapReleaseGroup(g: MbReleaseGroup, artistId: string): ProviderAlbum {
    const type = g.primaryType === 'Single' ? 'single' : g.primaryType === 'EP' ? 'ep' : 'album';
    const credit = g['artist-credit']?.[0];
    const artist = credit?.artist ? this.mapArtist(credit.artist) : { providerName: this.name, providerArtistId: artistId, name: credit?.name ?? 'Unknown Artist' };
    return {
      providerName: this.name,
      providerAlbumId: g.id,
      providerArtistId: artist.providerArtistId,
      title: g.title,
      artist,
      albumType: type,
      releaseDate: normalizeDate(g.firstReleaseDate),
      imageUrl: null,
      genres: (g['secondary-types'] ?? []).map((s) => s.toLowerCase().replace(/\s+/g, '-')),
      tracks: [],
      raw: g,
    };
  }

  /** A release (not group) carries the recording-level tracklist + durations. */
  async getAlbum(providerAlbumId: string): Promise<ProviderAlbum | null> {
    const rel = await this.call<any>(`/release/${encodeURIComponent(providerAlbumId)}`, {
      inc: 'recordings+labels+media',
    }).catch(() => null);
    if (!rel) return null;
    const medium = (rel.media ?? [])[0];
    const tracks = (medium?.tracks ?? []).map((t: any, i: number) => ({
      providerName: this.name,
      providerTrackId: String(t.recording?.id ?? `${rel.id}-${i}`),
      providerAlbumId: String(rel.id),
      title: String(t.recording?.title ?? t.title ?? ''),
      artistName: String(rel['artist-credit']?.[0]?.name ?? ''),
      durationMs: Number(t.length ?? t.recording?.length ?? 0) || 0,
      trackNumber: Number(t.position ?? i + 1),
      discNumber: Number(medium?.position ?? 1),
      explicit: false,
      isrc: t.recording?.isrcs?.[0] ?? null,
      previewUrl: null,
      fullAudioLicensed: false,
      raw: t,
    })) as ProviderAlbum['tracks'];
    const group = rel['release-group'] ?? {};
    return {
      providerName: this.name,
      providerAlbumId: String(rel.id),
      providerArtistId: rel['artist-credit']?.[0]?.artist?.id,
      title: String(group.title ?? rel.title ?? ''),
      artist: rel['artist-credit']?.[0]?.artist
        ? this.mapArtist(rel['artist-credit'][0].artist)
        : { providerName: this.name, providerArtistId: 'various', name: String(rel['artist-credit']?.[0]?.name ?? 'Various Artists') },
      albumType: group.primaryType === 'Single' ? 'single' : group.primaryType === 'EP' ? 'ep' : 'album',
      releaseDate: normalizeDate(rel.date),
      labelName: rel['label-info']?.[0]?.label?.name ?? null,
      upc: rel.barcode ?? null,
      tracks,
      raw: rel,
    };
  }

  /** ISRC → recording lookup; used to enrich creator uploads. */
  async lookupByIsrc(isrc: string) {
    const res = await this.call<{ recordings?: { title: string; 'artist-credit'?: { name: string }[]; isrcs?: string[] }[] }>(
      '/recording',
      { query: `isrc:${isrc.replace(/[^A-Z0-9]/gi, '')}`, limit: 1 },
    ).catch(() => null);
    const rec = res?.recordings?.[0];
    if (!rec) return null;
    return {
      albumTitle: rec.title,
      artistName: rec['artist-credit']?.[0]?.name ?? 'Unknown Artist',
      releaseDate: new Date().toISOString().slice(0, 10),
    };
  }
}
