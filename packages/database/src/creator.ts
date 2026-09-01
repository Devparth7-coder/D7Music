/**
 * Creator workflows: claiming an artist page, uploading audio, submitting for review,
 * and the small amount of catalogue writing an approved creator is allowed to do.
 *
 * Nothing here bypasses moderation: an upload lands as `status='submitted'` with
 * `streamable=false` until an admin approves it, which is the whole point of the
 * `licenses` + `artist_claims` tables rather than a boolean on the user row.
 */
import type { Db } from './client.js';
import { upsertAlbum, upsertTrack, registerNewRelease } from './sync.js';
import { randomUUID } from 'node:crypto';

export interface ClaimRow {
  id: string;
  artist_id: string;
  artist_name: string;
  status: 'pending' | 'approved' | 'denied';
  evidence_url: string | null;
  note: string | null;
  created_at: string;
  resolved_at: string | null;
}

export async function claimArtist(db: Db, input: { userId: string; artistId: string; evidenceUrl?: string | null; note?: string | null }): Promise<{ ok: true; claimId: string } | { ok: false; error: string }> {
  const artist = await db.queryOne<{ id: string; verified: boolean }>(`SELECT id, verified FROM artists WHERE id = $1::uuid`, [input.artistId]);
  if (!artist) return { ok: false, error: 'That artist page does not exist.' };
  const taken = await db.queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM artist_claims WHERE artist_id = $1::uuid AND status = 'approved'`, [input.artistId]);
  if (Number(taken?.c ?? 0) > 0) return { ok: false, error: 'Another account already holds an approved claim for this artist.' };
  const existing = await db.queryOne<{ id: string; status: string }>(`SELECT id, status FROM artist_claims WHERE user_id = $1::uuid AND artist_id = $2::uuid`, [input.userId, input.artistId]);
  if (existing) {
    if (existing.status === 'approved') return { ok: false, error: 'Your claim for this artist is already approved.' };
    await db.execute(
      `UPDATE artist_claims SET status = 'pending', evidence_url = $3, note = $4, resolved_at = NULL, resolved_by = NULL WHERE id = $1::uuid`,
      [existing.id, input.evidenceUrl ?? null, input.note ?? null],
    );
    return { ok: true, claimId: existing.id };
  }
  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO artist_claims (id, user_id, artist_id, status, evidence_url, note, created_at)
     VALUES (d7_uuid(), $1::uuid, $2::uuid, 'pending', $3, $4, now()) RETURNING id`,
    [input.userId, input.artistId, input.evidenceUrl ?? null, input.note ?? null],
  );
  return { ok: true, claimId: String(row!.id) };
}

export async function listClaimsForUser(db: Db, userId: string): Promise<ClaimRow[]> {
  return db.query<ClaimRow>(
    `SELECT ac.id::text, ac.artist_id::text, ar.name AS artist_name, ac.status, ac.evidence_url, ac.note,
            ac.created_at::text, ac.resolved_at::text
       FROM artist_claims ac JOIN artists ar ON ar.id = ac.artist_id
      WHERE ac.user_id = $1::uuid ORDER BY ac.created_at DESC`,
    [userId],
  );
}

export async function listPendingClaims(db: Db, limit = 50) {
  const rows = await db.query<Record<string, any>>(
    `SELECT ac.id::text AS claim_id, ac.status, ac.evidence_url, ac.note, ac.created_at::text,
            u.username, u.email, ar.id::text AS artist_id, ar.name AS artist_name, ar.verified,
            (SELECT count(*) FROM tracks t WHERE t.primary_artist_id = ar.id)::int AS track_count
       FROM artist_claims ac
       JOIN users u ON u.id = ac.user_id
       JOIN artists ar ON ar.id = ac.artist_id
      WHERE ac.status = 'pending' ORDER BY ac.created_at ASC LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function resolveClaim(db: Db, input: { claimId: string; adminId: string; approve: boolean; note?: string | null }) {
  const claim = await db.queryOne<{ artist_id: string; user_id: string }>(`SELECT artist_id::text, user_id::text FROM artist_claims WHERE id = $1::uuid`, [input.claimId]);
  if (!claim) return { ok: false as const, error: 'Claim not found.' };
  await db.transaction(async (tx) => {
    await tx.execute(`UPDATE artist_claims SET status = $2, resolved_at = now(), resolved_by = $3::uuid, note = coalesce($4, note) WHERE id = $1::uuid`, [
      input.claimId,
      input.approve ? 'approved' : 'denied',
      input.adminId,
      input.note ?? null,
    ]);
    if (input.approve) {
      // The badge records *how* it was earned, so the UI can say "claimed by artist".
      await tx.execute(
        `UPDATE artists SET verified = true, verified_kind = 'creator_claim', verified_at = now(), verified_by = $2::uuid, updated_at = now() WHERE id = $1::uuid`,
        [claim.artist_id, input.adminId],
      );
      await tx.execute(`UPDATE users SET role = 'artist' WHERE id = $1::uuid AND role = 'listener'`, [claim.user_id]);
    }
  });
  return { ok: true as const, artistId: claim.artist_id };
}

export async function approvedArtistIds(db: Db, userId: string): Promise<string[]> {
  const rows = await db.query<{ artist_id: string }>(`SELECT artist_id::text FROM artist_claims WHERE user_id = $1::uuid AND status = 'approved'`, [userId]);
  return rows.map((r) => String(r.artist_id));
}

export async function canEditArtist(db: Db, userId: string, artistId: string): Promise<boolean> {
  const row = await db.queryOne<{ c: number }>(
    `SELECT (EXISTS (SELECT 1 FROM artist_claims WHERE user_id = $1::uuid AND artist_id = $2::uuid AND status = 'approved')
            OR EXISTS (SELECT 1 FROM users WHERE id = $1::uuid AND role = 'admin'))::int AS c`,
    [userId, artistId],
  );
  return Number(row?.c ?? 0) > 0;
}

/* --------------------------------- uploads --------------------------------- */

export interface UploadRecord {
  id: string;
  track_id: string | null;
  storage_key: string;
  original_name: string | null;
  mime_type: string;
  byte_size: string | number;
  sha256: string;
  duration_ms: number | null;
  created_at: string;
  status: string | null;
  title: string | null;
  album_title: string | null;
}

export async function recordUpload(
  db: Db,
  input: {
    uploaderId: string;
    artistId?: string | null;
    storageKey: string;
    originalName: string | null;
    mimeType: string;
    byteSize: number;
    sha256: string;
    durationMs?: number | null;
    sampleRate?: number | null;
    channels?: number | null;
    codec?: string | null;
    scanStatus?: 'pending' | 'clean' | 'infected' | 'error';
  },
) {
  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO uploaded_audio (id, uploader_id, artist_id, storage_key, original_name, mime_type, byte_size, sha256, duration_ms, sample_rate, channels, codec, scan_status, created_at)
     VALUES (d7_uuid(), $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
     RETURNING id`,
    [
      input.uploaderId,
      input.artistId ?? null,
      input.storageKey,
      input.originalName,
      input.mimeType,
      input.byteSize,
      input.sha256,
      input.durationMs ?? null,
      input.sampleRate ?? null,
      input.channels ?? null,
      input.codec ?? null,
      input.scanStatus ?? 'pending',
    ],
  );
  return String(row!.id);
}

export async function attachUploadToTrack(db: Db, storageKey: string, trackId: string, albumId: string) {
  await db.execute(
    `UPDATE uploaded_audio SET track_id = $2::uuid, album_id = $3::uuid WHERE storage_key = $1`,
    [storageKey, trackId, albumId],
  );
}

export async function listUploads(db: Db, uploaderId: string, limit = 40): Promise<UploadRecord[]> {
  return db.query<UploadRecord>(
    `SELECT ua.id::text, ua.track_id::text, ua.storage_key, ua.original_name, ua.mime_type, ua.byte_size, ua.sha256,
            ua.duration_ms, ua.created_at::text, t.status, t.title, al.title AS album_title
       FROM uploaded_audio ua
       LEFT JOIN tracks t ON t.id = ua.track_id
       LEFT JOIN albums al ON al.id = ua.album_id
      WHERE ua.uploader_id = $1::uuid
      ORDER BY ua.created_at DESC LIMIT $2`,
    [uploaderId, limit],
  );
}

export async function markUploadScanned(db: Db, id: string, status: 'clean' | 'infected' | 'error', note?: string) {
  await db.execute(`UPDATE uploaded_audio SET scan_status = $2, codec = coalesce($3, codec) WHERE id = $1::uuid`, [id, status, note ?? null]);
}

/**
 * Creates or updates the draft release an upload belongs to, then the track row pointing at
 * the stored object. Deliberately `status='submitted'` + `streamable=false`: approval is the
 * admin's job (see `approveTrack`).
 */
export async function submitUploadAsTrack(
  db: Db,
  input: {
    uploaderId: string;
    artistId: string;
    albumId?: string | null;
    albumTitle?: string | null;
    title: string;
    storageKey: string;
    mimeType: string;
    byteSize: number;
    durationMs: number;
    explicit?: boolean;
    genres?: string[];
    moods?: string[];
    releaseDate?: string;
    trackNumber?: number;
    license?: { holder: string; agreementRef?: string | null; territory?: string; startDate?: string; endDate?: string | null; evidenceUrl?: string | null };
  },
) {
  const artist = await db.queryOne<{ id: string; name: string }>(`SELECT id, name FROM artists WHERE id = $1::uuid`, [input.artistId]);
  if (!artist) throw new Error('artist not found');
  const releaseDate = input.releaseDate ?? new Date().toISOString().slice(0, 10);
  const albumTitle = (input.albumTitle ?? input.title).trim().slice(0, 140);
  const providerTrackId = randomUUID();

  let albumId = input.albumId ?? null;
  if (!albumId) {
    const album = await upsertAlbum(
      db,
      {
        provider: 'platform',
        providerAlbumId: `upload:${albumTitle.toLowerCase()}`,
        title: albumTitle,
        artistId: artist.id,
        albumType: 'single',
        releaseDate,
        contentSource: 'platform_owned',
        licenseStatus: 'pending_review',
        status: 'draft',
        genreSlugs: input.genres ?? [],
        pitch: 'Uploaded by a creator; waiting for review.',
      },
    );
    albumId = album.albumId;
  }

  const track = await upsertTrack(db, {
    provider: 'platform',
    providerTrackId,
    providerAlbumId: `upload:${albumTitle.toLowerCase()}`,
    albumId,
    artistId: artist.id,
    title: input.title.trim().slice(0, 160),
    trackNumber: input.trackNumber ?? 1,
    durationMs: Math.max(1000, Math.round(input.durationMs)),
    explicit: input.explicit ?? false,
    releaseDate,
    genres: input.genres ?? [],
    moods: input.moods ?? [],
    contentSource: 'platform_owned',
    licenseStatus: 'pending_review',
    streamable: false,
    storageKey: input.storageKey,
    mimeType: input.mimeType,
    byteSize: input.byteSize,
    status: 'submitted',
  });

  if (track.outcome === 'rejected') {
    throw new Error(`Track failed validation: ${track.issues.map((i) => `${i.field}: ${i.message}`).join('; ') || 'see provider validation'}`);
  }
  const trackId = track.trackId;
  await attachUploadToTrack(db, input.storageKey, trackId, albumId);
  if (input.license) {
    await db.execute(
      `INSERT INTO licenses (id, entity_type, entity_id, holder, agreement_ref, territory, rights, start_date, end_date, status, evidence_url, recorded_by, created_at, updated_at)
       VALUES (d7_uuid(), 'track', $1::uuid, $2, $3, $4, ARRAY['stream','download'], $5::date, $6::date, 'pending_review', $7, $8::uuid, now(), now())`,
      [trackId, input.license.holder, input.license.agreementRef ?? null, input.license.territory ?? 'worldwide', input.license.startDate ?? releaseDate, input.license.endDate ?? null, input.license.evidenceUrl ?? null, input.uploaderId],
    );
  }
  const saved = await db.queryOne<{ track_number: number }>(`SELECT track_number FROM tracks WHERE id = $1::uuid`, [trackId]);
  return { trackId, albumId, trackNumber: Number(saved?.track_number ?? input.trackNumber ?? 1), outcome: track.outcome };
}

export async function approveTrack(db: Db, input: { trackId: string; adminId: string; note?: string | null }) {
  const track = await db.queryOne<{ album_id: string; storage_key: string | null }>(`SELECT album_id::text, storage_key FROM tracks WHERE id = $1::uuid`, [input.trackId]);
  if (!track) return { ok: false as const, error: 'Track not found.' };
  if (!track.storage_key) return { ok: false as const, error: 'This track has no audio object; nothing to publish.' };
  await db.execute(`UPDATE tracks SET status = 'published', license_status = 'licensed', streamable = true, updated_at = now() WHERE id = $1::uuid`, [input.trackId]);
  await db.execute(
    `UPDATE albums SET status = CASE WHEN (SELECT count(*) FROM tracks WHERE album_id = albums.id AND status = 'published') > 0 THEN 'published' ELSE status END,
                       license_status = 'licensed', updated_at = now() WHERE id = $1::uuid`,
    [track.album_id],
  );
  await db.execute(
    `UPDATE licenses SET status = 'licensed', notes = coalesce($2, notes), updated_at = now() WHERE entity_type = 'track' AND entity_id = $1::uuid`,
    [input.trackId, input.note ?? null],
  );
  const release = await db.queryOne<{ release_date: string; primary_artist_id: string; title: string }>(
    `SELECT to_char(release_date,'YYYY-MM-DD') AS release_date, primary_artist_id::text, title FROM tracks WHERE id = $1::uuid`,
    [input.trackId],
  );
  if (release) {
    await registerNewRelease(db, { entityType: 'track', entityId: input.trackId, artistId: release.primary_artist_id, provider: 'platform', releaseDate: release.release_date });
  }
  const { touchSearchDocument } = await import('./sync.js');
  await touchSearchDocument(db, 'track', input.trackId);
  await touchSearchDocument(db, 'album', track.album_id);
  return { ok: true as const };
}

export async function rejectTrack(db: Db, input: { trackId: string; adminId: string; note: string }) {
  await db.execute(`UPDATE tracks SET status = 'rejected', streamable = false, license_status = 'rejected', updated_at = now() WHERE id = $1::uuid`, [input.trackId]);
  // The creator sees the reason on their own upload row; `content_reports` is reserved for
  // third-party flags (its CHECK only allows copyright/offensive/spam-style reasons).
  await db.execute(`UPDATE uploaded_audio SET review_note = $2, updated_at = now() WHERE track_id = $1::uuid`, [input.trackId, input.note]);
  return { ok: true };
}

/** Creator dashboard: counts + the last few plays per track. */
export async function creatorStats(db: Db, artistIds: string[]) {
  if (!artistIds.length) return { artists: 0, tracks: 0, published: 0, pending: 0, plays: 0, saves: 0, topTracks: [] as { id: string; title: string; plays: number; saves: number }[] };
  const head = await db.queryOne<Record<string, any>>(
    `SELECT count(*)::int AS tracks,
            count(*) FILTER (WHERE t.status = 'published')::int AS published,
            count(*) FILTER (WHERE t.status IN ('submitted','draft','pending_review'))::int AS pending,
            coalesce(sum(t.play_count),0)::bigint AS plays,
            coalesce(sum((SELECT count(*) FROM liked_tracks lt WHERE lt.track_id = t.id)),0)::bigint AS saves
       FROM tracks t WHERE t.primary_artist_id = ANY($1::uuid[])`,
    [artistIds],
  );
  const top = await db.query<Record<string, any>>(
    `SELECT t.id::text, t.title, t.play_count AS plays,
            (SELECT count(*) FROM liked_tracks lt WHERE lt.track_id = t.id)::int AS saves
       FROM tracks t WHERE t.primary_artist_id = ANY($1::uuid[])
      ORDER BY t.play_count DESC, t.title LIMIT 10`,
    [artistIds],
  );
  return {
    artists: artistIds.length,
    tracks: Number(head?.tracks ?? 0),
    published: Number(head?.published ?? 0),
    pending: Number(head?.pending ?? 0),
    plays: Number(head?.plays ?? 0),
    saves: Number(head?.saves ?? 0),
    topTracks: top.map((r) => ({ id: String(r.id), title: String(r.title), plays: Number(r.plays ?? 0), saves: Number(r.saves ?? 0) })),
  };
}
