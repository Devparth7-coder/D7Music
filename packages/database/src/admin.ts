/** Admin dashboard data (spec §15) + content-safety operations (spec §27). */
import type { Db } from './client.js';
import { Sql } from './sql.js';
import { map } from './map.js';
import type { ReportedContent } from '@d7/types';

export async function getAdminCoreStats(db: Db) {
  const row = await db.queryOne<Record<string, any>>(
    `SELECT
       (SELECT count(*) FROM users)::int AS users_total,
       (SELECT count(*) FROM users WHERE last_seen_at > now() - interval '7 days')::int AS users_active_7d,
       (SELECT count(*) FROM users WHERE created_at > now() - interval '7 days')::int AS users_new_7d,
       (SELECT count(*) FROM subscriptions WHERE tier = 'premium' AND status IN ('active','trialing'))::int AS premium_users,
       (SELECT count(*) FROM tracks WHERE status = 'published')::int AS tracks,
       (SELECT count(*) FROM tracks WHERE storage_key IS NOT NULL AND streamable)::int AS streams_ready,
       (SELECT count(*) FROM tracks WHERE status IN ('draft','submitted','approved','scheduled'))::int AS awaiting_review,
       (SELECT count(*) FROM artists)::int AS artists,
       (SELECT count(*) FROM albums WHERE status = 'published')::int AS albums,
       (SELECT count(*) FROM playlists)::int AS playlists,
       (SELECT count(*) FROM lyrics)::int AS lyrics,
       (SELECT count(*) FROM new_releases WHERE release_date = now()::date)::int AS releases_24h,
       (SELECT count(*) FROM new_releases WHERE release_date > now()::date - 7)::int AS releases_7d,
       (SELECT count(*) FROM new_releases WHERE release_date > now()::date - 30)::int AS releases_30d,
       (SELECT count(*) FROM playback_events WHERE occurred_at > now() - interval '1 day')::int AS events_today,
       (SELECT coalesce(sum(played_ms),0)::bigint/60000 FROM playback_events WHERE occurred_at > now() - interval '1 day')::int AS minutes_today,
       (SELECT count(*) FROM playback_events WHERE occurred_at > now() - interval '1 day' AND event = 'track_completed')::int AS completes_today,
       (SELECT count(*) FROM playback_events WHERE occurred_at > now() - interval '1 day' AND event = 'track_skipped')::int AS skips_today,
       (SELECT count(*) FROM content_reports WHERE status = 'open')::int AS reports_open,
       (SELECT count(*) FROM content_reports)::int AS reports_total`,
  );
  const r = row ?? {};
  const completes = Number(r.completes_today ?? 0);
  const skips = Number(r.skips_today ?? 0);
  const topGenres = await db.query<{ genre: string; plays: number }>(
    `SELECT g.slug AS genre, count(*)::int AS plays
       FROM playback_events pe JOIN track_genres tg ON tg.track_id = pe.track_id JOIN genres g ON g.id = tg.genre_id
      WHERE pe.occurred_at > now() - interval '7 days'
      GROUP BY g.slug ORDER BY plays DESC LIMIT 8`,
  );
  const topTracks = await db.query<{ track_id: string; title: string; plays: number }>(
    `SELECT pe.track_id, t.title, count(*)::int AS plays
       FROM playback_events pe JOIN tracks t ON t.id = pe.track_id
      WHERE pe.occurred_at > now() - interval '7 days'
      GROUP BY pe.track_id, t.title ORDER BY plays DESC LIMIT 8`,
  );
  return {
    users: {
      total: Number(r.users_total ?? 0),
      activeLast7d: Number(r.users_active_7d ?? 0),
      premium: Number(r.premium_users ?? 0),
      newLast7d: Number(r.users_new_7d ?? 0),
    },
    catalog: {
      tracks: Number(r.tracks ?? 0),
      artists: Number(r.artists ?? 0),
      albums: Number(r.albums ?? 0),
      playlists: Number(r.playlists ?? 0),
      lyrics: Number(r.lyrics ?? 0),
      streamsReady: Number(r.streams_ready ?? 0),
      awaitingReview: Number(r.awaiting_review ?? 0),
    },
    releases: {
      last24h: Number(r.releases_24h ?? 0),
      last7d: Number(r.releases_7d ?? 0),
      last30d: Number(r.releases_30d ?? 0),
      followingCapable: true,
    },
    listening: {
      eventsToday: Number(r.events_today ?? 0),
      minutesStreamedToday: Number(r.minutes_today ?? 0),
      completionsToday: completes,
      skipRate: completes + skips > 0 ? Math.round((skips / (completes + skips)) * 1000) / 10 : 0,
      topGenres: topGenres.map((g) => ({ genre: g.genre, plays: Number(g.plays) })),
      topTracks: topTracks.map((t) => ({ trackId: String(t.track_id), title: t.title, plays: Number(t.plays) })),
    },
    reports: { open: Number(r.reports_open ?? 0), total: Number(r.reports_total ?? 0) },
  };
}

export async function getProviderStatusRows(db: Db) {
  return db.query<Record<string, any>>(
    `SELECT mp.name, mp.kind, mp.enabled, mp.capability, mp.rate_limit_rps, mp.last_success_at::text, mp.last_error, mp.notes, mp.terms_url,
            coalesce(ph.state,'unknown') AS state, ph.latency_ms, ph.success_count, ph.failure_count, ph.consecutive_failures,
            ph.last_check_at::text AS last_check_at, ph.last_error AS health_error
       FROM music_providers mp
       LEFT JOIN provider_health ph ON ph.provider = mp.name
       ORDER BY mp.kind, mp.name`,
  );
}

export async function getSyncStatus(db: Db, intervalMin: number) {
  const last = await db.queryOne<Record<string, any>>(`SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 1`);
  const cursors = await db.query<Record<string, any>>(
    `SELECT c.provider, c.job, c.cursor, c.next_run_at::text, c.consecutive_failures, c.last_run_at::text,
            coalesce(sum(pe.success_count),0)::int AS successes
       FROM sync_cursors c LEFT JOIN provider_health pe ON pe.provider = c.provider
      GROUP BY c.provider, c.job, c.cursor, c.next_run_at, c.consecutive_failures, c.last_run_at
      ORDER BY c.provider`,
  );
  const failed = await db.query<Record<string, any>>(
    `SELECT * FROM sync_runs WHERE status IN ('failed','partial') ORDER BY started_at DESC LIMIT 10`,
  );
  const { mapSyncRun } = await import('./map.js');
  return {
    lastRun: last ? mapSyncRun(last) : null,
    cursors,
    failedRuns: failed.map(mapSyncRun),
    everyMs: intervalMin * 60_000,
  };
}

/* ------------------------------ content admin ------------------------------ */

export async function listCatalogForAdmin(
  db: Db,
  opts: { type: 'tracks' | 'albums' | 'artists'; q?: string; status?: string; license?: string; limit?: number; offset?: number },
) {
  const limit = Math.min(opts.limit ?? 25, 100);
  const q = new Sql();
  const lim = q.bind(limit);
  const off = q.bind(opts.offset ?? 0);
  if (opts.type === 'albums') {
    const filters: string[] = [];
    if (opts.q) filters.push(`d7_normalize_text(al.title) LIKE '%' || ${q.bind(opts.q.toLowerCase())} || '%'`);
    if (opts.status) filters.push(`al.status = ${q.bind(opts.status)}`);
    if (opts.license) filters.push(`al.license_status = ${q.bind(opts.license)}`);
    const rows = await db.query<Record<string, any>>(
      `SELECT al.id, al.title, al.status, al.license_status, al.content_source, al.release_date::text, al.added_at::text,
              al.upc, al.copyright_note, al.image_url, ar.name AS artist_name,
              (SELECT count(*) FROM tracks t WHERE t.album_id = al.id)::int AS track_count
         FROM albums al JOIN artists ar ON ar.id = al.artist_id
         ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
        ORDER BY al.added_at DESC LIMIT ${lim} OFFSET ${off}`,
      q.values,
    );
    const total = await db.queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM albums`);
    return { items: rows, total: Number(total?.c ?? 0) };
  }
  if (opts.type === 'artists') {
    const filters: string[] = [];
    if (opts.q) filters.push(`d7_normalize_text(ar.name) LIKE '%' || ${q.bind(opts.q.toLowerCase())} || '%'`);
    const rows = await db.query<Record<string, any>>(
      `SELECT ar.id, ar.name, ar.slug, ar.verified, ar.verified_kind, ar.popularity, ar.monthly_listeners, ar.followers_count,
              (SELECT count(*) FROM albums al WHERE al.artist_id = ar.id)::int AS album_count,
              (SELECT count(*) FROM tracks t WHERE t.primary_artist_id = ar.id)::int AS track_count,
              (SELECT jsonb_agg(p.provider) FROM provider_artists p WHERE p.artist_id = ar.id) AS providers,
              ar.created_at::text
         FROM artists ar ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
        ORDER BY ar.popularity DESC LIMIT ${lim} OFFSET ${off}`,
      q.values,
    );
    const total = await db.queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM artists`);
    return { items: rows, total: Number(total?.c ?? 0) };
  }
  const filters: string[] = [];
  if (opts.q) filters.push(`d7_normalize_text(t.title) LIKE '%' || ${q.bind(opts.q.toLowerCase())} || '%'`);
  if (opts.status) filters.push(`t.status = ${q.bind(opts.status)}`);
  if (opts.license) filters.push(`t.license_status = ${q.bind(opts.license)}`);
  const rows = await db.query<Record<string, any>>(
    `SELECT t.id, t.title, t.status, t.license_status, t.content_source, t.streamable, t.duration_ms, t.isrc,
            t.provider_name, t.provider_track_id, t.storage_key, t.mime_type, t.byte_size, t.play_count, t.added_at::text,
            al.title AS album_title, ar.name AS artist_name, ar.id AS artist_id
       FROM tracks t JOIN albums al ON al.id = t.album_id JOIN artists ar ON ar.id = t.primary_artist_id
       ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY t.added_at DESC LIMIT ${lim} OFFSET ${off}`,
    q.values,
  );
  const total = await db.queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM tracks`);
  return { items: rows, total: Number(total?.c ?? 0) };
}

/** Licensing decision: the ONLY way a track becomes streamable from admin land. */
export async function setTrackLicense(db: Db, trackId: string, patch: { licenseStatus?: string; streamable?: boolean; status?: string; note?: string; by: string }) {
  const sets: string[] = ['updated_at = now()'];
  const params: unknown[] = [];
  const bind = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (patch.licenseStatus) sets.push(`license_status = ${bind(patch.licenseStatus)}`);
  if (patch.status) sets.push(`status = ${bind(patch.status)}`);
  if (patch.streamable !== undefined) sets.push(`streamable = ${bind(patch.streamable)}`);
  params.push(trackId);
  const res = await db.execute(`UPDATE tracks SET ${sets.join(', ')} WHERE id = $${params.length}::uuid`, params);
  if (patch.licenseStatus && res > 0) {
    await db.execute(
      `INSERT INTO licenses (id, entity_type, entity_id, holder, status, start_date, notes, recorded_by, created_at, updated_at)
       VALUES (d7_uuid(), 'track', $1::uuid, 'platform', $2, now()::date, $3, $4::uuid, now(), now())
       ON CONFLICT (entity_type, entity_id, holder, start_date) DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes`,
      [trackId, patch.licenseStatus, patch.note ?? 'admin decision', patch.by],
    );
  }
  return res;
}

export async function setAlbumStatus(db: Db, albumId: string, patch: { status?: string; licenseStatus?: string; streamable?: boolean }) {
  const sets: string[] = ['updated_at = now()'];
  const params: unknown[] = [];
  const bind = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (patch.status) sets.push(`status = ${bind(patch.status)}`);
  if (patch.licenseStatus) sets.push(`license_status = ${bind(patch.licenseStatus)}`);
  if (patch.streamable !== undefined) sets.push(`license_status = CASE WHEN ${bind(!!patch.streamable)} THEN license_status ELSE 'unlicensed' END`);
  const idToken = bind(albumId);
  const res = await db.execute(`UPDATE albums SET ${sets.join(', ')} WHERE id = ${idToken}::uuid`, params);
  // Album-level decisions cascade to its tracks so nothing stays playable after a takedown.
  if (patch.status || patch.streamable === false) {
    const cascade: string[] = ['updated_at = now()'];
    const cp: unknown[] = [albumId];
    if (patch.status) cascade.push(`status = $${cp.length + 1}`), cp.push(patch.status);
    if (patch.streamable === false) cascade.push('streamable = false');
    else if (patch.streamable === true) cascade.push(`streamable = (storage_key IS NOT NULL AND license_status = 'licensed')`);
    cp.push(albumId);
    await db.execute(`UPDATE tracks SET ${cascade.join(', ')} WHERE album_id = $1::uuid`, cp);
  }
  return res;
}

export async function listReportedContent(db: Db, opts: { status?: string; limit?: number } = {}): Promise<ReportedContent[]> {
  const rows = await db.query<Record<string, any>>(
    `SELECT cr.id, cr.entity_type, cr.entity_id, cr.reason, cr.details, cr.status, cr.created_at, cr.resolved_at,
            u.id AS reporter_id, u.username AS reporter_username,
            coalesce(t.title, al.title, ar.name, p.title, 'Unknown') AS entity_title
       FROM content_reports cr
       LEFT JOIN users u ON u.id = cr.reporter_id
       LEFT JOIN tracks t ON cr.entity_type = 'track' AND t.id = cr.entity_id
       LEFT JOIN albums al ON cr.entity_type = 'album' AND al.id = cr.entity_id
       LEFT JOIN artists ar ON cr.entity_type = 'artist' AND ar.id = cr.entity_id
       LEFT JOIN playlists p ON cr.entity_type = 'playlist' AND p.id = cr.entity_id
       WHERE ($1::text IS NULL OR cr.status = $1)
      ORDER BY cr.created_at DESC LIMIT $2`,
    [opts.status ?? null, Math.min(opts.limit ?? 50, 200)],
  );
  return rows.map((r) => ({
    id: String(r.id),
    entityType: r.entity_type,
    entityId: String(r.entity_id),
    entityTitle: String(r.entity_title),
    reason: r.reason,
    details: r.details ?? null,
    status: r.status,
    reporter: r.reporter_id ? { id: String(r.reporter_id), username: String(r.reporter_username) } : null,
    createdAt: map.iso(r.created_at),
    resolvedAt: r.resolved_at ? map.iso(r.resolved_at) : null,
  }));
}

export async function createContentReport(db: Db, input: { reporterId: string | null; entityType: 'track' | 'album' | 'artist' | 'playlist'; entityId: string; reason: string; details?: string | null }) {
  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO content_reports (id, reporter_id, entity_type, entity_id, reason, details, status, created_at, updated_at)
     VALUES (d7_uuid(), $1::uuid, $2, $3::uuid, $4, $5, 'open', now(), now()) RETURNING id`,
    [input.reporterId, input.entityType, input.entityId, input.reason, input.details ?? null],
  );
  return String(row!.id);
}

export async function updateContentReport(db: Db, id: string, patch: { status: 'open' | 'reviewing' | 'actioned' | 'dismissed'; resolution?: string | null; by: string }) {
  const res = await db.execute(
    `UPDATE content_reports SET status = $2, resolution = $3, resolved_by = $4::uuid,
            resolved_at = CASE WHEN $2 IN ('actioned','dismissed') THEN now() ELSE NULL END, updated_at = now()
      WHERE id = $1::uuid`,
    [id, patch.status, patch.resolution ?? null, patch.by],
  );
  return res > 0;
}

export async function listUsersForAdmin(db: Db, opts: { q?: string; limit?: number; offset?: number } = {}) {
  const limit = Math.min(opts.limit ?? 25, 100);
  const rows = await db.query<Record<string, any>>(
    `SELECT u.id, u.username, u.email, u.role, u.status, u.email_verified, u.created_at::text, u.last_seen_at::text,
            coalesce(s.tier,'free') AS tier,
            (SELECT count(*) FROM liked_tracks lt WHERE lt.user_id = u.id)::int AS liked_count,
            (SELECT count(*) FROM playback_events pe WHERE pe.user_id = u.id)::int AS events
       FROM users u
       LEFT JOIN LATERAL (SELECT tier FROM subscriptions sub WHERE sub.user_id = u.id AND sub.status IN ('active','trialing','past_due') ORDER BY sub.created_at DESC LIMIT 1) s ON true
       WHERE ($1::text IS NULL OR d7_normalize_text(u.username) LIKE '%' || $1 || '%' OR d7_normalize_text(u.email) LIKE '%' || $1 || '%')
       ORDER BY u.created_at DESC LIMIT $2 OFFSET $3`,
    [opts.q ? opts.q.toLowerCase() : null, limit, opts.offset ?? 0],
  );
  const total = await db.queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM users`);
  return { items: rows, total: Number(total?.c ?? 0) };
}

export async function setUserStatus(db: Db, userId: string, status: 'active' | 'suspended' | 'deleted') {
  return db.execute(`UPDATE users SET status = $2, updated_at = now() WHERE id = $1::uuid`, [userId, status]);
}
