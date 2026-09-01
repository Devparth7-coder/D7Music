/**
 * Media plumbing for responses.
 *
 * The catalog projection deliberately returns `audio: null`; playback URLs are signed at
 * the edge of the API (this file) so the signing key never reaches a cache layer, a log line,
 * or the search index. A track is only given a URL when it is published, streamable, licensed
 * and actually backed by an object in storage.
 */
import type { FastifyInstance } from 'fastify';
import { env } from '@d7/config';
import type { Album, Track } from '@d7/types';
import type { SessionUser } from '../plugins/session.js';

interface StorageRow {
  id: string;
  storage_key: string | null;
  mime_type: string | null;
  byte_size: number | string | null;
}

function canStream(track: Track): boolean {
  if (!track.hasAudio || !track.streamable) return false;
  if (track.licenseStatus !== 'licensed' && !env.ALLOW_UNLICENSED_STREAM) return false;
  return true;
}

/** Attach signed playback sources to a page of tracks (single storage-key lookup, not N). */
export async function hydrateTracks(app: FastifyInstance, tracks: Track[], user: SessionUser | null): Promise<Track[]> {
  if (!tracks.length) return tracks;
  const eligible = tracks.filter(canStream);
  if (!eligible.length) return tracks.map((t) => ({ ...t, audio: null }));
  const ids = eligible.map((t) => t.id);
  const rows = await app.d7.db.query<StorageRow>(
    `SELECT id::text, storage_key, mime_type, byte_size FROM tracks WHERE id = ANY($1::uuid[]) AND storage_key IS NOT NULL`,
    [ids],
  );
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const ttl = env.STREAM_URL_TTL_SEC;
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  const plan = user?.plan;
  const quality: 'low' | 'normal' | 'high' = plan?.limits.lossless || (plan?.limits.maxBitrateKbps ?? 0) >= 256 ? 'high' : user ? 'normal' : 'normal';
  const urlByKey = new Map<string, string>();
  for (const row of rows) {
    if (!row.storage_key) continue;
    urlByKey.set(row.storage_key, await app.d7.storage.getStreamUrl(row.storage_key, { userId: user?.id ?? null, expiresSec: ttl }));
  }
  return tracks.map((t) => {
    const row = byId.get(t.id);
    const key = row?.storage_key;
    if (!key) return { ...t, audio: null };
    const url = urlByKey.get(key);
    if (!url) return { ...t, audio: null };
    return {
      ...t,
      audio: {
        url,
        expiresAt,
        mimeType: row.mime_type ?? 'audio/wav',
        bitrateKbps: bitrateFor(quality, row),
        quality,
        streamingProtocol: 'progressive' as const,
        drmProtected: false,
      },
    };
  });
}

function bitrateFor(quality: string, row: StorageRow): number | null {
  if (quality === 'low') return 96;
  if (quality === 'high') return 320;
  void row;
  return 160;
}

/** Convenience for endpoints that just need the ordered id list of a shelf. */
export function trackIds(tracks: Track[]): string[] {
  return tracks.map((t) => t.id);
}

/**
 * Explicit-content gating (spec §19). `preferences.explicitFilter` is parental mode:
 * true = hide. A client may ask to hide more with `?explicit=false`, but `?explicit=true`
 * can never widen what a filtering account is allowed to see.
 */
export function allowExplicitFor(user: SessionUser | null, requested?: boolean): boolean {
  const base = user ? !user.preferences.explicitFilter : true;
  if (requested === false) return false;
  return base;
}

export function applyExplicitFilter<T extends { explicit: boolean }>(items: T[], allowExplicit: boolean): T[] {
  if (allowExplicit) return items;
  return items.filter((i) => !i.explicit);
}

/** Album pages stream through their track ids, but the header needs a play-all context url. */
export function albumContextUrl(album: Pick<Album, 'id'>): string {
  return `${env.API_PUBLIC_URL.replace(/\/+$/, '')}/api/albums/${album.id}/play`;
}

/** Signed URL for a single track, used by `GET /api/tracks/:id/stream`. */
export async function streamUrlFor(app: FastifyInstance, key: string, user: SessionUser | null, download = false) {
  const ttl = env.STREAM_URL_TTL_SEC;
  if (download) return app.d7.storage.getSignedUrl(key, { expiresSec: ttl, download: true, filename: 'd7-track' });
  return app.d7.storage.getStreamUrl(key, { userId: user?.id ?? null, expiresSec: ttl });
}
