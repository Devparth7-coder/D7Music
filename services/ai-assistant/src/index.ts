/**
 * AI music assistant (spec §10).
 *
 * Flow:  prompt → structured AssistantQuery → (validated, catalog-guarded) → SQL
 *        retrieval → ordered/deduped tracks → optional playlist.
 *
 * Two parsing engines, one contract:
 *   rule_based  — always available, deterministic, no keys (parser.ts)
 *   llm         — OpenAI-compatible endpoint when LLM_BASE_URL/KEY are set; its JSON is
 *                 zod-validated and merged over the rule-based result.
 *
 * The assistant can never return a song that is not in our catalog: retrieval is a SQL
 * query, and any track name an LLM volunteers is resolved against `tracks` and dropped
 * (reported in `rejected`) when it does not exist.
 */
import { z } from 'zod';
import { env, MOODS } from '@d7/config';
import type { Db } from '@d7/database';
import { ensureConversation, appendMessage, listConversation, readAndIncrementUsage, findOrCreatePlaylist } from '@d7/database';
import { parseAssistantQuery, describeQuery, type ParseResult } from './parser.js';
import type { AssistantQuery, AssistantResponse, AssistantTrackRef, Track } from '@d7/types';

export interface AssistantDeps {
  db: Db;
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
  /** Injectable for tests and for swapping in a different model gateway. */
  fetchImpl?: typeof fetch;
  knownArtists?: () => Promise<{ id: string; name: string }[]>;
}

export interface AskOptions {
  prompt: string;
  viewerId?: string | null;
  tier?: 'free' | 'premium';
  conversationId?: string | null;
  /** When true, a public/private playlist is created from the result set. */
  createPlaylist?: boolean;
  playlistTitle?: string | null;
  visibility?: 'private' | 'public';
  seedTrackId?: string | null;
  excludeExplicit?: boolean;
  dailyLimit?: number;
}

const llmSchema = z.object({
  intent: z.enum(['play', 'create_playlist', 'describe', 'similar', 'browse']).optional(),
  mood: z.array(z.string()).optional(),
  energy: z.enum(['low', 'medium', 'high']).nullable().optional(),
  tempo: z.enum(['slow', 'medium', 'fast']).nullable().optional(),
  genres: z.array(z.string()).optional(),
  avoidGenres: z.array(z.string()).optional(),
  artists: z.array(z.string()).optional(),
  durationMinutes: z.number().nullable().optional(),
  explicit: z.boolean().nullable().optional(),
  language: z.string().nullable().optional(),
  activity: z.string().nullable().optional(),
  reply: z.string().max(600).optional(),
  suggestedTracks: z
    .array(z.object({ title: z.string(), artist: z.string().optional(), providerTrackId: z.string().optional() }))
    .optional(),
});

export type LlmOutput = z.infer<typeof llmSchema>;

export class AiMusicAssistant {
  private artistCache: { id: string; name: string }[] | null = null;

  constructor(private readonly deps: AssistantDeps) {}

  private get llmEnabled() {
    return Boolean(env.LLM_BASE_URL && env.LLM_API_KEY);
  }

  async listArtistsForMatch() {
    if (this.artistCache) return this.artistCache;
    const rows = this.deps.knownArtists
      ? await this.deps.knownArtists()
      : (await this.deps.db.query<{ id: string; name: string }>(`SELECT id, name FROM artists ORDER BY popularity DESC LIMIT 800`)).map((r) => ({ id: String(r.id), name: r.name }));
    this.artistCache = rows;
    return rows;
  }

  parse(prompt: string): ParseResult {
    return parseAssistantQuery(prompt, (this.artistCache ?? []).map((a) => a.name));
  }

  async ask(opts: AskOptions): Promise<AssistantResponse> {
    const { db } = this.deps;
    const prompt = (opts.prompt ?? '').trim().slice(0, 500);
    const dailyLimit = opts.dailyLimit ?? (opts.tier === 'premium' ? env.ASSISTANT_DAILY_LIMIT_PREMIUM : env.ASSISTANT_DAILY_LIMIT_FREE);

    if (opts.viewerId) {
      const usage = await readAndIncrementUsage(db, opts.viewerId, dailyLimit);
      if (!usage.allowed) {
        return {
          conversationId: opts.conversationId ?? '',
          message: `You have used all ${dailyLimit} assistant requests for today. ${
            opts.tier === 'free' ? 'Premium removes the daily limit.' : 'Try again tomorrow.'
          }`,
          parsed: { ...parseAssistantQuery(prompt).query },
          engine: 'rule_based',
          model: null,
          tracks: [],
          playlist: null,
          rejected: [],
          appliedFilters: { quotaExceeded: true, dailyLimit },
          createdAt: new Date().toISOString(),
        };
      }
    }

    // Prime the artist list so rule-based matching can reference real catalog names.
    await this.listArtistsForMatch();
    const ruleParsed = parseAssistantQuery(prompt, (this.artistCache ?? []).map((a) => a.name));
    let parsed = ruleParsed.query;
    let engine: AssistantResponse['engine'] = 'rule_based';
    let model: string | null = null;
    let rejected: AssistantTrackRef[] = [];
    let llmReply: string | null = null;
    let pinnedTrackIds: string[] = [];

    if (this.llmEnabled) {
      const llm = await llmParse(prompt, ruleParsed, { fetchImpl: this.deps.fetchImpl });
      if (llm) {
        parsed = mergeQueries(parsed, llm.parsed);
        engine = 'hybrid';
        model = env.LLM_MODEL;
        llmReply = llm.reply;
        const suggested = llm.raw.suggestedTracks ?? [];
        if (suggested.length) {
          const resolved = await this.resolveSuggestedTracks(suggested);
          rejected = resolved.rejected;
          if (resolved.found.length) pinnedTrackIds = resolved.found;
        }
      }
    }

    const avgDurationMs = await this.averageTrackDuration();
    const limit = resolveLimit(parsed, avgDurationMs);
    let tracks: Track[] = [];
    const appliedFilters: Record<string, string | number | boolean> = {
      intent: parsed.intent,
      filters: describeQuery(parsed),
      genresRequested: parsed.genres.length,
      moods: parsed.mood.join(', ') || 'none',
      energy: parsed.energy ?? 'any',
      durationMinutes: parsed.durationMinutes ?? 'unbounded',
      resultCount: 0,
      engine,
      parserConfidence: Math.round(ruleParsed.confidence * 100) / 100,
    };

    if (parsed.intent === 'describe') {
      tracks = [];
      appliedFilters.note = 'descriptive request — answered from catalog metadata only';
    } else {
      tracks = await this.retrieve(parsed, {
        limit,
        viewerId: opts.viewerId ?? null,
        seedTrackId: opts.seedTrackId ?? null,
        excludeExplicit: parsed.explicit === false || opts.excludeExplicit === true,
      });
      if (pinnedTrackIds.length) {
        const { listTracksByIds } = await import('@d7/database');
        const pinned = await listTracksByIds(db, pinnedTrackIds, { viewerId: opts.viewerId ?? null });
        const seenIds = new Set(pinned.map((p) => p.id));
        tracks = [...pinned, ...tracks.filter((t) => !seenIds.has(t.id))].slice(0, limit);
        appliedFilters.llmSuggestedResolved = pinned.length;
      }
    }

    appliedFilters.resultCount = tracks.length;
    if (parsed.language) appliedFilters.languageUnsupported = parsed.language;

    let playlist = null as AssistantResponse['playlist'];
    if (opts.createPlaylist && tracks.length && opts.viewerId) {
      const title = (opts.playlistTitle?.trim() || titleFromQuery(parsed, prompt)).slice(0, 90);
      const created = await findOrCreatePlaylist(db, {
        ownerId: opts.viewerId,
        title,
        description: `Generated by the D7music assistant from: “${prompt.slice(0, 160)}”`,
        visibility: opts.visibility ?? 'private',
        generatedBy: 'ai_assistant',
        seedContext: { parsed, engine, model },
        trackIds: tracks.map((t) => t.id),
      });
      playlist = created.playlist;
    }

    const message =
      llmReply ??
      buildReply({ prompt, parsed, tracks, engine, confidence: ruleParsed.confidence, createdPlaylist: playlist?.title ?? null });

    const conversationId = await ensureConversation(db, opts.conversationId ?? null, opts.viewerId ?? null, prompt.slice(0, 80) || 'Assistant request');
    await appendMessage(db, {
      conversationId,
      role: 'user',
      content: prompt,
    });
    await appendMessage(db, {
      conversationId,
      role: 'assistant',
      content: message,
      parsedQuery: parsed,
      engine,
      model,
      trackIds: tracks.map((t) => t.id),
      rejected,
      playlistId: playlist?.id ?? null,
    });

    return {
      conversationId,
      message,
      parsed,
      engine,
      model,
      tracks,
      playlist: playlist ?? null,
      rejected,
      appliedFilters,
      createdAt: new Date().toISOString(),
    };
  }

  async history(conversationId: string) {
    return listConversation(this.deps.db, conversationId);
  }

  private async averageTrackDuration() {
    const row = await this.deps.db.queryOne<{ avg: number }>(`SELECT coalesce(avg(duration_ms),210000)::float8 AS avg FROM tracks WHERE streamable`);
    return Number(row?.avg ?? 210_000);
  }

  /**
   * Catalog-only retrieval. Everything the user asked for becomes a WHERE clause; the
   * result set is *only* ever rows from `tracks`.
   */
  async retrieve(q: AssistantQuery, ctx: { limit: number; viewerId?: string | null; seedTrackId?: string | null; excludeExplicit?: boolean }): Promise<Track[]> {
    const params: unknown[] = [];
    const bind = (v: unknown, cast?: string) => {
      params.push(v);
      return `$${params.length}${cast ? `::${cast}` : ''}`;
    };
    const clauses: string[] = ['t.streamable', `t.status = 'published'`, `al.status = 'published'`, `t.license_status = 'licensed'`];

    const target = energyTarget(q);
    const genreTokens = q.genres.length ? bind(q.genres, 'text[]') : null;
    const moodTokens = q.mood.length ? bind(q.mood, 'text[]') : null;
    const avoid = q.avoidGenres.length ? bind(q.avoidGenres, 'text[]') : null;

    if (genreTokens && moodTokens) {
      clauses.push(
        `(EXISTS (SELECT 1 FROM track_genres tg JOIN genres g ON g.id = tg.genre_id WHERE tg.track_id = t.id AND g.slug = ANY(${genreTokens}))
          OR EXISTS (SELECT 1 FROM track_moods m WHERE m.track_id = t.id AND m.tag = ANY(${moodTokens})))`,
      );
    } else if (genreTokens) {
      clauses.push(`EXISTS (SELECT 1 FROM track_genres tg JOIN genres g ON g.id = tg.genre_id WHERE tg.track_id = t.id AND g.slug = ANY(${genreTokens}))`);
    } else if (moodTokens) {
      clauses.push(`EXISTS (SELECT 1 FROM track_moods m WHERE m.track_id = t.id AND m.tag = ANY(${moodTokens}))`);
    }
    if (avoid) {
      clauses.push(`NOT EXISTS (SELECT 1 FROM track_genres tg2 JOIN genres g2 ON g2.id = tg2.genre_id WHERE tg2.track_id = t.id AND g2.slug = ANY(${avoid}))`);
    }
    if (q.explicit === false || ctx.excludeExplicit) clauses.push('NOT t.explicit');
    if (q.explicit === true) clauses.push('t.explicit');
    if (q.era?.from) clauses.push(`al.release_date >= ${bind(`${q.era.from}-01-01`, 'date')}`);
    if (q.era?.to) clauses.push(`al.release_date <= ${bind(`${q.era.to}-12-31`, 'date')}`);
    if (q.artists.length) {
      const artistTokens = bind(q.artists.map((a) => a.toLowerCase().replace(/\s+/g, ' ').trim()), 'text[]');
      clauses.push(`EXISTS (SELECT 1 FROM track_artists ta JOIN artists a2 ON a2.id = ta.artist_id
                      WHERE ta.track_id = t.id AND a2.name_key = ANY(${artistTokens}))`);
    }
    if (ctx.seedTrackId) {
      const seed = bind(ctx.seedTrackId, 'uuid');
      clauses.push(`t.id <> ${seed}`);
      clauses.push(`(
        t.primary_artist_id = (SELECT primary_artist_id FROM tracks WHERE id = ${seed})
        OR abs(t.energy - (SELECT energy FROM tracks WHERE id = ${seed})) < 0.35
        OR EXISTS (SELECT 1 FROM track_genres tg3 WHERE tg3.track_id = t.id AND tg3.genre_id IN
              (SELECT genre_id FROM track_genres WHERE track_id = ${seed}))
      )`);
    }

    const viewer = bind(ctx.viewerId ?? null, 'uuid');
    const fetchLimit = bind(Math.min(400, Math.max(20, ctx.limit * 4)), 'int');

    const score = `
        coalesce((SELECT sum(tg.weight) FROM track_genres tg JOIN genres g ON g.id = tg.genre_id
                   WHERE tg.track_id = t.id ${genreTokens ? `AND g.slug = ANY(${genreTokens})` : ''}), 0) * 1.2
      + coalesce((SELECT sum(m.weight) FROM track_moods m WHERE m.track_id = t.id
                   ${moodTokens ? `AND m.tag = ANY(${moodTokens})` : ''}), 0) * 1.1
      - abs(t.energy - ${bind(target.energy)}) * 1.4
      - abs(t.valence - ${bind(target.valence)}) * 1.0
      - abs(t.danceability - ${bind(target.dance)}) * 0.6
      + least(2.0, t.popularity / 50)
      + CASE WHEN EXISTS (SELECT 1 FROM liked_tracks lt WHERE lt.track_id = t.id AND lt.user_id = ${viewer}) THEN 1.5 ELSE 0 END`;

    const sql = `
      SELECT t.id, t.title, t.album_id, t.track_number, t.disc_number, t.duration_ms, t.explicit,
             t.isrc, t.primary_artist_id, t.popularity, t.play_count, t.energy, t.valence, t.danceability,
             t.acousticness, to_char(al.release_date,'YYYY-MM-DD') AS release_date, al.added_at,
             t.content_source, t.license_status, t.provider_name, t.provider_track_id, t.streamable, t.status,
             (t.storage_key IS NOT NULL) AS has_audio,
             al.title AS album_title, al.image_url AS album_image_url,
             jsonb_build_object('id', ar.id, 'name', ar.name, 'verified', ar.verified) AS artists_json,
             coalesce((SELECT jsonb_agg(g.slug) FROM track_genres tg JOIN genres g ON g.id = tg.genre_id WHERE tg.track_id = t.id), '[]'::jsonb) AS genre_slugs,
             coalesce((SELECT jsonb_agg(m.tag) FROM track_moods m WHERE m.track_id = t.id), '[]'::jsonb) AS mood_tags,
             (SELECT count(*) FROM liked_tracks lc WHERE lc.track_id = t.id)::int AS liked_count,
             (${score}) AS ai_score
        FROM tracks t JOIN albums al ON al.id = t.album_id JOIN artists ar ON ar.id = t.primary_artist_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY ai_score DESC, t.popularity DESC
       LIMIT ${fetchLimit}`;

    const rows = await this.deps.db.query<Record<string, any>>(sql, params);
    const tracks = rows.map(rowToLightTrack);
    const deduped = dedupeByArtist(tracks, q.intent === 'similar' && q.artists.length ? 3 : 2);
    return deduped.slice(0, ctx.limit);
  }

  /**
   * Catalog guard for LLM-suggested track names. Anything that does not resolve to a
   * row in `tracks` is returned in `rejected` and never played or shown as a result.
   */
  private async resolveSuggestedTracks(suggested: { title: string; artist?: string; providerTrackId?: string }[]) {
    const found: string[] = [];
    const rejected: AssistantTrackRef[] = [];
    for (const s of suggested) {
      const title = String(s.title ?? '').trim();
      if (!title) continue;
      const row = await this.deps.db.queryOne<{ id: string; title: string }>(
        `SELECT t.id, t.title FROM tracks t JOIN artists ar ON ar.id = t.primary_artist_id
          WHERE d7_normalize_text(t.title) = d7_normalize_text($1)
            AND ($2::text IS NULL OR ar.name_key = d7_artist_key($2))
            AND t.streamable AND t.status = 'published'
          LIMIT 1`,
        [title, s.artist?.trim() || null],
      );
      if (row) found.push(String(row.id));
      else rejected.push({ providerTrackId: s.providerTrackId ?? null, title, artist: s.artist ?? 'unknown' });
    }
    return { found, rejected };
  }
}

/* ---------------------------------- helpers ---------------------------------- */

function resolveLimit(q: AssistantQuery, avgDurationMs: number) {
  if (q.durationMinutes) {
    const wantedMs = q.durationMinutes * 60_000;
    return Math.max(8, Math.min(80, Math.round(wantedMs / Math.max(30_000, avgDurationMs))));
  }
  return q.limit || 20;
}

function energyTarget(q: AssistantQuery) {
  const moodDef = q.mood.map((m) => MOODS[m]).find(Boolean);
  const energyRange = moodDef?.energy;
  const valenceRange = moodDef?.valence;
  const base = {
    energy: q.energy === 'high' ? 0.85 : q.energy === 'low' ? 0.25 : 0.55,
    valence: q.mood.includes('sad') ? 0.25 : q.mood.includes('happy') || q.mood.includes('party') ? 0.8 : 0.55,
    dance: q.mood.includes('party') || q.activity === 'workout' || q.tempo === 'fast' ? 0.8 : 0.5,
  };
  if (energyRange) base.energy = (energyRange[0] + energyRange[1]) / 2;
  if (valenceRange) base.valence = (valenceRange[0] + valenceRange[1]) / 2;
  return base;
}

function dedupeByArtist(tracks: Track[], maxPerArtist: number) {
  const counts = new Map<string, number>();
  const out: Track[] = [];
  for (const t of tracks) {
    const artist = t.primaryArtistId;
    const n = counts.get(artist) ?? 0;
    if (n >= maxPerArtist) continue;
    counts.set(artist, n + 1);
    out.push(t);
  }
  return out;
}

export function mergeQueries(base: AssistantQuery, llm: Partial<AssistantQuery>): AssistantQuery {
  const uniq = (...xs: string[][]) => [...new Set(xs.flat().filter(Boolean))];
  return {
    ...base,
    intent: llm.intent ?? base.intent,
    mood: uniq(base.mood, llm.mood ?? []).slice(0, 4),
    genres: uniq(base.genres, llm.genres ?? []).slice(0, 6),
    avoidGenres: uniq(base.avoidGenres, llm.avoidGenres ?? []).slice(0, 6),
    artists: uniq(base.artists, llm.artists ?? []).slice(0, 3),
    energy: llm.energy ?? base.energy,
    tempo: llm.tempo ?? base.tempo,
    explicit: llm.explicit ?? base.explicit,
    language: llm.language ?? base.language,
    activity: llm.activity ?? base.activity,
    durationMinutes: llm.durationMinutes ?? base.durationMinutes,
    era: llm.era ?? base.era,
    limit: base.limit,
  };
}

function titleFromQuery(q: AssistantQuery, prompt: string) {
  const head = q.genres[0] ?? q.mood[0] ?? q.activity ?? 'Assistant';
  const clean = prompt.replace(/[^a-z0-9 ]/gi, '').trim().split(/\s+/).slice(0, 6).join(' ');
  return `${titleCase(head)} mix · ${clean || 'auto'}`.slice(0, 80);
}

function titleCase(s: string) {
  return s.replace(/(^|[-\s])\w/g, (m) => m.toUpperCase()).replace(/-/g, ' ');
}

function buildReply(args: { prompt: string; parsed: AssistantQuery; tracks: Track[]; engine: string; confidence: number; createdPlaylist: string | null }) {
  const { parsed, tracks, confidence, createdPlaylist } = args;
  if (!tracks.length) {
    return `I looked for ${describeQuery(parsed)} but the catalog has nothing matching that yet. Try a broader mood (“calm”, “energetic”), or sync new releases from an admin page so there is more to choose from.`;
  }
  const totalMin = Math.round(tracks.reduce((n, t) => n + t.durationMs, 0) / 60_000);
  const head =
    parsed.intent === 'create_playlist' && createdPlaylist
      ? `Created “${createdPlaylist}” with ${tracks.length} tracks (~${Math.max(1, totalMin)} min).`
      : `${tracks.length} tracks (~${Math.max(1, totalMin)} min) for ${describeQuery(parsed)}.`;
  const certainty = confidence < 0.35 ? ' I guessed at the mood — tell me if that is off.' : '';
  const sample = tracks.slice(0, 3).map((t) => `${t.title} — ${t.artists.map((a) => a.name).join(', ')}`).join(' · ');
  return `${head}${certainty} Starting with ${sample}.`;
}

function rowToLightTrack(r: Record<string, any>): Track {
  return {
    id: String(r.id),
    title: String(r.title),
    albumId: String(r.album_id),
    albumTitle: String(r.album_title ?? ''),
    albumImageUrl: r.album_image_url ?? null,
    artists: Array.isArray(r.artists_json) ? r.artists_json : [r.artists_json],
    primaryArtistId: String(r.primary_artist_id),
    trackNumber: Number(r.track_number ?? 1),
    discNumber: Number(r.disc_number ?? 1),
    durationMs: Number(r.duration_ms ?? 0),
    explicit: Boolean(r.explicit),
    isrc: r.isrc ?? null,
    genres: (r.genre_slugs as string[]) ?? [],
    mood: (r.mood_tags as string[]) ?? [],
    energy: Number(r.energy ?? 0.5),
    valence: Number(r.valence ?? 0.5),
    danceability: Number(r.danceability ?? 0.5),
    acousticness: Number(r.acousticness ?? 0.2),
    popularity: Number(r.popularity ?? 0),
    playCount: Number(r.play_count ?? 0),
    releaseDate: String(r.release_date ?? ''),
    addedAt: String(r.added_at ?? ''),
    contentSource: r.content_source,
    licenseStatus: r.license_status,
    providerName: r.provider_name ?? null,
    providerTrackId: r.provider_track_id ?? null,
    hasAudio: Boolean(r.has_audio),
    streamable: r.streamable === undefined ? true : Boolean(r.streamable),
    liked: Boolean(r.liked),
    likedCount: Number(r.liked_count ?? 0),
    lyricCount: Number(r.lyric_count ?? 0),
    audio: null,
  };
}

/* --------------------------------- LLM path --------------------------------- */

const SYSTEM_PROMPT = `You convert a music-streaming request into STRICT JSON matching this schema:
{"intent":"play"|"create_playlist"|"describe"|"similar"|"browse","mood":string[],"energy":"low"|"medium"|"high"|null,
"tempo":"slow"|"medium"|"fast"|null,"genres":string[],"avoidGenres":string[],"artists":string[],
"durationMinutes":number|null,"explicit":boolean|null,"language":string|null,"activity":string|null,"reply":string,
"suggestedTracks":[{"title":string,"artist":string}]}
Rules: output JSON only. genres/moods must be lowercase slugs. NEVER invent track or artist names:
if you are not sure a recording exists, leave suggestedTracks empty. "reply" is one short sentence.`;

export async function llmParse(
  prompt: string,
  ruleBased: ParseResult,
  opts: { fetchImpl?: typeof fetch; baseUrl?: string; apiKey?: string; model?: string; timeoutMs?: number } = {},
): Promise<{ parsed: Partial<AssistantQuery>; reply: string | null; raw: LlmOutput } | null> {
  const baseUrl = opts.baseUrl ?? env.LLM_BASE_URL;
  const apiKey = opts.apiKey ?? env.LLM_API_KEY;
  if (!baseUrl || !apiKey) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? env.LLM_TIMEOUT_MS);
  try {
    const doFetch = opts.fetchImpl ?? fetch;
    const res = await doFetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: opts.model ?? env.LLM_MODEL,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: JSON.stringify({ request: prompt, heuristicParse: ruleBased.query, matchedVocabulary: ruleBased.matched }),
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = json.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsedJson = llmSchema.parse(JSON.parse(content));
    return {
      parsed: {
        intent: parsedJson.intent,
        mood: parsedJson.mood,
        energy: parsedJson.energy ?? undefined,
        tempo: parsedJson.tempo ?? undefined,
        genres: parsedJson.genres,
        avoidGenres: parsedJson.avoidGenres,
        artists: parsedJson.artists,
        durationMinutes: parsedJson.durationMinutes ?? undefined,
        explicit: parsedJson.explicit ?? undefined,
        language: parsedJson.language ?? undefined,
        activity: parsedJson.activity ?? undefined,
      },
      reply: parsedJson.reply?.slice(0, 400) ?? null,
      raw: parsedJson,
    };
  } catch (err) {
    process.emitWarning?.(`assistant LLM parse failed: ${(err as Error).message}`, 'D7music');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export { parseAssistantQuery, describeQuery, rowToLightTrack };
