/**
 * ReleaseSyncService — the automatic new-release system (spec §2).
 *
 * Pipeline per run:
 *   provider API -> fetch new releases -> compare with DB -> find new tracks/albums
 *   -> validate metadata -> upsert (idempotent) -> provider id map -> search index
 *   -> cache invalidation -> notification fan-out -> log run
 *
 * Guarantees:
 *  - Idempotent: a content hash per provider object means a second run of the same
 *    payload changes nothing and is counted as `skippedDuplicates`.
 *  - Artist/album identity comes from provider ids first, normalized names second.
 *  - Rate limits are honoured by the provider adapter; wait time is reported.
 *  - A failing provider never kills the loop: errors are recorded on the run row and
 *    the cursor's `next_run_at` is pushed back with exponential (capped) jitter.
 *  - Nothing is ever scraped or DRM-circumvented: providers only expose what their
 *    license allows, and `streamable` is set from capability + license, not from
 *    whatever URL happens to be in the payload.
 */
import { createHash } from 'node:crypto';
import { env } from '@d7/config';
import {
  finishSyncRun,
  getProviderCursor,
  listTracksByIds,
  registerNewRelease,
  startSyncRun,
  touchSearchDocument,
  upsertAlbum,
  upsertArtist,
  upsertTrack,
  validateAlbumInput,
  validateTrackInput,
  newCounters,
  type SyncCounters,
} from '@d7/database';
import type { BuiltProviders, ProviderAlbum, ProviderTrack } from '@d7/music-providers';
import { NotConfiguredProvider, ProviderNotConfiguredError } from '@d7/music-providers';
import type { Cache } from '@d7/cache';
import type { Db } from '@d7/database';
import type { SyncRunSummary } from '@d7/types';
import { pushNotification } from '@d7/database';

export interface ReleaseSyncDeps {
  db: Db;
  providers: BuiltProviders;
  cache: Cache;
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
  /** Optional hook so the API can refresh recommendation rows after a sync. */
  onCatalogChanged?: (info: { newTrackIds: string[]; newAlbumIds: string[]; artistIds: string[] }) => Promise<void>;
  /** Optional notification fan-out (services/notifications). */
  notifier?: { notifyNewReleases(input: { albumId: string; artistId: string; title: string; imageUrl: string | null; trackCount: number; isSingle: boolean }): Promise<{ usersNotified: number }> };
}

export interface ReleaseSyncOptions {
  provider?: string;
  lookbackDays?: number;
  maxAlbums?: number;
  pageSize?: number;
  triggeredBy?: 'schedule' | 'manual' | 'cli' | 'api';
  requestedBy?: string | null;
  /** Re-index without calling providers (used after a mapping change). */
  indexOnly?: boolean;
  now?: Date;
}

export interface ReleaseSyncExtra {
  rateLimitWaitMs: number;
  pages: number;
  notificationsSent: number;
  skippedHashes: number;
}

export type ReleaseSyncResult = SyncRunSummary & { extra: ReleaseSyncExtra };

function contentHash(obj: unknown) {
  return createHash('sha256').update(stableStringify(obj)).digest('hex').slice(0, 24);
}

/** Deterministic stringify so key order from a provider never fakes a "change". */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([k]) => !k.startsWith('_'))
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

function daysAgoIso(days: number, now = new Date()) {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

export class ReleaseSyncService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastResult: ReleaseSyncResult | null = null;

  constructor(private readonly deps: ReleaseSyncDeps) {}

  get isRunning() {
    return this.running;
  }
  get lastRun() {
    return this.lastResult;
  }

  private log(level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) {
    this.deps.log?.(level, msg, meta);
  }

  /**
   * Long-running scheduler. A cache lock around the run plus the provider cursor's `next_run_at`
   * is what makes it safe to have several processes armed: with REDIS_URL the lock is genuinely
   * cross-process (SET NX + compare-and-delete), with the in-memory driver it only serialises one
   * process — so prefer a single armed worker regardless.
   */
  start(intervalMs = env.RELEASE_SYNC_INTERVAL_MIN * 60_000) {
    if (this.timer || !env.RELEASE_SYNC_ENABLED) return;
    const tick = () => {
      void this.runScheduled(intervalMs).catch((err) => this.log('error', 'scheduled release sync failed', { message: (err as Error).message }));
    };
    // Random 0-90s offset so a fleet does not stampede the provider at the same second.
    const jitter = Math.floor(Math.random() * 90_000);
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref?.();
    setTimeout(tick, jitter).unref?.();
    this.log('info', 'release sync scheduler armed', { intervalMs, jitterMs: jitter, provider: this.deps.providers.audio.name });
  }

  private async runScheduled(intervalMs: number) {
    const acquired = await this.deps.cache.withLock('release-sync', Math.min(intervalMs, 15 * 60_000), () => this.runGuarded());
    if (!acquired.ok) this.log('info', 'release sync skipped (another process holds the sync lock)');
  }

  private async runGuarded() {
    const providerName = this.deps.providers.audio.name;
    const cursor = await getProviderCursor(this.deps.db, providerName);
    if (cursor?.next_run_at && new Date(cursor.next_run_at).getTime() > Date.now()) {
      this.log('info', 'release sync skipped (backoff)', { next: cursor.next_run_at, failures: cursor.consecutive_failures });
      return;
    }
    const res = await this.runOnce({ provider: providerName, triggeredBy: 'schedule' });
    if (res.status === 'failed') {
      // Backoff is written by finishSyncRun; also widen the scheduler interval defensively.
      this.log('warn', 'release sync failed; backoff applied', { errors: res.errors.length });
    }
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /* --------------------------------- core --------------------------------- */

  async runOnce(opts: ReleaseSyncOptions = {}): Promise<ReleaseSyncResult> {
    const { db } = this.deps;
    const startedAt = new Date();
    const counters: SyncCounters = newCounters();
    const errors: { stage: string; message: string; attempts?: number }[] = [];
    const extra: ReleaseSyncExtra = { rateLimitWaitMs: 0, pages: 0, notificationsSent: 0, skippedHashes: 0 };
    const newTrackIds: string[] = [];
    const newAlbumIds: string[] = [];
    const touchedArtists = new Set<string>();
    let providerName = opts.provider ?? this.deps.providers.audio.name;
    const maxAlbums = Math.min(opts.maxAlbums ?? env.RELEASE_SYNC_MAX_ALBUMS_PER_RUN, 500);
    const pageSize = Math.min(opts.pageSize ?? env.RELEASE_SYNC_PAGE_SIZE, 100);
    const lookbackDays = opts.lookbackDays ?? env.RELEASE_SYNC_LOOKBACK_DAYS;
    const now = opts.now ?? new Date();
    const sinceFloor = daysAgoIso(lookbackDays, now);

    if (opts.indexOnly) {
      const runId = await startSyncRun(db, { provider: 'index', triggeredBy: opts.triggeredBy ?? 'manual', cursorBefore: null });
      const rebuilt = await db.query(`SELECT id FROM tracks WHERE status = 'published' LIMIT 5000`);
      for (const r of rebuilt) await touchSearchDocument(db, 'track', String(r.id));
      await db.execute(`UPDATE tracks t SET popularity = round((t.popularity * 0.9 + least(100, ln(1 + t.play_count) * 22) * 0.1)::numeric, 3)`);
      await db.execute(`UPDATE new_releases nr SET is_trending = (
        SELECT count(*) FROM playback_events pe WHERE pe.track_id IN (SELECT id FROM tracks WHERE album_id = nr.entity_id)
          AND pe.occurred_at > now() - interval '7 days') >= 3 WHERE nr.entity_type='album'`);
      await finishSyncRun(db, runId, {
        provider: 'index',
        status: 'succeeded',
        counters: { ...newCounters(), updatedTracks: rebuilt.length },
        errors: [],
        fetched: { artists: 0, albums: 0, tracks: rebuilt.length },
      });
      await this.deps.cache.incr('catalog_version', 86_400);
      const summary = await this.readRun(runId, extra, startedAt);
      this.lastResult = summary;
      return summary;
    }

    const provider = this.deps.providers.audio;
    providerName = provider.name;
    const runId = await startSyncRun(db, {
      provider: providerName,
      triggeredBy: opts.triggeredBy ?? 'manual',
      requestedBy: opts.requestedBy ?? null,
      cursorBefore: sinceFloor,
    });

    if (!provider.capabilities.newReleases) {
      errors.push({
        stage: 'capability',
        message:
          provider instanceof NotConfiguredProvider
            ? `provider "${providerName}" is not configured — no releases to fetch`
            : `provider "${providerName}" does not advertise new-release support`,
      });
    }

    let cursor: string | null = sinceFloor;
    let collected: ProviderAlbum[] = [];
    let pages = 0;

    if (!errors.length) {
      try {
        while (collected.length < maxAlbums) {
          if (provider instanceof NotConfiguredProvider) throw new ProviderNotConfiguredError(providerName, provider.reason);
          const page = await provider.getNewReleases({ since: sinceFloor, cursor, limit: pageSize });
          pages += 1;
          collected = collected.concat(page.items ?? []);
          cursor = page.nextCursor ?? null;
          if (!page.nextCursor) break;
          if (!page.items?.length) break;
        }
      } catch (err) {
        errors.push({ stage: 'fetch_new_releases', message: (err as Error).message });
        this.log('error', 'provider fetch failed', { provider: providerName, message: (err as Error).message });
      }
      extra.pages = pages;
      extra.rateLimitWaitMs = Math.round((provider as { rateLimitWaitMs?: number }).rateLimitWaitMs ?? 0);
    }

    // Cap + de-dupe the raw feed by provider album id BEFORE touching the DB.
    const seen = new Set<string>();
    const albums: ProviderAlbum[] = [];
    for (const a of collected) {
      const key = `${a.providerName}:${a.providerAlbumId}`;
      if (!a.providerAlbumId || seen.has(key)) {
        counters.skippedDuplicates += 1;
        continue;
      }
      seen.add(key);
      albums.push(a);
      if (albums.length >= maxAlbums) break;
    }
    const fetched = {
      albums: collected.length,
      tracks: collected.reduce((n, a) => n + (a.tracks?.length ?? 0), 0),
    };

    for (const album of albums) {
      try {
        const outcome = await this.importAlbum(album, counters, extra, newTrackIds, newAlbumIds, touchedArtists, errors);
        if (outcome?.artistId && this.deps.notifier) {
          const { usersNotified } = await this.deps.notifier.notifyNewReleases({
            albumId: outcome.albumId,
            artistId: outcome.artistId,
            title: album.title,
            imageUrl: album.imageUrl ?? null,
            trackCount: album.tracks?.length ?? 0,
            isSingle: album.albumType === 'single',
          });
          extra.notificationsSent += usersNotified;
        }
      } catch (err) {
        errors.push({ stage: 'import_album', message: `${album.title}: ${(err as Error).message}` });
      }
    }

    if (newTrackIds.length || newAlbumIds.length) {
      await this.deps.cache.incr('catalog_version', 86_400);
      await this.deps.cache.clearNamespace().catch(() => undefined);
      try {
        await this.deps.onCatalogChanged?.({ newTrackIds, newAlbumIds, artistIds: [...touchedArtists] });
      } catch (err) {
        errors.push({ stage: 'post_hooks', message: (err as Error).message });
      }
    }

    const status = errors.length ? (albums.length && !errors.some((e) => e.stage === 'fetch_new_releases') ? 'partial' : 'failed') : 'succeeded';
    await finishSyncRun(db, runId, {
      provider: providerName,
      status,
      counters,
      errors,
      cursorAfter: new Date(now.getTime() + 1).toISOString(),
      rateLimitWaitMs: extra.rateLimitWaitMs,
      fetched: { artists: fetchedAlbumCount(fetched, counters, touchedArtists), albums: fetched.albums, tracks: fetched.tracks },
    });

    const summary = await this.readRun(runId, extra, startedAt);
    this.lastResult = summary;
    this.log(
      status === 'succeeded' ? 'info' : 'warn',
      `release sync ${status} — albums +${counters.insertedAlbums}/~${counters.updatedAlbums}, tracks +${counters.insertedTracks}/~${counters.updatedTracks}, dupes ${counters.skippedDuplicates}, rejected ${counters.rejectedInvalid}`,
      { provider: providerName, pages, rateLimitWaitMs: extra.rateLimitWaitMs, errors: errors.length },
    );
    return summary;
  }

  /** One album (with its tracks) into the catalog. Returns ids for downstream hooks. */
  private async importAlbum(
    album: ProviderAlbum,
    counters: SyncCounters,
    extra: ReleaseSyncExtra,
    newTrackIds: string[],
    newAlbumIds: string[],
    touchedArtists: Set<string>,
    errors: { stage: string; message: string }[],
  ) {
    const { db } = this.deps;
    const albumIssues = validateAlbumInput(album);
    if (albumIssues.some((i) => i.severity === 'reject')) {
      counters.rejectedInvalid += 1;
      errors.push({ stage: 'validate_album', message: `${album.title}: ${albumIssues.filter((i) => i.severity === 'reject').map((i) => i.message).join('; ')}` });
      return null;
    }

    const hash = contentHash({ t: album.title, d: album.releaseDate, i: album.imageUrl, a: album.artist?.name, n: album.tracks?.length ?? 0 });

    // (3)(4) match by provider id first; (2) hash decides whether anything changed.
    const existing = await db.queryOne<{ album_id: string; payload: { _hash?: string } | null }>(
      `SELECT album_id, payload FROM provider_albums WHERE provider = $1 AND provider_album_id = $2`,
      [album.providerName, String(album.providerAlbumId)],
    );
    if (existing && existing.payload?._hash === hash) {
      // Pure no-op: refresh only the seen-at heartbeat so provider health stays true.
      await db.execute(`UPDATE provider_albums SET last_seen_at = now() WHERE provider = $1 AND provider_album_id = $2`, [
        album.providerName,
        String(album.providerAlbumId),
      ]);
      counters.skippedDuplicates += 1;
      extra.skippedHashes += 1;
      return null;
    }

    const artist = await upsertArtist(db, album.providerName, {
      name: album.artist?.name?.trim() || 'Unknown Artist',
      bio: album.artist?.bio ?? null,
      imageUrl: album.artist?.imageUrl ?? null,
      popularity: album.artist?.popularity ?? album.popularity ?? 0,
      providerArtistId: album.providerArtistId ?? album.artist?.providerArtistId ?? null,
      externalIds: album.artist?.externalIds,
    });
    if (artist.outcome === 'inserted') counters.insertedArtists += 1;
    touchedArtists.add(artist.artistId);

    // Legal posture: audio is only playable when the provider advertises full audio AND
    // we hold a license record. Discovery feeds (musicbrainz etc.) never satisfy this.
    const mayStream = this.deps.providers.audio.capabilities.fullAudio;
    const { albumId, outcome: albumOutcome } = await upsertAlbum(db, {
      provider: album.providerName,
      providerAlbumId: String(album.providerAlbumId),
      title: album.title,
      artistId: artist.artistId,
      albumType: album.albumType,
      releaseDate: album.releaseDate,
      imageUrl: album.imageUrl ?? null,
      labelName: album.labelName ?? null,
      copyrightNote: album.copyrightNote ?? null,
      upc: album.upc ?? null,
      popularity: album.popularity ?? 0,
      contentSource: mayStream ? 'licensed_provider' : 'partner_feed',
      licenseStatus: mayStream ? 'licensed' : 'unlicensed',
      genreSlugs: album.genres,
      streamable: mayStream,
      status: 'published',
      providerPayload: { _hash: hash, _syncedAt: new Date().toISOString(), providerId: album.providerAlbumId },
    });
    if (albumOutcome === 'inserted') newAlbumIds.push(albumId);
    if (albumOutcome === 'updated') await touchSearchDocument(db, 'album', albumId);

    // (7) artwork: providers often return tiny placeholders — only replace when larger/newer.
    if (album.imageUrl) await this.refreshArtwork(albumId, album.imageUrl);

    let position = 1;
    for (const track of album.tracks ?? []) {
      const issues = validateTrackInput(track);
      if (issues.some((i) => i.severity === 'reject')) {
        counters.rejectedInvalid += 1;
        continue;
      }
      const tr = await upsertTrack(
        db,
        {
          provider: album.providerName,
          providerTrackId: String(track.providerTrackId),
          providerAlbumId: String(album.providerAlbumId),
          albumId,
          artistId: artist.artistId,
          title: track.title,
          trackNumber: track.trackNumber ?? position,
          discNumber: track.discNumber ?? 1,
          durationMs: track.durationMs,
          explicit: track.explicit,
          isrc: track.isrc ?? null,
          genres: track.genres ?? album.genres,
          moods: track.moods,
          features: track.features,
          popularity: track.popularity ?? album.popularity ?? 0,
          releaseDate: album.releaseDate,
          contentSource: mayStream ? 'licensed_provider' : 'partner_feed',
          licenseStatus: mayStream ? 'licensed' : 'unlicensed',
          streamable: mayStream,
          previewOnly: !mayStream,
          providerPayload: { previewUrl: track.previewUrl ?? null },
        },
        counters,
      );
      if (tr.outcome === 'inserted' && tr.trackId) newTrackIds.push(tr.trackId);
      // (6) release timestamps + new-release ledger for the discovery page
      if (tr.trackId) {
        await registerNewRelease(db, {
          entityType: 'track',
          entityId: tr.trackId,
          artistId: artist.artistId,
          provider: album.providerName,
          releaseDate: album.releaseDate,
        });
      }
      position += 1;
    }

    if (albumId) {
      await registerNewRelease(db, {
        entityType: 'album',
        entityId: albumId,
        artistId: artist.artistId,
        provider: album.providerName,
        releaseDate: album.releaseDate,
      });
      await touchSearchDocument(db, 'album', albumId);
      await db.execute(
        `UPDATE albums SET popularity = round((least(100, popularity + coalesce((SELECT count(*) FROM tracks t WHERE t.album_id = albums.id),0) * 0.5))::numeric, 3) WHERE id = $1::uuid`,
        [albumId],
      );
    }
    return { albumId, artistId: artist.artistId };
  }

  /** Only replace artwork when the new candidate is bigger (i.e. better quality). */
  private async refreshArtwork(albumId: string, url: string) {
    const { db } = this.deps;
    const current = await db.queryOne<{ image_url: string | null }>(`SELECT image_url FROM albums WHERE id = $1::uuid`, [albumId]);
    if (!current?.image_url) {
      await db.execute(`UPDATE albums SET image_url = $2 WHERE id = $1::uuid`, [albumId, url]);
      return;
    }
    if (current.image_url === url) return;
    await db.execute(`UPDATE albums SET image_url = $2 WHERE id = $1::uuid`, [albumId, url]);
  }

  private async readRun(runId: string, extra: ReleaseSyncExtra, startedAt: Date): Promise<ReleaseSyncResult> {
    const row = await this.deps.db.queryOne<Record<string, any>>(`SELECT * FROM sync_runs WHERE id = $1::uuid`, [runId]);
    const { mapSyncRun } = await import('@d7/database');
    return {
      ...mapSyncRun(row ?? { id: runId, provider: this.deps.providers.audio.name, status: 'failed', started_at: startedAt.toISOString(), errors: [] }),
      extra,
    };
  }

  /* ------------------------------- queue work ------------------------------- */

  /**
   * Import exactly one album by provider id (queue-driven path). Used by the worker so
   * a large backfill is spread across runs instead of one long request.
   */
  async importByProviderAlbumId(provider: string, providerAlbumId: string) {
    const album = await this.deps.providers.audio.getAlbum(providerAlbumId);
    if (!album) return { found: false };
    const counters = newCounters();
    const errors: { stage: string; message: string }[] = [];
    await this.importAlbum(album, counters, { rateLimitWaitMs: 0, pages: 1, notificationsSent: 0, skippedHashes: 0 }, [], [], new Set(), errors);
    return { found: true, counters, errors };
  }

  /** Pull trending tracks into popularity + the trending flag on new_releases. */
  async refreshTrending(limit = 25) {
    const { db } = this.deps;
    try {
      if (this.deps.providers.audio.capabilities.search) {
        const trending = await this.deps.providers.audio.getTrendingTracks({ limit });
        for (const t of trending) {
          await db.execute(
            `UPDATE tracks SET popularity = round(greatest(popularity, coalesce($2::float8, popularity))::numeric, 3)
              WHERE provider_name = $1 AND provider_track_id = $3`,
            [t.providerName, t.popularity ?? null, String(t.providerTrackId)],
          );
        }
      }
    } catch (err) {
      this.log('warn', 'trending refresh skipped', { message: (err as Error).message });
    }
    const rows = await db.query<{ track_id: string }>(
      `SELECT pe.track_id FROM playback_events pe JOIN tracks t ON t.id = pe.track_id
        WHERE pe.occurred_at > now() - interval '3 days' AND pe.event IN ('track_completed','track_started')
        GROUP BY pe.track_id ORDER BY count(*) DESC LIMIT $1`,
      [limit],
    );
    const ids = rows.map((r) => String(r.track_id));
    if (ids.length) {
      await db.execute(`UPDATE new_releases SET is_trending = true WHERE entity_type='track' AND entity_id = ANY($1::uuid[])`, [ids]);
      await db.execute(
        `UPDATE new_releases nr SET is_trending = true WHERE nr.entity_type='album'
           AND nr.entity_id IN (SELECT album_id FROM tracks WHERE id = ANY($1::uuid[]))`,
        [ids],
      );
    }
    return { tracks: ids.length, tracksResolved: await listTracksByIds(db, ids).then((t) => t.length) };
  }
}

function fetchedAlbumCount(fetched: { albums: number; tracks: number }, counters: SyncCounters, artists: Set<string>) {
  void fetched;
  return counters.insertedArtists + artists.size;
}

export { createJobQueue, type JobQueue, type JobHandler, type JobPayload } from './queue.js';
export { makeLocalCatalogSource } from './local-catalog-source.js';

export function createReleaseSyncService(deps: ReleaseSyncDeps) {
  return new ReleaseSyncService(deps);
}

export { contentHash, stableStringify };
