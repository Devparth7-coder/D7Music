/**
 * Recommendation engine (spec §11).
 *
 * v1 is an explicit linear scoring model over signals we can explain in the UI:
 *
 *   score = w_genre·genreSimilarity + w_artist·artistAffinity + w_frequency·listenFreq
 *         + w_recency·recencyDecay + w_popularity·popularity + w_likes·likeBoost
 *         - w_skip·skipRate
 *
 * Why not a black box yet: with a few thousand catalog rows a transparent scorer is
 * more accurate than a cold collaborative filter, and every recommendation carries
 * `reasons[]` so the UI can say *why*. The `RecommendationProvider` interface below is
 * the seam — an offline-trained model that writes the same `recommendations` rows can
 * replace `LinearScoringProvider` without touching a route or a component.
 */
import { env } from '@d7/config';
import type { Db } from '@d7/database';
import { listTracksByIds } from '@d7/database';
import type { RecommendationResponse, RecommendationSignals, ScoredTrack, Track } from '@d7/types';

export interface RecWeights {
  genre: number;
  artist: number;
  frequency: number;
  recency: number;
  popularity: number;
  likes: number;
  skipPenalty: number;
  feature: number;
}

export const defaultWeights: RecWeights = {
  genre: env.RECAND_WEIGHT_GENRE,
  artist: env.RECAND_WEIGHT_ARTIST,
  frequency: env.RECAND_WEIGHT_FREQUENCY,
  recency: env.RECAND_WEIGHT_RECENCY,
  popularity: env.RECAND_WEIGHT_POPULARITY,
  likes: env.RECAND_WEIGHT_LIKES,
  skipPenalty: env.RECAND_SKIP_PENALTY,
  feature: 0.8,
};

export interface EngineOptions {
  windowDays?: number;
  candidateLimit?: number;
  weights?: Partial<RecWeights>;
  /** Hard content filters, e.g. explicit-off from user preferences. */
  excludeExplicit?: boolean;
  seedTrackId?: string | null;
  now?: Date;
}

interface AffinityRow {
  genre: string | null;
  artist_id: string | null;
  weight: number;
}

export interface UserAffinity {
  genres: Map<string, number>;
  artists: Map<string, number>;
  likedTracks: Set<string>;
  recentlyPlayed: Map<string, { plays: number; skips: number; lastPlayMs: number; listenedMs: number }>;
  eventsConsidered: number;
  moods: Map<string, number>;
}

export interface RecommendationProvider {
  readonly name: string;
  forUser(db: Db, userId: string | null, opts: EngineOptions & { limit: number }): Promise<{ items: ScoredTrack[]; mode: RecommendationResponse['mode']; signals: RecommendationSignals | null }>;
  similarTo(db: Db, trackId: string, opts: { limit: number; viewerId?: string | null }): Promise<ScoredTrack[]>;
}

const HOUR = 3_600_000;

export class LinearScoringProvider implements RecommendationProvider {
  readonly name = 'v1_linear_scoring';

  constructor(private readonly opts: { weights?: Partial<RecWeights>; windowDays?: number } = {}) {}

  private get weights(): RecWeights {
    return { ...defaultWeights, ...(this.opts.weights ?? {}) };
  }
  private get windowDays() {
    return this.opts.windowDays ?? env.RECAND_WINDOW_DAYS;
  }

  async loadAffinity(db: Db, userId: string): Promise<UserAffinity> {
    const windowDays = this.windowDays;
    const [genreRows, artistRows, history, liked, moodRows] = await Promise.all([
      db.query<AffinityRow>(
        `SELECT g.slug AS genre, sum(
                   CASE WHEN pe.event = 'track_completed' THEN 2.5
                        WHEN pe.event = 'track_started' THEN 1.0
                        WHEN pe.event = 'track_skipped' THEN -0.6
                        WHEN pe.event = 'track_replayed' THEN 2.0
                        ELSE 0 END
                   * exp(-extract(epoch from (now() - pe.occurred_at)) / (28.0*86400))
                 ) AS weight
           FROM playback_events pe
           JOIN track_genres tg ON tg.track_id = pe.track_id
           JOIN genres g ON g.id = tg.genre_id
           WHERE pe.user_id = $1::uuid AND pe.occurred_at > now() - make_interval(days => $2::int)
           GROUP BY g.slug`,
        [userId, windowDays],
      ),
      db.query<AffinityRow>(
        `SELECT t.primary_artist_id AS artist_id, sum(
                   CASE WHEN pe.event = 'track_completed' THEN 2.5
                        WHEN pe.event = 'track_liked' THEN 4.0
                        WHEN pe.event = 'track_started' THEN 1.0
                        WHEN pe.event = 'track_skipped' THEN -0.8
                        ELSE 0.4 END
                   * exp(-extract(epoch from (now() - pe.occurred_at)) / (28.0*86400))
                 ) AS weight
           FROM playback_events pe
           JOIN tracks t ON t.id = pe.track_id
           WHERE pe.user_id = $1::uuid AND pe.occurred_at > now() - make_interval(days => $2::int)
           GROUP BY t.primary_artist_id`,
        [userId, windowDays],
      ),
      db.query<Record<string, any>>(
        `SELECT track_id, play_count, skips, completes, total_listened_ms,
                extract(epoch from (now() - last_played)) * 1000 AS age_ms
           FROM listening_history WHERE user_id = $1::uuid`,
        [userId],
      ),
      db.query<{ track_id: string }>(`SELECT track_id FROM liked_tracks WHERE user_id = $1::uuid`, [userId]),
      db.query<AffinityRow>(
        `SELECT m.tag AS genre, sum(CASE WHEN pe.event = 'track_skipped' THEN -0.5 ELSE 1 END) AS weight
           FROM playback_events pe JOIN track_moods m ON m.track_id = pe.track_id
          WHERE pe.user_id = $1::uuid AND pe.occurred_at > now() - make_interval(days => $2::int)
          GROUP BY m.tag`,
        [userId, windowDays],
      ),
    ]);

    const genres = new Map<string, number>();
    for (const r of genreRows) if (r.genre) genres.set(r.genre, Math.max(0, Number(r.weight ?? 0)));
    const artists = new Map<string, number>();
    for (const r of artistRows) if (r.artist_id) artists.set(String(r.artist_id), Math.max(0, Number(r.weight ?? 0)));
    // Liked artists get a floor boost even with no plays yet (explicit positive signal).
    for (const r of artistRows) void r;
    const recentlyPlayed = new Map<string, { plays: number; skips: number; lastPlayMs: number; listenedMs: number }>();
    for (const h of history) {
      recentlyPlayed.set(String(h.track_id), {
        plays: Number(h.play_count ?? 0),
        skips: Number(h.skips ?? 0),
        lastPlayMs: Number(h.age_ms ?? 0),
        listenedMs: Number(h.total_listened_ms ?? 0),
      });
    }
    const eventsConsidered = genreRows.length + artistRows.length + history.length;
    const moods = new Map<string, number>();
    for (const r of moodRows) if (r.genre) moods.set(r.genre, Math.max(0, Number(r.weight ?? 0)));
    return { genres, artists, likedTracks: new Set(liked.map((l) => String(l.track_id))), recentlyPlayed, eventsConsidered, moods };
  }

  /** Candidate pool: everything the user is allowed to hear, pre-filtered in SQL. */
  private async candidates(db: Db, opts: EngineOptions & { limit: number }, exclude: Set<string>, seed?: Track) {
    const q: unknown[] = [];
    const bind = (v: unknown, cast?: string) => {
      q.push(v);
      return `$${q.length}${cast ? `::${cast}` : ''}`;
    };
    const window = bind(Math.max(1, this.windowDays), 'int');
    const cond: string[] = [`t.streamable`, `t.status = 'published'`, `al.status = 'published'`, `t.license_status = 'licensed'`];
    if (opts.excludeExplicit) cond.push(`NOT t.explicit`);
    if (seed) cond.push(`t.id <> ${bind(seed.id, 'uuid')}`);
    const lim = bind(Math.min(opts.limit * 12, env.RECAND_CANDIDATE_LIMIT), 'int');

    const rows = await db.query<Record<string, any>>(
      `SELECT t.id, t.album_id, t.primary_artist_id, t.popularity, t.play_count, t.skip_count, t.energy, t.valence,
              t.danceability, t.acousticness, t.duration_ms, t.title, to_char(t.release_date,'YYYY-MM-DD') AS release_date,
              al.image_url AS album_image_url, al.title AS album_title,
              ar.name AS artist_name, ar.verified AS artist_verified,
              coalesce((SELECT jsonb_agg(g.slug) FROM track_genres tg JOIN genres g ON g.id = tg.genre_id WHERE tg.track_id = t.id), '[]'::jsonb) AS genres,
              coalesce((SELECT jsonb_agg(m.tag) FROM track_moods m WHERE m.track_id = t.id), '[]'::jsonb) AS moods,
              (SELECT count(*) FROM liked_tracks lt WHERE lt.track_id = t.id)::int AS likes_total,
              (SELECT count(*) FROM playback_events pe2 WHERE pe2.track_id = t.id
                 AND pe2.event = 'track_completed' AND pe2.occurred_at > now() - make_interval(days => ${window}))::int AS recent_completes
         FROM tracks t JOIN albums al ON al.id = t.album_id JOIN artists ar ON ar.id = t.primary_artist_id
        WHERE ${cond.join(' AND ')}
        ORDER BY (t.popularity + least(60, t.play_count * 0.05)) DESC NULLS LAST
        LIMIT ${lim}`,
      q,
    );
    void exclude;
    return rows;
  }

  async forUser(db: Db, userId: string | null, opts: EngineOptions & { limit: number }) {
    const weights = this.weights;
    const now = opts.now ?? new Date();

    if (!userId) {
      const rows = await this.candidates(db, opts, new Set());
      return {
        items: this.rank(rows, emptyAffinity(), weights, opts.limit, { popularityOnly: true, now }),
        mode: 'cold_start_popularity' as RecommendationResponse['mode'],
        signals: null as RecommendationSignals | null,
      };
    }

    const affinity = await this.loadAffinity(db, userId);
    if (affinity.eventsConsidered < 3 && affinity.likedTracks.size < 1) {
      const rows = await this.candidates(db, opts, new Set());
      return {
        items: this.rank(rows, affinity, weights, opts.limit, { popularityOnly: true, now }),
        mode: 'cold_start_popularity' as RecommendationResponse['mode'],
        signals: await this.signals(db, userId, affinity),
      };
    }

    const exclude = new Set<string>([...affinity.recentlyPlayed.keys()].filter((id) => {
      const h = affinity.recentlyPlayed.get(id);
      // Filter out what was just played, but never hide a track the user clearly loves.
      return (h?.lastPlayMs ?? Infinity) < 48 * HOUR && (h?.plays ?? 0) < 4;
    }));
    const rows = await this.candidates(db, opts, exclude);
    return {
      items: this.rank(rows, affinity, weights, opts.limit, { now }),
      mode: 'personalized' as RecommendationResponse['mode'],
      signals: await this.signals(db, userId, affinity),
    };
  }

  private rank(
    rows: Record<string, any>[],
    affinity: UserAffinity,
    w: RecWeights,
    limit: number,
    ctx: { popularityOnly?: boolean; now: Date; seed?: Track },
  ): ScoredTrack[] {
    const maxGenre = Math.max(1, ...[...affinity.genres.values()]);
    const maxArtist = Math.max(1, ...[...affinity.artists.values()]);
    const maxPop = Math.max(1, ...rows.map((r) => Number(r.popularity ?? 0)));
    const scored: { row: Record<string, any>; score: number; reasons: ScoredTrack['reasons'] }[] = [];

    for (const r of rows) {
      const trackId = String(r.id);
      if (affinity.recentlyPlayed.has(trackId) && !ctx.popularityOnly) {
        const h = affinity.recentlyPlayed.get(trackId)!;
        if (h.plays >= 4 && h.lastPlayMs < 48 * HOUR) continue;
      }
      const genres: string[] = (r.genres as string[]) ?? [];
      const moods: string[] = (r.moods as string[]) ?? [];
      const genreHit = genres.reduce((acc, g) => acc + (affinity.genres.get(g) ?? 0), 0);
      const moodHit = moods.reduce((acc, m) => acc + (affinity.moods.get(m) ?? 0), 0);
      const artistAff = affinity.artists.get(String(r.primary_artist_id)) ?? 0;
      const history = affinity.recentlyPlayed.get(trackId);
      const freq = history ? Math.min(1, history.plays / 6) : 0;
      const recency = history ? Math.max(0, 1 - history.lastPlayMs / (this.windowDays * 86_400_000)) : 0;
      const pop = Math.min(1, Number(r.popularity ?? 0) / maxPop);
      const likeBoost = affinity.likedTracks.has(trackId) ? 0 : Math.min(1, Number(r.likes_total ?? 0) / 25);
      const skipRate = history && history.plays > 0 ? history.skips / Math.max(1, history.plays) : 0;
      const seedSim = ctx.seed ? featureSimilarity(ctx.seed, r) : 0;

      const score =
        w.genre * Math.min(1.6, (genreHit + moodHit * 0.5) / maxGenre) +
        w.artist * Math.min(1.6, artistAff / maxArtist) +
        w.frequency * freq +
        w.recency * recency * 0.6 +
        w.popularity * pop +
        w.likes * likeBoost +
        (ctx.seed ? w.feature * seedSim : 0) -
        w.skipPenalty * skipRate;

      const reasons: ScoredTrack['reasons'] = [];
      if (genreHit > 0) reasons.push({ code: 'genre', label: `Matches ${genres.filter((g) => affinity.genres.get(g)).join(', ') || 'your genres'}`, contribution: round(w.genre * Math.min(1.6, genreHit / maxGenre)) });
      if (artistAff > 0) reasons.push({ code: 'artist', label: 'You listen to this artist', contribution: round(w.artist * Math.min(1.6, artistAff / maxArtist)) });
      if (freq > 0) reasons.push({ code: 'frequency', label: `Played ${history?.plays ?? 0}× recently`, contribution: round(w.frequency * freq) });
      if (likeBoost > 0) reasons.push({ code: 'community', label: `${Number(r.likes_total ?? 0)} listeners saved this`, contribution: round(w.likes * likeBoost) });
      if (pop > 0.55) reasons.push({ code: 'popular', label: 'Trending in your area of the catalog', contribution: round(w.popularity * pop) });
      if (seedSim > 0.4) reasons.push({ code: 'audio', label: 'Similar tempo, energy and mood', contribution: round(w.feature * seedSim) });
      if (skipRate > 0.3) reasons.push({ code: 'skip', label: 'Others skip this often', contribution: round(-w.skipPenalty * skipRate) });
      if (!reasons.length) reasons.push({ code: 'discovery', label: 'Outside your usual rotation', contribution: 0 });

      scored.push({ row: r, score: score + Math.random() * 0.02, reasons: reasons.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)).slice(0, 3) });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => ({
      track: rowToTrack(s.row),
      score: round(s.score),
      reasons: s.reasons,
    }));
  }

  async similarTo(db: Db, trackId: string, opts: { limit: number; viewerId?: string | null }) {
    const seed = (await listTracksByIds(db, [trackId], { viewerId: opts.viewerId }))[0];
    if (!seed) return [];
    const rows = await this.candidates(db, { limit: opts.limit, windowDays: this.windowDays, now: new Date() }, new Set(), seed);
    const scored = rows
      .map((r) => {
        const sim = featureSimilarity(seed, r);
        const genreOverlap = r.genres ? (r.genres as string[]).filter((g) => seed.genres.includes(g)).length / Math.max(1, seed.genres.length) : 0;
        const artistSame = String(r.primary_artist_id) === seed.primaryArtistId ? 0.35 : 0;
        const pop = Math.min(1, Number(r.popularity ?? 0) / 100);
        const score = sim * 1.6 + genreOverlap * 1.2 + artistSame + pop * 0.35;
        const reasons: ScoredTrack['reasons'] = [];
        if (genreOverlap > 0) reasons.push({ code: 'genre', label: `Shares ${Math.round(genreOverlap * 100)}% of genres`, contribution: round(genreOverlap * 1.2) });
        if (sim > 0.5) reasons.push({ code: 'audio', label: 'Close energy / tempo / mood profile', contribution: round(sim * 1.6) });
        if (artistSame) reasons.push({ code: 'artist', label: 'Same artist', contribution: 0.35 });
        return { row: r, score, reasons };
      })
      .filter((s) => String(s.row.id) !== trackId)
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit);
    return scored.map((s) => ({ track: rowToTrack(s.row), score: round(s.score), reasons: s.reasons.length ? s.reasons : [{ code: 'vibe', label: 'Similar sound', contribution: 0 }] }));
  }

  async signals(db: Db, userId: string, affinity?: UserAffinity): Promise<RecommendationSignals> {
    const a = affinity ?? (await this.loadAffinity(db, userId));
    const topGenres = [...a.genres.entries()].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([genre, weight]) => ({ genre, weight: round(weight) }));
    const artistNames = a.artists.size
      ? await db.query<{ id: string; name: string }>(`SELECT id, name FROM artists WHERE id = ANY($1::uuid[])`, [[...a.artists.keys()]])
      : [];
    const nameById = new Map(artistNames.map((r) => [String(r.id), r.name]));
    const topArtists = [...a.artists.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, 6)
      .map(([artistId, weight]) => ({ artistId, name: nameById.get(artistId) ?? 'Unknown artist', weight: round(weight) }));
    const likedIds = [...a.likedTracks].slice(0, 6);
    const likedTracks = likedIds.length ? await listTracksByIds(db, likedIds) : [];
    return {
      topGenres,
      topArtists,
      topTracks: likedTracks.map((t) => ({ trackId: t.id, title: t.title, weight: 1 })),
      eventsConsidered: a.eventsConsidered,
      windowDays: this.windowDays,
    };
  }

  /** Persist per-user recommendation rows so the home page is a cheap indexed read. */
  async computeAndPersist(db: Db, opts: { userIds?: string[]; limit?: number; algorithm?: string } = {}) {
    const limit = opts.limit ?? 60;
    const users =
      opts.userIds ??
      (
        await db.query<{ user_id: string }>(
          `SELECT DISTINCT user_id FROM (
             SELECT user_id FROM listening_history WHERE last_played > now() - interval '45 days'
             UNION SELECT user_id FROM liked_tracks
           ) u WHERE user_id IS NOT NULL LIMIT 5000`,
        )
      ).map((r) => String(r.user_id));

    const t0 = Date.now();
    let computed = 0;
    let skipped = 0;
    const errors: { stage: string; message: string }[] = [];

    for (const userId of users) {
      try {
        const { items } = await this.forUser(db, userId, { limit });
        if (!items.length) {
          skipped += 1;
          continue;
        }
        await db.transaction(async (tx) => {
          await tx.execute(`DELETE FROM recommendations WHERE user_id = $1::uuid`, [userId]);
          const params: unknown[] = [];
          const values: string[] = [];
          items.forEach((it, i) => {
            params.push(userId, it.track.id, it.score, i + 1, opts.algorithm ?? this.name, JSON.stringify(it.reasons));
            const b = params.length;
            values.push(`($${b - 5}::uuid, $${b - 4}::uuid, $${b - 3}::float8, $${b - 2}::int, $${b - 1}, $${b}::jsonb, now())`);
          });
          await tx.execute(
            `INSERT INTO recommendations (user_id, track_id, score, rank, algorithm, reasons, generated_at)
             VALUES ${values.join(',')} ON CONFLICT (user_id, track_id) DO UPDATE SET
               score = EXCLUDED.score, rank = EXCLUDED.rank, reasons = EXCLUDED.reasons, generated_at = now()`,
            params,
          );
        });
        computed += 1;
      } catch (err) {
        errors.push({ stage: `user:${userId}`, message: (err as Error).message });
      }
    }

    await db.execute(
      `INSERT INTO recommendation_runs (id, users_computed, users_skipped, tracks_indexed, algorithm, duration_ms, errors, started_at)
       VALUES (d7_uuid(), $1, $2, $3, $4, $5, $6::jsonb, now())`,
      [computed, skipped, limit * Math.max(1, computed), opts.algorithm ?? this.name, Date.now() - t0, JSON.stringify(errors.slice(0, 20))],
    );
    return { computed, skipped, errors: errors.length, durationMs: Date.now() - t0, users: users.length };
  }
}

function emptyAffinity(): UserAffinity {
  return { genres: new Map(), artists: new Map(), likedTracks: new Set(), recentlyPlayed: new Map(), eventsConsidered: 0, moods: new Map() };
}

/** Cosine-ish closeness on the audio-analysis columns. */
function featureSimilarity(seed: Track, row: Record<string, any>) {
  const pairs: [number, number][] = [
    [seed.energy, Number(row.energy ?? 0.5)],
    [seed.valence, Number(row.valence ?? 0.5)],
    [seed.danceability, Number(row.danceability ?? 0.5)],
    [seed.acousticness, Number(row.acousticness ?? 0.2)],
  ];
  const dist = pairs.reduce((acc, [a, b]) => acc + (a - b) ** 2, 0) / pairs.length;
  return Math.max(0, 1 - Math.sqrt(dist) * 1.8);
}

function round(n: number) {
  return Math.round(n * 1000) / 1000;
}

function rowToTrack(r: Record<string, any>): Track {
  return {
    id: String(r.id),
    title: String(r.title),
    albumId: String(r.album_id),
    albumTitle: String(r.album_title ?? ''),
    albumImageUrl: r.album_image_url ?? null,
    artists: [{ id: String(r.primary_artist_id), name: String(r.artist_name ?? 'Artist'), verified: Boolean(r.artist_verified) }],
    primaryArtistId: String(r.primary_artist_id),
    trackNumber: Number(r.track_number ?? 1),
    discNumber: Number(r.disc_number ?? 1),
    durationMs: Number(r.duration_ms ?? 0),
    explicit: Boolean(r.explicit),
    isrc: r.isrc ?? null,
    genres: (r.genres as string[]) ?? [],
    mood: (r.moods as string[]) ?? [],
    energy: Number(r.energy ?? 0.5),
    valence: Number(r.valence ?? 0.5),
    danceability: Number(r.danceability ?? 0.5),
    acousticness: Number(r.acousticness ?? 0.2),
    popularity: Number(r.popularity ?? 0),
    playCount: Number(r.play_count ?? 0),
    releaseDate: String(r.release_date ?? ''),
    addedAt: String(r.added_at ?? ''),
    contentSource: r.content_source ?? 'platform_owned',
    licenseStatus: r.license_status ?? 'licensed',
    providerName: r.provider_name ?? null,
    providerTrackId: r.provider_track_id ?? null,
    hasAudio: true,
    streamable: r.streamable === undefined ? true : Boolean(r.streamable),
    liked: Boolean(r.liked),
    likedCount: Number(r.likes_total ?? r.liked_count ?? 0),
    lyricCount: Number(r.lyric_count ?? 0),
    audio: null,
  };
}

/** Rebuilds the co-listening graph the artist page shows (also used by search ranking). */
export async function refreshRelatedArtists(db: Db, opts: { minCooccurrence?: number } = {}) {
  const res = await db.execute(
    `WITH pairs AS (
       SELECT a.artist_id AS left_id, b.artist_id AS right_id, count(DISTINCT a.user_id)::float8 AS weight
         FROM (SELECT lh.user_id, t.primary_artist_id AS artist_id FROM listening_history lh JOIN tracks t ON t.id = lh.track_id
                WHERE lh.last_played > now() - interval '90 days') a
         JOIN (SELECT lh.user_id, t.primary_artist_id AS artist_id FROM listening_history lh JOIN tracks t ON t.id = lh.track_id
                WHERE lh.last_played > now() - interval '90 days') b
           ON a.user_id = b.user_id AND a.artist_id < b.artist_id
        GROUP BY a.artist_id, b.artist_id
        HAVING count(DISTINCT a.user_id) >= $1::int
     )
     INSERT INTO related_artists (artist_id, related_id, weight, method, computed_at)
     SELECT left_id, right_id, weight, 'co_listening', now() FROM pairs
     UNION ALL
     SELECT right_id, left_id, weight, 'co_listening', now() FROM pairs
     ON CONFLICT (artist_id, related_id) DO UPDATE SET weight = EXCLUDED.weight, computed_at = now()`,
    [opts.minCooccurrence ?? 2],
  );
  await db.execute(`DELETE FROM related_artists WHERE computed_at < now() - interval '30 days' AND method = 'co_listening'`);
  return { pairs: res };
}

