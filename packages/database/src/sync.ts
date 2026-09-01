/**
 * Idempotent catalog write layer used by ReleaseSyncService.
 *
 * Rules enforced here (not in the job) so *every* write path — sync, creator
 * upload, admin import, seed — shares the same anti-duplication guarantees:
 *
 *  1. Provider identity is the join key: (provider, provider_{artist|album|track}_id).
 *  2. Natural identity is the fallback: normalized artist + album title (+ type),
 *     album + disc/track position, and ISRC when present.
 *  3. All writes are `INSERT .. ON CONFLICT .. DO UPDATE`, so re-running a sync
 *     converges to the same row set instead of duplicating it.
 *  4. Artwork/metadata only moves "forward": we never blank an existing image or
 *     overwrite richer metadata with a sparser provider payload.
 */
import type { Db } from './client.js';
import type { ProviderAlbum, ProviderArtist, ProviderTrack, TrackFeatures } from '@d7/music-providers';

export interface SyncCounters {
  insertedArtists: number;
  insertedAlbums: number;
  insertedTracks: number;
  updatedAlbums: number;
  updatedTracks: number;
  skippedDuplicates: number;
  rejectedInvalid: number;
  newReleaseRows: number;
}

export const newCounters = (): SyncCounters => ({
  insertedArtists: 0,
  insertedAlbums: 0,
  insertedTracks: 0,
  updatedAlbums: 0,
  updatedTracks: 0,
  skippedDuplicates: 0,
  rejectedInvalid: 0,
  newReleaseRows: 0,
});

/** Postgres returns one row per INSERT and none for a no-op update; we use that. */
type UpsertOutcome = 'inserted' | 'updated';

async function upsertReturningId(db: Db, sql: string, params: unknown[], marker: string): Promise<{ id: string; outcome: UpsertOutcome }> {
  const row = await db.queryOne<Record<string, unknown>>(sql, params);
  if (!row) throw new Error(`${marker}: upsert returned no row`);
  return { id: String(row.id), outcome: row._inserted === true ? 'inserted' : 'updated' };
}

/* --------------------------------- validation --------------------------------- */

export interface ValidationIssue {
  field: string;
  message: string;
  severity: 'reject' | 'warn';
}

/** Metadata-only guard: reject rows we could never show responsibly. */
export function validateTrackInput(input: Partial<ProviderTrack>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!input.title || !input.title.trim()) issues.push({ field: 'title', message: 'missing title', severity: 'reject' });
  if (!Number.isFinite(input.durationMs as number) || (input.durationMs ?? 0) <= 0)
    issues.push({ field: 'durationMs', message: 'duration must be a positive number of ms', severity: 'reject' });
  if ((input.durationMs ?? 0) > 1000 * 60 * 60)
    issues.push({ field: 'durationMs', message: 'implausible duration (>1h)', severity: 'warn' });
  if (!input.providerTrackId) issues.push({ field: 'providerTrackId', message: 'missing provider id', severity: 'reject' });
  if (input.isrc !== undefined && input.isrc !== null && !/^[A-Z]{2}[A-Z0-9]{3}\d{2}\d{5}$/.test(input.isrc.toUpperCase()))
    issues.push({ field: 'isrc', message: `ISRC "${input.isrc}" is not in XX-XXX-YY-NNNNN form`, severity: 'warn' });
  return issues;
}

export function validateAlbumInput(input: Partial<ProviderAlbum>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!input.title || !input.title.trim()) issues.push({ field: 'title', message: 'missing title', severity: 'reject' });
  if (!input.providerAlbumId) issues.push({ field: 'providerAlbumId', message: 'missing provider id', severity: 'reject' });
  if (!input.releaseDate) issues.push({ field: 'releaseDate', message: 'missing release date', severity: 'warn' });
  else if (Number.isNaN(Date.parse(input.releaseDate)))
    issues.push({ field: 'releaseDate', message: `unparseable date "${input.releaseDate}"`, severity: 'warn' });
  return issues;
}

/**
 * The four `provider_*` mapping tables exist to make a catalogue auditable (which provider said what,
 * when), and each has an FK to `music_providers(name)`. A provider row is operator configuration, so
 * an unregistered name — a custom adapter, a typo in `MUSIC_PROVIDER`, a database that was migrated
 * but never given registry rows — must not be able to fail the catalog write that already succeeded.
 * When the name is unknown we skip the mapping row and let `/api/admin/providers` show the gap.
 */
async function providerRegistered(db: Db, provider: string): Promise<boolean> {
  if (!provider) return false;
  return Boolean(await db.queryOne(`SELECT 1 AS ok FROM music_providers WHERE name = $1`, [provider]));
}

/* --------------------------------- artists --------------------------------- */

export interface ResolveArtistResult {
  artistId: string;
  slug: string;
  outcome: UpsertOutcome;
}

export async function upsertArtist(
  db: Db,
  provider: string,
  input: { name: string; bio?: string | null; imageUrl?: string | null; popularity?: number; providerArtistId?: string | null; externalIds?: Record<string, string> },
): Promise<ResolveArtistResult> {
  const name = input.name.trim();
  const row = await db.queryOne<{ id: string; slug: string; _inserted: boolean }>(
    `WITH ins AS (
       INSERT INTO artists (id, name, slug, bio, image_url, popularity, external_links, updated_at)
       VALUES (d7_uuid(), $1, NULL, $2, $3, $4, $5::jsonb, now())
       ON CONFLICT (name_key) DO NOTHING
       RETURNING id, slug, true AS _inserted
     ), existing AS (
       SELECT id, slug FROM artists WHERE name_key = d7_artist_key($1)
     ), upd AS (
       UPDATE artists a
          SET bio         = coalesce(a.bio, NULLIF($2, '')),
              image_url   = coalesce(NULLIF($3, ''), a.image_url),
              popularity  = greatest(a.popularity, $4::float8),
              external_links = coalesce(a.external_links,'{}'::jsonb) || coalesce($5::jsonb,'{}'::jsonb),
              updated_at  = now()
        WHERE NOT EXISTS (SELECT 1 FROM ins) AND a.id = (SELECT id FROM existing)
        RETURNING a.id, a.slug, false AS _inserted
     )
     SELECT * FROM ins UNION ALL SELECT * FROM upd`,
    [
      name,
      input.bio ?? null,
      input.imageUrl ?? null,
      input.popularity ?? 0,
      JSON.stringify(input.externalIds ?? {}),
    ],
  );
  if (!row) throw new Error(`artist upsert failed for "${name}"`);
  if (input.providerArtistId && (await providerRegistered(db, provider))) {
    await db.execute(
      `INSERT INTO provider_artists (provider, provider_artist_id, artist_id, payload, last_seen_at)
       VALUES ($1, $2, $3::uuid, $4::jsonb, now())
       ON CONFLICT (provider, provider_artist_id)
       DO UPDATE SET artist_id = EXCLUDED.artist_id, payload = EXCLUDED.payload, last_seen_at = now()`,
      [provider, String(input.providerArtistId), row.id, JSON.stringify({ name, external: input.externalIds ?? {} })],
    );
  }
  return { artistId: row.id, slug: row.slug, outcome: row._inserted ? 'inserted' : 'updated' };
}

/* --------------------------------- albums --------------------------------- */

export interface UpsertAlbumInput {
  provider: string;
  providerAlbumId: string;
  title: string;
  artistId: string;
  albumType: 'album' | 'single' | 'ep' | 'compilation';
  releaseDate: string;
  imageUrl?: string | null;
  primaryColor?: string | null;
  labelName?: string | null;
  copyrightNote?: string | null;
  upc?: string | null;
  popularity?: number;
  contentSource?: 'platform_owned' | 'licensed_provider' | 'partner_feed';
  licenseStatus?: 'unlicensed' | 'pending_review' | 'licensed' | 'rejected' | 'expired';
  genreSlugs?: string[];
  pitch?: string | null;
  providerPayload?: unknown;
  /** Only metadata-driven providers: album is browsable but not playable here. */
  streamable?: boolean;
  status?: 'draft' | 'submitted' | 'approved' | 'rejected' | 'scheduled' | 'published';
}

export async function upsertAlbum(db: Db, input: UpsertAlbumInput, counters?: SyncCounters) {
  const releaseDate = /^\d{4}-\d{2}-\d{2}/.test(input.releaseDate ?? '') ? input.releaseDate.slice(0, 10) : new Date().toISOString().slice(0, 10);
  const { id: albumId, outcome } = await upsertReturningId(
    db,
    `WITH ins AS (
       INSERT INTO albums (id, title, slug, artist_id, album_type, release_date, added_at, image_url,
                           primary_color, label_name, copyright_note, upc, popularity, content_source,
                           license_status, status, pitch, created_at, updated_at)
       VALUES (d7_uuid(), $1, NULL, $2::uuid, $3, $4::date, now(), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now(), now())
       ON CONFLICT (artist_id, title_key, album_type) DO NOTHING
       RETURNING id, true AS _inserted
     ), existing AS (
       SELECT id FROM albums WHERE artist_id = $2::uuid AND title_key = d7_normalize_text($1) AND album_type = $3
     ), upd AS (
       UPDATE albums a
          SET release_date  = least(a.release_date, $4::date),
              image_url     = coalesce(NULLIF($5,''), a.image_url),
              primary_color = coalesce(a.primary_color, $6),
              label_name    = coalesce(a.label_name, NULLIF($7,'')),
              copyright_note= coalesce(a.copyright_note, NULLIF($8,'')),
              upc           = coalesce(a.upc, NULLIF($9,'')),
              popularity    = greatest(a.popularity, $10::float8),
              updated_at    = now()
        WHERE NOT EXISTS (SELECT 1 FROM ins) AND a.id = (SELECT id FROM existing)
        RETURNING a.id, false AS _inserted
     )
     SELECT * FROM ins UNION ALL SELECT * FROM upd`,
    [
      input.title.trim(),
      input.artistId,
      // album_type is NOT NULL and the slug trigger hashes it, so a provider that omits the type
      // must not reach the executor as NULL.
      input.albumType ?? 'album',
      releaseDate,
      input.imageUrl ?? null,
      input.primaryColor ?? null,
      input.labelName ?? null,
      input.copyrightNote ?? null,
      input.upc ?? null,
      input.popularity ?? 0,
      input.contentSource ?? 'licensed_provider',
      input.licenseStatus ?? 'licensed',
      input.status ?? 'published',
      input.pitch ?? null,
    ],
    'album upsert',
  );

  if (await providerRegistered(db, input.provider)) await db.execute(
    `INSERT INTO provider_albums (provider, provider_album_id, album_id, payload, release_date, last_seen_at)
     VALUES ($1, $2, $3::uuid, $4::jsonb, $5::date, now())
     ON CONFLICT (provider, provider_album_id)
     DO UPDATE SET album_id = EXCLUDED.album_id, payload = EXCLUDED.payload,
                   release_date = EXCLUDED.release_date, last_seen_at = now()`,
    [input.provider, String(input.providerAlbumId), albumId, JSON.stringify(input.providerPayload ?? {}), releaseDate],
  );

  if (input.genreSlugs?.length) {
    await db.execute(
      `INSERT INTO album_genres (album_id, genre_id)
       SELECT $1::uuid, g.id FROM genres g WHERE g.slug = ANY($2::text[])
       ON CONFLICT DO NOTHING`,
      [albumId, input.genreSlugs],
    );
  }

  if (counters) counters[outcome === 'inserted' ? 'insertedAlbums' : 'updatedAlbums'] += 1;
  return { albumId, outcome, releaseDate };
}

/* --------------------------------- tracks --------------------------------- */

export interface UpsertTrackInput {
  provider: string;
  providerTrackId: string;
  providerAlbumId?: string | null;
  albumId: string;
  artistId: string;
  title: string;
  trackNumber?: number;
  discNumber?: number;
  durationMs: number;
  explicit?: boolean;
  isrc?: string | null;
  genres?: string[];
  moods?: string[];
  features?: TrackFeatures;
  popularity?: number;
  releaseDate?: string;
  contentSource?: 'platform_owned' | 'licensed_provider' | 'partner_feed';
  licenseStatus?: 'unlicensed' | 'pending_review' | 'licensed' | 'rejected' | 'expired';
  /** Only true when this platform is allowed to serve the bytes. */
  streamable?: boolean;
  storageKey?: string | null;
  mimeType?: string | null;
  byteSize?: number | null;
  previewOnly?: boolean;
  status?: 'draft' | 'submitted' | 'approved' | 'rejected' | 'scheduled' | 'published';
  providerPayload?: unknown;
  explicitStreamableOverride?: boolean;
}

/**
 * Positional collision handling: if another track already owns (album, disc, number)
 * we shift this one to the next free position instead of failing the whole batch.
 */
async function freePosition(db: Db, albumId: string, disc: number, trackNumber: number) {
  const taken = await db.query<{ track_number: number }>(
    `SELECT track_number FROM tracks WHERE album_id = $1::uuid AND disc_number = $2`,
    [albumId, disc],
  );
  const used = new Set(taken.map((r) => Number(r.track_number)));
  let n = trackNumber || 1;
  while (used.has(n)) n += 1;
  return n;
}

export async function upsertTrack(db: Db, input: UpsertTrackInput, counters?: SyncCounters) {
  const issues = validateTrackInput(input);
  if (issues.some((i) => i.severity === 'reject')) {
    if (counters) counters.rejectedInvalid += 1;
    return { outcome: 'rejected' as const, issues };
  }
  const isrc = input.isrc ? input.isrc.toUpperCase().replace(/[^A-Z0-9]/g, '') : null;
  const releaseDate = (input.releaseDate ?? '').slice(0, 10) || new Date().toISOString().slice(0, 10);

  // Resolve identity: provider id > ISRC > (album, position).
  const existing = await db.queryOne<{ id: string; album_id: string; title: string; duration_ms: number }>(
    `SELECT id, album_id, title, duration_ms FROM tracks
      WHERE (provider_name = $1 AND provider_track_id = $2)
         OR ($4::text IS NOT NULL AND isrc = $4)
         OR (album_id = $3::uuid AND d7_normalize_text(title) = d7_normalize_text($5))
      ORDER BY (provider_name = $1 AND provider_track_id = $2) DESC, id NULLS LAST
      LIMIT 1`,
    [input.provider, String(input.providerTrackId), input.albumId, isrc, input.title.trim()],
  );

  if (existing) {
    const disc = input.discNumber ?? 1;
    const position =
      existing.album_id === input.albumId
        ? (await db.queryOne<{ track_number: number }>(`SELECT track_number FROM tracks WHERE id = $1::uuid`, [existing.id]))
            ?.track_number ?? input.trackNumber ?? 1
        : await freePosition(db, input.albumId, disc, input.trackNumber ?? 1);
    await db.execute(
      `UPDATE tracks SET
           album_id = $2::uuid, primary_artist_id = $3::uuid, title = $4,
           track_number = $5, disc_number = $6, duration_ms = $7, explicit = $8,
           isrc = coalesce($9, isrc), popularity = greatest(popularity, $10::float8),
           energy = coalesce($11, energy), valence = coalesce($12, valence),
           danceability = coalesce($13, danceability), acousticness = coalesce($14, acousticness),
           instrumentalness = coalesce($15, instrumentalness), bpm = coalesce($16, bpm),
           key_scale = coalesce($17, key_scale),
           storage_key = coalesce($18, storage_key), mime_type = coalesce($19, mime_type),
           byte_size = coalesce($20, byte_size),
           streamable = tracks.streamable OR $21,
           content_source = $22, license_status = $23, release_date = $24::date,
           provider_name = $1, provider_track_id = $25, updated_at = now()
       WHERE id = $26::uuid`,
      [
        input.provider,
        input.albumId,
        input.artistId,
        input.title.trim(),
        position,
        disc,
        Math.round(input.durationMs),
        input.explicit ?? false,
        isrc,
        input.popularity ?? 0,
        input.features?.energy ?? null,
        input.features?.valence ?? null,
        input.features?.danceability ?? null,
        input.features?.acousticness ?? null,
        input.features?.instrumentalness ?? null,
        input.features?.bpm ?? null,
        input.features?.keyScale ?? null,
        input.storageKey ?? null,
        input.mimeType ?? null,
        input.byteSize ?? null,
        Boolean(input.streamable),
        input.contentSource ?? 'licensed_provider',
        input.licenseStatus ?? 'licensed',
        releaseDate,
        String(input.providerTrackId),
        existing.id,
      ],
    );
    if (counters) counters.updatedTracks += 1;
    await linkTrackArtists(db, existing.id, input.artistId, []);
    await linkGenres(db, existing.id, input.genres ?? [], 0.6);
    await linkMoods(db, existing.id, input.moods ?? []);
    await recordProviderTrack(db, input, existing.id);
    await touchSearchDocument(db, 'track', existing.id);
    return { outcome: 'updated' as const, trackId: existing.id, issues };
  }

  const position = await freePosition(db, input.albumId, input.discNumber ?? 1, input.trackNumber ?? 1);
  const created = await db.queryOne<{ id: string }>(
    `INSERT INTO tracks (id, album_id, primary_artist_id, title, track_number, disc_number, duration_ms,
                         explicit, isrc, storage_key, mime_type, byte_size, content_source, license_status,
                         provider_name, provider_track_id, status, streamable, energy, valence, danceability,
                         acousticness, instrumentalness, key_scale, bpm, popularity, release_date, added_at)
     VALUES (d7_uuid(), $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
             $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26::date, now())
     RETURNING id`,
    [
      input.albumId,
      input.artistId,
      input.title.trim(),
      position,
      input.discNumber ?? 1,
      Math.round(input.durationMs),
      input.explicit ?? false,
      isrc,
      input.storageKey ?? null,
      input.mimeType ?? null,
      input.byteSize ?? null,
      input.contentSource ?? 'licensed_provider',
      input.licenseStatus ?? 'licensed',
      input.provider,
      String(input.providerTrackId),
      input.status ?? 'published',
      Boolean(input.streamable),
      input.features?.energy ?? 0.5,
      input.features?.valence ?? 0.5,
      input.features?.danceability ?? 0.5,
      input.features?.acousticness ?? 0.2,
      input.features?.instrumentalness ?? 0,
      input.features?.keyScale ?? null,
      input.features?.bpm ?? null,
      input.popularity ?? 0,
      releaseDate,
    ],
  );
  if (!created) throw new Error('track insert failed');
  if (counters) counters.insertedTracks += 1;
  await linkTrackArtists(db, created.id, input.artistId, []);
  await linkGenres(db, created.id, input.genres ?? [], 1);
  await linkMoods(db, created.id, input.moods ?? []);
  await recordProviderTrack(db, input, created.id);
  await touchSearchDocument(db, 'track', created.id);
  return { outcome: 'inserted' as const, trackId: created.id, issues };
}

async function recordProviderTrack(db: Db, input: UpsertTrackInput, trackId: string) {
  if (!(await providerRegistered(db, input.provider))) return;
  await db.execute(
    `INSERT INTO provider_tracks (provider, provider_track_id, track_id, provider_album_id, preview_only, streamable, payload, last_seen_at)
     VALUES ($1, $2, $3::uuid, $4, $5, $6, $7::jsonb, now())
     ON CONFLICT (provider, provider_track_id)
     DO UPDATE SET track_id = EXCLUDED.track_id, provider_album_id = EXCLUDED.provider_album_id,
                   preview_only = EXCLUDED.preview_only, streamable = EXCLUDED.streamable,
                   payload = EXCLUDED.payload, last_seen_at = now()`,
    [
      input.provider,
      String(input.providerTrackId),
      trackId,
      input.providerAlbumId ? String(input.providerAlbumId) : null,
      input.previewOnly ?? true,
      Boolean(input.streamable),
      JSON.stringify(input.providerPayload ?? {}),
    ],
  );
}

export async function linkTrackArtists(db: Db, trackId: string, primaryArtistId: string, featuredIds: string[]) {
  await db.execute(`INSERT INTO track_artists (track_id, artist_id, credit_type, position)
                     VALUES ($1::uuid, $2::uuid, 'primary', 0) ON CONFLICT DO NOTHING`, [trackId, primaryArtistId]);
  featuredIds.forEach((id, i) => {
    void db.execute(
      `INSERT INTO track_artists (track_id, artist_id, credit_type, position)
       VALUES ($1::uuid, $2::uuid, 'featured', $3) ON CONFLICT DO NOTHING`,
      [trackId, id, i + 1],
    );
  });
}

export async function linkGenres(db: Db, trackId: string, genreSlugs: string[], weight: number) {
  if (!genreSlugs.length) return;
  await db.execute(
    `INSERT INTO track_genres (track_id, genre_id, weight)
     SELECT $1::uuid, g.id, $3::float8 FROM genres g WHERE g.slug = ANY($2::text[])
     ON CONFLICT (track_id, genre_id) DO UPDATE SET weight = greatest(track_genres.weight, EXCLUDED.weight)`,
    [trackId, genreSlugs, weight],
  );
}

export async function linkMoods(db: Db, trackId: string, moods: string[]) {
  if (!moods.length) return;
  await db.execute(
    `INSERT INTO track_moods (track_id, tag, weight)
     SELECT $1::uuid, unnest($2::text[]), 1.0 ON CONFLICT (track_id, tag) DO NOTHING`,
    [trackId, moods],
  );
}

/* ------------------------------ new releases ------------------------------ */

export async function registerNewRelease(db: Db, input: { entityType: 'album' | 'track'; entityId: string; artistId: string; provider: string; releaseDate: string }) {
  const res = await db.execute(
    `INSERT INTO new_releases (id, entity_type, entity_id, artist_id, provider, release_date, detected_at, published_at, source_snapshot)
     VALUES (d7_uuid(), $1, $2::uuid, $3::uuid, $4, $5::date, now(), now(), jsonb_build_object('detected_by','release_sync'))
     ON CONFLICT (entity_type, entity_id, provider) DO UPDATE SET detected_at = now(), release_date = EXCLUDED.release_date`,
    [input.entityType, input.entityId, input.artistId, input.provider, input.releaseDate],
  );
  return res;
}

/* ------------------------------ search index ------------------------------ */

/** Rebuild one search document from live catalog data (used by sync + uploads). */
export async function touchSearchDocument(db: Db, entityType: 'track' | 'album' | 'artist' | 'playlist' | 'genre', entityId: string) {
  if (entityType === 'track') {
    await db.execute(
      `INSERT INTO search_documents (entity_type, entity_id, title, body, keywords, popularity, is_new, added_at, updated_at)
       SELECT 'track', t.id, t.title,
              ar.name || ' ' || coalesce(al.title,'') || ' ' || coalesce(string_agg(DISTINCT g.slug,' '), ''),
              coalesce(string_agg(DISTINCT m.tag,' '), ''),
              t.popularity + least(50, ln(1 + t.play_count)) AS pop,
              (al.release_date > now()::date - 30), t.added_at, now()
         FROM tracks t
         JOIN albums al ON al.id = t.album_id
         JOIN artists ar ON ar.id = t.primary_artist_id
         LEFT JOIN track_genres tg ON tg.track_id = t.id
         LEFT JOIN genres g ON g.id = tg.genre_id
         LEFT JOIN track_moods m ON m.track_id = t.id
        WHERE t.id = $1::uuid
        GROUP BY t.id, ar.name, al.title, al.release_date, t.popularity, t.play_count, t.added_at
       ON CONFLICT (entity_type, entity_id)
       DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, keywords = EXCLUDED.keywords,
                     popularity = EXCLUDED.popularity, is_new = EXCLUDED.is_new, updated_at = now()`,
      [entityId],
    );
    return;
  }
  if (entityType === 'album') {
    await db.execute(
      `INSERT INTO search_documents (entity_type, entity_id, title, body, keywords, popularity, is_new, added_at, updated_at)
       SELECT 'album', al.id, al.title, ar.name, coalesce(string_agg(DISTINCT g.slug,' '),''),
              al.popularity, (al.release_date > now()::date - 30), al.added_at, now()
         FROM albums al JOIN artists ar ON ar.id = al.artist_id
         LEFT JOIN album_genres ag ON ag.album_id = al.id
         LEFT JOIN genres g ON g.id = ag.genre_id
        WHERE al.id = $1::uuid
        GROUP BY al.id, ar.name, al.popularity, al.release_date, al.added_at
       ON CONFLICT (entity_type, entity_id)
       DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, keywords = EXCLUDED.keywords,
                     popularity = EXCLUDED.popularity, is_new = EXCLUDED.is_new, updated_at = now()`,
      [entityId],
    );
    return;
  }
  if (entityType === 'artist') {
    await db.execute(
      `INSERT INTO search_documents (entity_type, entity_id, title, body, keywords, popularity, is_new, added_at, updated_at)
       SELECT 'artist', ar.id, ar.name, coalesce(left(ar.bio,200),''), '', ar.popularity, false, ar.created_at, now()
         FROM artists ar WHERE ar.id = $1::uuid
       ON CONFLICT (entity_type, entity_id)
       DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, popularity = EXCLUDED.popularity, updated_at = now()`,
      [entityId],
    );
    return;
  }
  if (entityType === 'playlist') {
    await db.execute(
      `INSERT INTO search_documents (entity_type, entity_id, title, body, keywords, popularity, is_new, added_at, updated_at)
       SELECT 'playlist', p.id, p.title, coalesce(p.description,''), 'playlist',
              p.follower_count::float8, false, p.created_at, now()
         FROM playlists p WHERE p.id = $1::uuid AND p.visibility <> 'private'
       ON CONFLICT (entity_type, entity_id)
       DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, popularity = EXCLUDED.popularity, updated_at = now()`,
      [entityId],
    );
    return;
  }
  await db.execute(
    `INSERT INTO search_documents (entity_type, entity_id, title, body, keywords, popularity, is_new, added_at, updated_at)
     SELECT 'genre', g.id, g.name, coalesce(g.description,''), g.slug, g.track_count::float8, false, g.created_at, now()
       FROM genres g WHERE g.slug = $1
     ON CONFLICT (entity_type, entity_id) DO UPDATE SET title = EXCLUDED.title, popularity = EXCLUDED.popularity`,
    [entityId],
  );
}

export async function removeSearchDocument(db: Db, entityType: string, entityId: string) {
  await db.execute(`DELETE FROM search_documents WHERE entity_type = $1 AND entity_id = $2::uuid`, [entityType, entityId]);
}

/* ------------------------------- sync runs ------------------------------- */

export async function startSyncRun(db: Db, input: { provider: string; triggeredBy: 'schedule' | 'manual' | 'cli' | 'api'; requestedBy?: string | null; cursorBefore?: string | null }) {
  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO sync_runs (id, provider, job, status, triggered_by, requested_by, cursor_before, started_at)
     VALUES (d7_uuid(), $1, 'release_sync', 'running', $2, $3, $4, now()) RETURNING id`,
    [input.provider, input.triggeredBy, input.requestedBy ?? null, input.cursorBefore ?? null],
  );
  await db.execute(
    `INSERT INTO sync_cursors (provider, job, cursor, last_run_id, last_run_at)
     VALUES ($1, 'release_sync', $2, $3::uuid, now())
     ON CONFLICT (provider, job) DO UPDATE SET last_run_id = EXCLUDED.last_run_id, last_run_at = now()`,
    [input.provider, input.cursorBefore ?? null, row?.id ?? null],
  );
  return row!.id;
}

export async function finishSyncRun(
  db: Db,
  runId: string,
  input: {
    provider: string;
    status: 'succeeded' | 'partial' | 'failed';
    counters: SyncCounters;
    errors: { stage: string; message: string; attempts?: number }[];
    cursorAfter?: string | null;
    rateLimitWaitMs?: number;
    attempts?: number;
    fetched: { artists: number; albums: number; tracks: number };
  },
) {
  const duration = await db.queryOne<{ ms: number }>(`SELECT (extract(epoch from now() - started_at) * 1000)::int AS ms FROM sync_runs WHERE id = $1::uuid`, [runId]);
  await db.execute(
    `UPDATE sync_runs SET status = $2, finished_at = now(), duration_ms = $3,
            fetched_artists = $4, fetched_albums = $5, fetched_tracks = $6,
            inserted_artists = $7, inserted_albums = $8, inserted_tracks = $9,
            updated_albums = $10, updated_tracks = $11, skipped_duplicates = $12,
            rejected_invalid = $13, errors = $14::jsonb, cursor_after = $15,
            rate_limit_wait_ms = $16, attempts = $17
      WHERE id = $1::uuid`,
    [
      runId,
      input.status,
      duration?.ms ?? 0,
      input.fetched.artists,
      input.fetched.albums,
      input.fetched.tracks,
      input.counters.insertedArtists,
      input.counters.insertedAlbums,
      input.counters.insertedTracks,
      input.counters.updatedAlbums,
      input.counters.updatedTracks,
      input.counters.skippedDuplicates,
      input.counters.rejectedInvalid,
      JSON.stringify(input.errors),
      input.cursorAfter ?? null,
      input.rateLimitWaitMs ?? 0,
      input.attempts ?? 1,
    ],
  );
  const failed = input.status === 'failed';
  await db.execute(
    `INSERT INTO sync_cursors (provider, job, cursor, consecutive_failures, next_run_at)
     VALUES ($1, 'release_sync', $2, $3, now() + make_interval(mins => $4::int))
     ON CONFLICT (provider, job) DO UPDATE SET
       cursor = coalesce(EXCLUDED.cursor, sync_cursors.cursor),
       consecutive_failures = $3,
       next_run_at = now() + make_interval(mins => $4::int),
       last_run_id = $5::uuid, last_run_at = now()`,
    [
      input.provider,
      input.cursorAfter ?? null,
      failed ? (await lastFailures(db, input.provider)) + 1 : 0,
      failed ? backoffMinutes(await lastFailures(db, input.provider) + 1) : 0,
      runId,
    ],
  );
  if (!(await providerRegistered(db, input.provider))) return;
  await db.execute(
    `INSERT INTO provider_health (provider, state, success_count, failure_count, consecutive_failures, last_check_at, last_error)
     VALUES ($1, $2, $3, $4, $5, now(), $6)
     ON CONFLICT (provider) DO UPDATE SET
       state = EXCLUDED.state,
       success_count = provider_health.success_count + EXCLUDED.success_count,
       failure_count = provider_health.failure_count + EXCLUDED.failure_count,
       consecutive_failures = EXCLUDED.consecutive_failures,
       last_check_at = now(),
       last_error = EXCLUDED.last_error`,
    [
      input.provider,
      input.status === 'failed' ? 'down' : input.errors.length ? 'degraded' : 'healthy',
      input.status === 'failed' ? 0 : 1,
      input.status === 'failed' ? 1 : 0,
      input.status === 'failed' ? (await lastFailures(db, input.provider)) + 1 : 0,
      input.errors[0]?.message ?? null,
    ],
  );
  await db.execute(`UPDATE music_providers SET last_success_at = CASE WHEN $2 THEN now() ELSE last_success_at END,
                                          last_error = $3 WHERE name = $1`, [
    input.provider,
    input.status !== 'failed',
    input.errors[0]?.message ?? null,
  ]);
}

async function lastFailures(db: Db, provider: string) {
  const row = await db.queryOne<{ c: number }>(`SELECT coalesce(consecutive_failures,0)::int AS c FROM sync_cursors WHERE provider = $1 AND job = 'release_sync'`, [provider]);
  return Number(row?.c ?? 0);
}

/** Exponential backoff capped at 6h so a broken provider cannot hot-loop the queue. */
export function backoffMinutes(failures: number) {
  const base = Math.min(6 * 60, 5 * 2 ** Math.max(0, Math.min(failures, 7)));
  return Math.round(base);
}

export async function listRecentRuns(db: Db, provider?: string, limit = 20) {
  const rows = await db.query<Record<string, any>>(
    `SELECT * FROM sync_runs ${provider ? 'WHERE provider = $1' : ''} ORDER BY started_at DESC LIMIT ${Math.min(limit, 50)}`,
    provider ? [provider] : [],
  );
  const { mapSyncRun } = await import('./map.js');
  return rows.map(mapSyncRun);
}

export async function getProviderCursor(db: Db, provider: string, job = 'release_sync') {
  return db.queryOne<{ cursor: string | null; next_run_at: string | null; consecutive_failures: number }>(
    `SELECT cursor, next_run_at, consecutive_failures FROM sync_cursors WHERE provider = $1 AND job = $2`,
    [provider, job],
  );
}

/** Queue row used when Redis/BullMQ is unavailable — claimable with SKIP LOCKED. */
export async function enqueueSyncJob(db: Db, input: { provider: string; kind: string; payload: Record<string, unknown>; runAfter?: string; maxAttempts?: number }) {
  const res = await db.execute(
    `INSERT INTO sync_jobs (provider, kind, payload, run_after, max_attempts)
     VALUES ($1, $2, $3::jsonb, coalesce($4::timestamptz, now()), $5)
     ON CONFLICT (provider, kind, payload) DO NOTHING`,
    [input.provider, input.kind, JSON.stringify(input.payload), input.runAfter ?? null, input.maxAttempts ?? 5],
  );
  return res;
}

export async function claimSyncJobs(db: Db, limit = 5) {
  return db.transaction(async (tx) => {
    const rows = await tx.query<{ id: number; provider: string; kind: string; payload: Record<string, unknown>; attempts: number }>(
      `UPDATE sync_jobs SET status = 'running', attempts = attempts + 1, updated_at = now()
        WHERE id IN (SELECT id FROM sync_jobs WHERE status IN ('queued','failed') AND run_after <= now()
                      ORDER BY run_after LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING id, provider, kind, payload, attempts`,
      [limit],
    );
    return rows;
  });
}

export async function completeSyncJob(db: Db, id: number, opts: { ok: boolean; error?: string; retryInSec?: number }) {
  if (opts.ok) {
    await db.execute(`UPDATE sync_jobs SET status = 'succeeded', updated_at = now() WHERE id = $1`, [id]);
    return;
  }
  await db.execute(
    `UPDATE sync_jobs SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'failed' END,
                          last_error = $2,
                          run_after = now() + make_interval(secs => $3::int),
                          updated_at = now()
      WHERE id = $1`,
    [id, opts.error?.slice(0, 500) ?? 'unknown error', opts.retryInSec ?? 120],
  );
}

export type { ProviderArtist };
