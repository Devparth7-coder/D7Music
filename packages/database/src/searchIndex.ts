/**
 * Search index + ranking.
 *
 * Phase 1 engine = PostgreSQL: `search_documents` (denormalized projection of the
 * catalog) + a trigger-maintained tsvector + a weighted ranking function.
 *
 * The service layer (services/search) owns the `SearchBackend` interface, so an
 * Elasticsearch/OpenSearch implementation can be dropped in later without touching
 * a single route: both implement `search()`, `suggest()`, `index()`, `remove()`.
 */
import type { Db } from './client.js';
import { Sql } from './sql.js';
import type { SearchFilters } from '@d7/types';

export function normalizeQuery(raw: string) {
  return raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'by', 'feat', 'ft', 'with', 'song', 'songs', 'music', 'track', 'album', 'listen', 'to']);
export function queryTokens(raw: string) {
  return normalizeQuery(raw)
    .split(' ')
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Dice coefficient on character bigrams — pg_trgm-free fuzzy fallback. */
export function similarity(a: string, b: string) {
  const grams = (s: string) => {
    const t = `  ${s}  `;
    const out = new Map<string, number>();
    for (let i = 0; i < t.length - 1; i += 1) {
      const g = t.slice(i, i + 2);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  let inter = 0;
  let sizeA = 0;
  let sizeB = 0;
  for (const v of ga.values()) sizeA += v;
  for (const [k, v] of gb) {
    sizeB += v;
    const av = ga.get(k);
    if (av) inter += Math.min(av, v);
  }
  if (!sizeA || !sizeB) return 0;
  return (2 * inter) / (sizeA + sizeB);
}

export interface RankedDoc {
  entity_type: 'track' | 'album' | 'artist' | 'playlist' | 'genre';
  entity_id: string;
  title: string;
  body: string | null;
  rank: number;
  match_kind: 'exact' | 'prefix' | 'fulltext' | 'fuzzy';
}

export interface SearchDbOptions {
  query: string;
  limit?: number;
  offset?: number;
  types?: RankedDoc['entity_type'][];
  filters?: SearchFilters;
  viewerId?: string | null;
  /** Followed-artist boost so "my stuff" floats up for signed-in users. */
  boostArtistIds?: string[];
}

export async function searchDocuments(db: Db, opts: SearchDbOptions): Promise<{ docs: RankedDoc[]; tookMs: number; usedFuzzy: boolean }> {
  const started = Date.now();
  const norm = normalizeQuery(opts.query);
  const limit = Math.min(opts.limit ?? 30, 60);
  const offset = opts.offset ?? 0;
  if (!norm) return { docs: [], tookMs: 0, usedFuzzy: false };

  const q = new Sql();
  const normParam = q.bind(norm);
  const limitP = q.bind(limit);
  const offsetP = q.bind(offset);
  const typeFilter = opts.types?.length ? `AND d.entity_type = ANY(${q.bindList(opts.types, 'text[]')})` : '';
  const boosts = (opts.boostArtistIds ?? []).filter(Boolean);
  const boostParam = boosts.length ? q.bindList(boosts, 'uuid[]') : null;

  const sql = `
    WITH scored AS (
      SELECT d.entity_type, d.entity_id, d.title, d.body, d.popularity, d.is_new,
             ts_rank(d.tsv, websearch_to_tsquery('simple', ${normParam})) AS text_rank,
             (d.norm_title = ${normParam}) AS is_exact,
             (d.norm_title LIKE ${normParam} || '%') AS is_prefix,
             (d.norm_title LIKE '%' || ${normParam} || '%' OR d.norm_body LIKE '%' || ${normParam} || '%') AS is_substring,
             ${
               boostParam
                 ? `(d.entity_type = 'artist' AND d.entity_id = ANY(${boostParam}))
                 OR EXISTS (SELECT 1 FROM tracks bt WHERE bt.id = d.entity_id AND bt.primary_artist_id = ANY(${boostParam}))
                 OR EXISTS (SELECT 1 FROM albums ba WHERE ba.id = d.entity_id AND ba.artist_id = ANY(${boostParam}))`
                 : 'false'
             } AS is_boosted
        FROM search_documents d
       WHERE (d.tsv @@ websearch_to_tsquery('simple', ${normParam})
              OR d.norm_title LIKE ${normParam} || '%'
              OR d.norm_title LIKE '%' || ${normParam} || '%'
              OR d.norm_body LIKE '%' || ${normParam} || '%')
         ${typeFilter}
    ), ranked AS (
      SELECT s.*,
             ( s.text_rank * 2.0
               + CASE WHEN s.is_exact THEN 6.0 ELSE 0 END
               + CASE WHEN s.is_prefix THEN 3.0 ELSE 0 END
               + CASE WHEN s.is_substring AND NOT s.is_prefix THEN 1.2 ELSE 0 END
               + least(2.0, s.popularity / 40.0)
               + CASE WHEN s.is_new THEN 0.4 ELSE 0 END
               + coalesce(cl.clicks, 0) * 0.02
               + CASE WHEN s.is_boosted THEN 1.5 ELSE 0 END
             ) AS rank,
             CASE WHEN s.is_exact THEN 'exact' WHEN s.is_prefix THEN 'prefix' ELSE 'fulltext' END AS match_kind
        FROM scored s
        LEFT JOIN search_clicks cl ON cl.norm_query = ${normParam}
          AND cl.entity_type = s.entity_type AND cl.entity_id = s.entity_id
    )
    SELECT entity_type, entity_id, title, body, rank::float8 AS rank, match_kind
      FROM ranked
     ORDER BY rank DESC, popularity DESC
     LIMIT ${limitP} OFFSET ${offsetP}`;
  const rows = await db.query<Record<string, any>>(sql, q.values);
  let docs: RankedDoc[] = rows.map((r) => ({
    entity_type: r.entity_type,
    entity_id: String(r.entity_id),
    title: String(r.title),
    body: r.body ?? null,
    rank: Number(r.rank ?? 0),
    match_kind: r.match_kind,
  }));

  // Typo tolerance. `pg_trgm` is optional in this project (managed Postgres tiers do not
  // always allow extensions), so a misspelt query is repaired by pulling a *bounded*
  // candidate set — substring matches plus titles of a similar length, most popular first —
  // and scoring them in JS. The candidate cap keeps worst-case work predictable.
  let usedFuzzy = false;
  if (docs.length < 4 && norm.length > 2) {
    const tokens = queryTokens(opts.query);
    const params: unknown[] = [];
    const clauses: string[] = [];
    for (const token of tokens) {
      params.push(`%${token}%`);
      clauses.push(`(norm_title LIKE $${params.length} OR norm_body LIKE $${params.length})`);
    }
    params.push(Math.max(2, norm.length - 3));
    const minLen = params.length;
    params.push(norm.length + 3);
    const maxLen = params.length;
    const candidates = await db.query<Record<string, any>>(
      `SELECT entity_type, entity_id, title, body, popularity, norm_title
         FROM search_documents
        WHERE ${clauses.length ? `(${clauses.join(' OR ')}) OR ` : ''}(length(norm_title) BETWEEN $${minLen} AND $${maxLen})
        ORDER BY popularity DESC, updated_at DESC
        LIMIT 400`,
      params,
    );
    const seen = new Set(docs.map((d) => `${d.entity_type}:${d.entity_id}`));
    const fuzzy: RankedDoc[] = [];
    for (const c of candidates) {
      const title = normalizeQuery(String(c.norm_title ?? ''));
      const hay = normalizeQuery(`${title} ${String(c.body ?? '')}`);
      const substring = tokens.length > 0 && tokens.some((t) => hay.includes(t));
      const closest = Math.max(...(tokens.length ? tokens : [norm]).map((t) => similarity(t, title.split(' ')[0] ?? t).valueOf()), similarity(norm, title));
      const score = substring ? 0.75 : closest >= 0.7 ? closest : 0;
      if (score < 0.6) continue;
      const key = `${c.entity_type}:${c.entity_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fuzzy.push({
        entity_type: c.entity_type,
        entity_id: String(c.entity_id),
        title: String(c.title),
        body: c.body ?? null,
        rank: score + Math.min(0.5, Number(c.popularity ?? 0) / 100),
        match_kind: 'fuzzy',
      });
    }
    if (fuzzy.length) {
      usedFuzzy = true;
      docs = [...docs, ...fuzzy].sort((a, b) => b.rank - a.rank).slice(0, limit);
    }
  }

  return { docs, tookMs: Date.now() - started, usedFuzzy };
}

/** Full rebuild (seed, backfill, index-mapping changes). Idempotent + interrupt-safe. */
export async function rebuildSearchIndex(db: Db) {
  const t0 = Date.now();
  await db.transaction(async (tx) => {
    await tx.execute(`
      INSERT INTO search_documents (entity_type, entity_id, title, body, keywords, popularity, is_new, added_at, updated_at)
      SELECT 'track', t.id, t.title,
             coalesce(ar.name,'') || ' ' || coalesce(al.title,''),
             coalesce((SELECT string_agg(DISTINCT g.slug, ' ') FROM track_genres tg JOIN genres g ON g.id = tg.genre_id WHERE tg.track_id = t.id), '')
               || ' ' || coalesce((SELECT string_agg(DISTINCT m.tag, ' ') FROM track_moods m WHERE m.track_id = t.id), ''),
             t.popularity + least(50, ln(1 + t.play_count)),
             (al.release_date > now()::date - 30),
             t.added_at, now()
        FROM tracks t
        JOIN albums al ON al.id = t.album_id
        JOIN artists ar ON ar.id = t.primary_artist_id
       WHERE t.status = 'published' AND al.status = 'published'
      ON CONFLICT (entity_type, entity_id) DO UPDATE SET
        title = EXCLUDED.title, body = EXCLUDED.body, keywords = EXCLUDED.keywords,
        popularity = EXCLUDED.popularity, is_new = EXCLUDED.is_new, updated_at = now()`);

    await tx.execute(`
      INSERT INTO search_documents (entity_type, entity_id, title, body, keywords, popularity, is_new, added_at, updated_at)
      SELECT 'album', al.id, al.title, coalesce(ar.name,''),
             coalesce((SELECT string_agg(DISTINCT g.slug,' ') FROM album_genres ag JOIN genres g ON g.id = ag.genre_id WHERE ag.album_id = al.id), ''),
             al.popularity, (al.release_date > now()::date - 30), al.added_at, now()
        FROM albums al JOIN artists ar ON ar.id = al.artist_id WHERE al.status = 'published'
      ON CONFLICT (entity_type, entity_id) DO UPDATE SET
        title = EXCLUDED.title, body = EXCLUDED.body, keywords = EXCLUDED.keywords,
        popularity = EXCLUDED.popularity, is_new = EXCLUDED.is_new, updated_at = now()`);

    await tx.execute(`
      INSERT INTO search_documents (entity_type, entity_id, title, body, keywords, popularity, is_new, added_at, updated_at)
      SELECT 'artist', ar.id, ar.name, coalesce(left(ar.bio, 300),''),
             coalesce((SELECT string_agg(DISTINCT g.slug,' ') FROM tracks t
                        JOIN track_genres tg ON tg.track_id = t.id JOIN genres g ON g.id = tg.genre_id
                       WHERE t.primary_artist_id = ar.id), ''),
             ar.popularity, false, ar.created_at, now() FROM artists ar
      ON CONFLICT (entity_type, entity_id) DO UPDATE SET
        title = EXCLUDED.title, body = EXCLUDED.body, keywords = EXCLUDED.keywords,
        popularity = EXCLUDED.popularity, updated_at = now()`);

    await tx.execute(`
      INSERT INTO search_documents (entity_type, entity_id, title, body, keywords, popularity, is_new, added_at, updated_at)
      SELECT 'playlist', p.id, p.title, coalesce(p.description,''), 'playlist', p.follower_count::float8, false, p.created_at, now()
        FROM playlists p WHERE p.visibility <> 'private'
      ON CONFLICT (entity_type, entity_id) DO UPDATE SET
        title = EXCLUDED.title, body = EXCLUDED.body, popularity = EXCLUDED.popularity, updated_at = now()`);

    await tx.execute(`
      INSERT INTO search_documents (entity_type, entity_id, title, body, keywords, popularity, is_new, added_at, updated_at)
      SELECT 'genre', g.id, g.name, coalesce(g.description,''), g.slug, g.track_count::float8, false, g.created_at, now() FROM genres g
      ON CONFLICT (entity_type, entity_id) DO UPDATE SET
        title = EXCLUDED.title, body = EXCLUDED.body, keywords = EXCLUDED.keywords, popularity = EXCLUDED.popularity, updated_at = now()`);

    // Drop rows whose entity disappeared or became private/unpublished.
    await tx.execute(`
      DELETE FROM search_documents d
       WHERE (d.entity_type = 'track' AND NOT EXISTS (SELECT 1 FROM tracks t WHERE t.id = d.entity_id AND t.status='published'))
          OR (d.entity_type = 'album' AND NOT EXISTS (SELECT 1 FROM albums a WHERE a.id = d.entity_id AND a.status='published'))
          OR (d.entity_type = 'playlist' AND NOT EXISTS (SELECT 1 FROM playlists p WHERE p.id = d.entity_id AND p.visibility <> 'private'))`);
  });
  const total = await db.queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM search_documents`);
  return { documents: Number(total?.c ?? 0), tookMs: Date.now() - t0 };
}

/* --------------------------- typeahead + history --------------------------- */

export interface SuggestItem {
  text: string;
  type: RankedDoc['entity_type'] | 'recent';
  entityId?: string;
  subtitle?: string | null;
  imageUrl?: string | null;
  score: number;
}

export async function suggestDocuments(db: Db, raw: string, limit = 8): Promise<SuggestItem[]> {
  const norm = normalizeQuery(raw);
  if (!norm) return [];
  const rows = await db.query<Record<string, any>>(
    `SELECT entity_type, entity_id, title, body, popularity
       FROM search_documents
      WHERE norm_title LIKE $1 || '%' OR norm_title LIKE '% ' || $1 || '%' OR norm_title LIKE '%' || $1 || '%'
      ORDER BY (norm_title = $1) DESC, (norm_title LIKE $1 || '%') DESC, popularity DESC
      LIMIT $2`,
    [norm, Math.min(limit, 12)],
  );
  return rows.map((r) => ({
    text: String(r.title),
    type: r.entity_type,
    entityId: String(r.entity_id),
    subtitle: r.body ? String(r.body).split(' ').slice(0, 6).join(' ') : null,
    score: Number(r.popularity ?? 0),
  }));
}

export async function logSearch(db: Db, input: { userId?: string | null; query: string; results: number; filters?: Record<string, unknown> }) {
  const norm = normalizeQuery(input.query);
  if (!norm) return;
  await db.execute(
    `INSERT INTO search_queries (user_id, raw_query, norm_query, result_count, filters)
     VALUES ($1::uuid, $2, $3, $4, $5::jsonb)`,
    [input.userId ?? null, input.query.slice(0, 200), norm, input.results, JSON.stringify(input.filters ?? {})],
  );
}

export async function recordSearchClick(db: Db, input: { query: string; entityType: string; entityId: string }) {
  const norm = normalizeQuery(input.query);
  if (!norm) return;
  await db.execute(
    `INSERT INTO search_clicks (norm_query, entity_type, entity_id, clicks, updated_at)
     VALUES ($1, $2, $3::uuid, 1, now())
     ON CONFLICT (norm_query, entity_type, entity_id) DO UPDATE SET clicks = search_clicks.clicks + 1, updated_at = now()`,
    [norm, input.entityType, input.entityId],
  );
}

export async function recentSearches(db: Db, userId: string, limit = 8) {
  const rows = await db.query<{ norm_query: string; raw_query: string; last_at: string; count: number }>(
    `SELECT norm_query, max(raw_query) AS raw_query, max(created_at)::text AS last_at, count(*)::int AS count
       FROM search_queries
      WHERE user_id = $1::uuid AND norm_query <> ''
      GROUP BY norm_query ORDER BY max(created_at) DESC LIMIT $2`,
    [userId, limit],
  );
  return rows.map((r) => ({ text: r.raw_query || r.norm_query, type: 'recent' as const, score: r.count, subtitle: r.last_at }));
}

export async function clearRecentSearches(db: Db, userId: string) {
  return db.execute(`DELETE FROM search_queries WHERE user_id = $1::uuid`, [userId]);
}

/** Trending queries power the "what people are searching" strip. */
export async function trendingQueries(db: Db, limit = 6) {
  const rows = await db.query<{ norm_query: string; c: number }>(
    `SELECT norm_query, count(*)::int AS c FROM search_queries
      WHERE created_at > now() - interval '7 days' AND norm_query <> ''
      GROUP BY norm_query ORDER BY c DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({ text: r.norm_query, count: r.c }));
}

