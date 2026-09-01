/**
 * Playback telemetry pipeline (spec §25).
 *
 * Batching contract with the client: the player flushes an event buffer, so we write
 * one multi-row INSERT plus a handful of aggregate UPDATEs per flush — never one write
 * per second of listening. `progress_heartbeat` events are deliberately NOT appended to
 * the event log; they only advance the resume position.
 */
import type { Db } from './client.js';
import type { PlaybackEvent } from '@d7/types';

export interface IngestResult {
  accepted: number;
  ignored: number;
  uniqueTracks: number;
  countsByType: Record<string, number>;
}

const LOGGED_EVENTS = new Set<PlaybackEvent['type']>([
  'track_started',
  'track_completed',
  'track_skipped',
  'track_replayed',
  'track_liked',
  'track_unliked',
  'track_added_to_playlist',
]);

/** A skip is only meaningful if the user actually listened for a bit. */
function playedMs(e: PlaybackEvent) {
  if (e.type === 'track_completed') return e.durationMs;
  if (e.type === 'track_skipped') return Math.min(e.positionMs, e.durationMs);
  if (e.type === 'track_replayed') return e.positionMs;
  return 0;
}

export async function ingestPlaybackEvents(db: Db, events: PlaybackEvent[], viewer: { userId?: string | null; anonymousId?: string | null; device?: string | null }): Promise<IngestResult> {
  const countsByType: Record<string, number> = {};
  let accepted = 0;
  let ignored = 0;

  const resumeCandidates = events.filter((e) => e.type === 'progress_heartbeat' && e.positionMs > 0);
  for (const e of events) countsByType[e.type] = (countsByType[e.type] ?? 0) + 1;

  const logged = events.filter((e) => LOGGED_EVENTS.has(e.type) && e.trackId);
  // De-dupe replays of the same track within the same flush (double-fire on React strict mode,
  // reconnects, and back-to-back autoplay must not inflate counts).
  const seen = new Set<string>();
  const clean = logged.filter((e) => {
    const key = `${e.trackId}|${e.type}`;
    if (e.type === 'progress_heartbeat') return false;
    if (seen.has(key) && e.type !== 'track_replayed') return false;
    seen.add(key);
    return true;
  });

  if (!clean.length && !resumeCandidates.length) return { accepted: 0, ignored: events.length, uniqueTracks: 0, countsByType };

  await db.transaction(async (tx) => {
    if (clean.length) {
      const values: string[] = [];
      const params: unknown[] = [];
      const push = (v: unknown) => {
        params.push(v);
        return `$${params.length}`;
      };
      for (const e of clean) {
        values.push(
          `(${push(viewer.userId ?? null)}::uuid, ${push(viewer.anonymousId ?? null)}, ${push(e.trackId)}::uuid, ${push(e.type)},
            ${push(e.context?.type ?? 'unknown')}, ${push('id' in (e.context ?? {}) ? (e.context as { id: string }).id : null)},
            ${push(Math.max(0, Math.round(e.positionMs || 0)))}, ${push(Math.max(0, Math.round(e.durationMs || 0)))},
            ${push(playedMs(e))}, ${push(!!e.shuffle)}, ${push(e.repeat ?? 'off')}, ${push(viewer.device ?? null)},
            ${push(e.source ?? null)}, ${push(e.occurredAt || new Date().toISOString())}::timestamptz)`,
        );
      }
      await tx.execute(
        `INSERT INTO playback_events (user_id, anonymous_id, track_id, event, context_type, context_id,
                                      position_ms, duration_ms, played_ms, shuffle, repeat_mode, device, source, occurred_at)
         VALUES ${values.join(',')}`,
        params,
      );

      if (viewer.userId) {
        // 1) listening history (dedup per user+track, accumulates)
        const agg = new Map<string, { plays: number; ms: number; completes: number; skips: number; lastCtx: string; lastCtxId: string | null; lastAt: string }>();
        for (const e of clean) {
          const a = agg.get(e.trackId) ?? { plays: 0, ms: 0, completes: 0, skips: 0, lastCtx: e.context?.type ?? 'unknown', lastCtxId: 'id' in (e.context ?? {}) ? String((e.context as { id: string }).id) : null, lastAt: e.occurredAt || new Date().toISOString() };
          if (e.type === 'track_started' || e.type === 'track_replayed') a.plays += 1;
          if (e.type === 'track_completed') a.completes += 1;
          if (e.type === 'track_skipped') a.skips += 1;
          a.ms += playedMs(e);
          agg.set(e.trackId, a);
        }
        for (const [trackId, a] of agg) {
          await tx.execute(
            `INSERT INTO listening_history (user_id, track_id, play_count, first_played, last_played, last_context, last_context_id, total_listened_ms, completes, skips, score)
             VALUES ($1::uuid, $2::uuid, $3, $8::timestamptz, $8::timestamptz, $4, $5, $6, $7, $7, $9)
             ON CONFLICT (user_id, track_id) DO UPDATE SET
               play_count = listening_history.play_count + EXCLUDED.play_count,
               last_played = greatest(listening_history.last_played, EXCLUDED.last_played),
               last_context = EXCLUDED.last_context,
               last_context_id = EXCLUDED.last_context_id,
               total_listened_ms = listening_history.total_listened_ms + EXCLUDED.total_listened_ms,
               completes = listening_history.completes + EXCLUDED.completes,
               skips = listening_history.skips + EXCLUDED.skips,
               score = greatest(listening_history.score, EXCLUDED.score)`,
            [
              viewer.userId,
              trackId,
              Math.max(a.plays, a.completes ? 1 : a.plays),
              a.lastCtx,
              a.lastCtxId,
              a.ms,
              a.completes,
              a.lastAt,
              Math.min(10, a.completes * 1.5 + a.plays * 0.5 - a.skips * 0.4),
            ],
          );
        }

        // 2) resume strip
        const last = [...agg.entries()].sort((a, b) => (a[1].lastAt < b[1].lastAt ? 1 : -1))[0];
        if (last) {
          await tx.execute(
            `INSERT INTO recently_played (user_id, track_id, context_type, context_id, position_ms, played_at)
             VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::timestamptz)
             ON CONFLICT (user_id, track_id)
             DO UPDATE SET played_at = EXCLUDED.played_at, position_ms = EXCLUDED.position_ms,
                           context_type = EXCLUDED.context_type, context_id = EXCLUDED.context_id`,
            [viewer.userId, last[0], last[1].lastCtx, last[1].lastCtxId, Math.round(last[1].ms / 1000), last[1].lastAt],
          );
        }
      }

      // 3) counters (aggregate in JS from the batch, then one UPDATE .. FROM (VALUES ..))
      const counters = new Map<string, { starts: number; replays: number; skips: number; completes: number }>();
      for (const e of clean) {
        const c = counters.get(e.trackId) ?? { starts: 0, replays: 0, skips: 0, completes: 0 };
        if (e.type === 'track_started') c.starts += 1;
        if (e.type === 'track_replayed') c.replays += 1;
        if (e.type === 'track_skipped') c.skips += 1;
        if (e.type === 'track_completed') c.completes += 1;
        counters.set(e.trackId, c);
      }
      const cv: string[] = [];
      const cp: unknown[] = [];
      for (const [trackId, c] of counters) {
        const p = (v: unknown, cast?: string) => {
          cp.push(v);
          return `$${cp.length}${cast ? `::${cast}` : ''}`;
        };
        cv.push(`(${p(trackId)}::uuid, ${p(c.starts)}::int, ${p(c.replays)}::int, ${p(c.skips)}::int, ${p(c.completes)}::int)`);
      }
      if (cv.length) {
        await tx.execute(
          `UPDATE tracks t SET
             play_count = t.play_count + v.starts + v.replays,
             skip_count = t.skip_count + v.skips,
             updated_at = now()
           FROM (VALUES ${cv.join(',')}) AS v(track_id, starts, replays, skips, completes)
           WHERE t.id = v.track_id`,
          cp,
        );
      }
      const rollup = new Map<string, { plays: number; ms: number; completes: number; skips: number; users: Set<string> }>();
      for (const e of clean) {
        const r = rollup.get(e.trackId) ?? { plays: 0, ms: 0, completes: 0, skips: 0, users: new Set<string>() };
        if (e.type === 'track_started' || e.type === 'track_replayed') r.plays += 1;
        if (e.type === 'track_completed') r.completes += 1;
        if (e.type === 'track_skipped') r.skips += 1;
        r.ms += playedMs(e);
        if (viewer.userId) r.users.add(viewer.userId);
        rollup.set(e.trackId, r);
      }
      for (const [trackId, r] of rollup) {
        await tx.execute(
          `INSERT INTO stats_daily (day, entity_type, entity_id, plays, unique_listeners, completes, skips, minutes_streamed, updated_at)
           SELECT now()::date, 'track', $1::uuid, $2, $3, $4, $5, $6, now()
           ON CONFLICT (day, entity_type, entity_id) DO UPDATE SET
             plays = stats_daily.plays + EXCLUDED.plays,
             completes = stats_daily.completes + EXCLUDED.completes,
             skips = stats_daily.skips + EXCLUDED.skips,
             unique_listeners = greatest(stats_daily.unique_listeners, EXCLUDED.unique_listeners),
             minutes_streamed = stats_daily.minutes_streamed + EXCLUDED.minutes_streamed,
             updated_at = now()`,
          [trackId, r.plays, r.users.size, r.completes, r.skips, Math.round(r.ms / 60000)],
        );
      }
      accepted = clean.length;
    }

    // 4) heartbeat → resume position only (no event-log write)
    for (const e of resumeCandidates.slice(-1)) {
      if (!viewer.userId) continue;
      await tx.execute(
        `UPDATE recently_played SET position_ms = $3, played_at = now()
          WHERE user_id = $1::uuid AND track_id = $2::uuid`,
        [viewer.userId, e.trackId, Math.round(e.positionMs)],
      );
      ignored += 0;
    }
  });

  return {
    accepted,
    ignored: events.length - clean.length - resumeCandidates.length,
    uniqueTracks: new Set(clean.map((e) => e.trackId)).size,
    countsByType,
  };
}

export async function listListeningHistory(db: Db, userId: string, opts: { limit?: number; offset?: number } = {}) {
  const rows = await db.query<Record<string, any>>(
    `SELECT lh.track_id, lh.play_count, lh.last_played, lh.total_listened_ms, lh.completes, lh.skips, lh.score,
            t.title, t.duration_ms, t.release_date, t.streamable, t.status, t.popularity, t.explicit,
            al.id AS album_id, al.title AS album_title, al.image_url AS album_image_url,
            jsonb_build_object('id', ar.id,'name',ar.name,'verified',ar.verified) AS artists_json,
            ar.id AS primary_artist_id
       FROM listening_history lh
       JOIN tracks t ON t.id = lh.track_id
       JOIN albums al ON al.id = t.album_id
       JOIN artists ar ON ar.id = t.primary_artist_id
      WHERE lh.user_id = $1::uuid
      ORDER BY lh.last_played DESC
      LIMIT $2 OFFSET $3`,
    [userId, opts.limit ?? 25, opts.offset ?? 0],
  );
  return rows.map((r) => ({
    trackId: String(r.track_id),
    title: r.title,
    albumId: String(r.album_id),
    albumTitle: r.album_title,
    albumImageUrl: r.album_image_url,
    artist: (r.artists_json as { id: string; name: string })?.name ?? null,
    playCount: Number(r.play_count ?? 0),
    lastPlayed: String(r.last_played ?? ''),
    totalListenedMs: Number(r.total_listened_ms ?? 0),
    completes: Number(r.completes ?? 0),
    skips: Number(r.skips ?? 0),
    score: Number(r.score ?? 0),
  }));
}

export async function getResumeState(db: Db, userId: string) {
  const row = await db.queryOne<Record<string, any>>(
    `SELECT rp.track_id, rp.position_ms, rp.played_at, rp.context_type, rp.context_id,
            t.title, t.duration_ms, al.image_url AS album_image_url,
            ar.name AS artist_name, ar.id AS artist_id
       FROM recently_played rp
       JOIN tracks t ON t.id = rp.track_id
       JOIN albums al ON al.id = t.album_id
       JOIN artists ar ON ar.id = t.primary_artist_id
      WHERE rp.user_id = $1::uuid
      ORDER BY rp.played_at DESC LIMIT 1`,
    [userId],
  );
  if (!row) return null;
  return {
    trackId: String(row.track_id),
    title: row.title,
    artist: row.artist_name,
    artistId: String(row.artist_id),
    imageUrl: row.album_image_url,
    positionMs: Number(row.position_ms ?? 0),
    durationMs: Number(row.duration_ms ?? 0),
    contextType: row.context_type,
    contextId: row.context_id,
    playedAt: String(row.played_at ?? ''),
  };
}

export async function saveQueueSnapshot(db: Db, userId: string, snap: { contextType: string; contextId?: string | null; trackIds: string[]; index: number; positionMs: number; shuffle: boolean; repeatMode: 'off' | 'all' | 'one' }) {
  await db.execute(
    `INSERT INTO playback_queue_snapshots (user_id, context_type, context_id, track_ids, "index", position_ms, shuffle, repeat_mode, updated_at)
     VALUES ($1::uuid, $2, $3, $4::uuid[], $5, $6, $7, $8, now())
     ON CONFLICT (user_id) DO UPDATE SET context_type = EXCLUDED.context_type, context_id = EXCLUDED.context_id,
       track_ids = EXCLUDED.track_ids, "index" = EXCLUDED."index", position_ms = EXCLUDED.position_ms,
       shuffle = EXCLUDED.shuffle, repeat_mode = EXCLUDED.repeat_mode, updated_at = now()`,
    [userId, snap.contextType, snap.contextId ?? null, snap.trackIds, snap.index, snap.positionMs, snap.shuffle, snap.repeatMode],
  );
}

export async function getQueueSnapshot(db: Db, userId: string) {
  const row = await db.queryOne<Record<string, any>>(`SELECT * FROM playback_queue_snapshots WHERE user_id = $1::uuid`, [userId]);
  if (!row) return null;
  return {
    contextType: String(row.context_type),
    contextId: row.context_id ?? null,
    trackIds: (row.track_ids as string[]) ?? [],
    index: Number(row.index ?? 0),
    positionMs: Number(row.position_ms ?? 0),
    shuffle: Boolean(row.shuffle),
    repeatMode: row.repeat_mode as 'off' | 'all' | 'one',
    updatedAt: String(row.updated_at ?? ''),
  };
}

export async function topTrackIdsByPlays(db: Db, opts: { days?: number; limit?: number; excludeIds?: string[] } = {}) {
  const rows = await db.query<{ track_id: string; plays: number }>(
    `SELECT pe.track_id, count(*)::int AS plays
       FROM playback_events pe
       JOIN tracks t ON t.id = pe.track_id
      WHERE pe.event IN ('track_started','track_completed','track_replayed')
        AND pe.occurred_at > now() - make_interval(days => $1::int)
        AND t.streamable AND t.status = 'published'
      GROUP BY pe.track_id
      ORDER BY plays DESC, max(pe.occurred_at) DESC
      LIMIT $2`,
    [opts.days ?? 14, Math.min(opts.limit ?? 20, 100)],
  );
  const ex = new Set(opts.excludeIds ?? []);
  return rows.map((r) => String(r.track_id)).filter((id) => !ex.has(id));
}
