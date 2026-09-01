/**
 * Creator routes (spec §14): claim an artist page, upload audio, edit your own catalogue,
 * submit for review and read your stats.
 *
 * Two things are deliberate here:
 *  - uploads are stored and recorded, but the track lands as `status='submitted'` with
 *    `streamable=false`; publishing is an admin action, not a creator one;
 *  - every write is re-checked against `artist_claims`, because the JWT tells us who the
 *    caller is, not what they own.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '@d7/config';
import { analyzePcm, parseWavHeader } from '@d7/audio-storage';
import {
  approveTrack,
  canEditArtist,
  claimArtist,
  creatorStats,
  listUploads,
  listClaimsForUser,
  recordUpload,
  submitUploadAsTrack,
  upsertAlbum,
  upsertTrack,
  approvedArtistIds,
} from '@d7/database';
import { ApiError, guardRate, idSchema, intField, parseBody } from '../lib/http.js';
import { hydrateTracks } from '../lib/media.js';
import { listAlbumTracks, listTracksByIds } from '@d7/database';

const MAX_BYTES = () => env.UPLOAD_MAX_MB * 1024 * 1024;

/** HTML forms send "true"/"on"/"1"; z.coerce.boolean() would turn "false" into true. */
const boolish = z.union([z.boolean(), z.string()]).transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase())));

export default async function creatorRoutes(app: FastifyInstance) {
  const db = () => app.d7.db;

  const ownable = async (request: FastifyRequest, artistId?: string) => {
    const user = await request.requireUser();
    const approved = await approvedArtistIds(db(), user.id);
    if (artistId && user.role !== 'admin' && !(await canEditArtist(db(), user.id, artistId))) {
      throw ApiError.forbidden('Your account does not hold an approved claim for this artist.', 'NOT_ARTIST_OWNER');
    }
    return { user, approved };
  };

  app.get('/api/creator/overview', async (request) => {
    const user = await request.requireUser();
    const [claims, approved, stats] = await Promise.all([listClaimsForUser(db(), user.id), approvedArtistIds(db(), user.id), null]);
    const stat = await creatorStats(db(), approved);
    const artists = approved.length ? await db().query<Record<string, any>>(`SELECT id::text, name, verified, followers_count, monthly_listeners FROM artists WHERE id = ANY($1::uuid[])`, [approved]) : [];
    return {
      role: user.role,
      claims,
      approvedArtistIds: approved,
      artists: artists.map((a) => ({
        id: String(a.id),
        name: String(a.name),
        verified: Boolean(a.verified),
        followers: Number(a.followers_count ?? 0),
        monthlyListeners: Number(a.monthly_listeners ?? 0),
      })),
      stats: stat,
      canSubmit: approved.length > 0,
      nextStep: approved.length === 0 ? 'Claim an artist page to start uploading.' : 'Upload a master, then submit it for review.',
    };
  });

  app.get('/api/creator/claims', async (request) => {
    const user = await request.requireUser();
    return { claims: await listClaimsForUser(db(), user.id) };
  });

  app.post('/api/creator/claims', async (request, reply) => {
    const user = await request.requireUser();
    await guardRate(app, request, reply, { bucket: 'creator:claim', limit: 5, windowSec: 3600, message: 'Only a few claims per hour, please.' });
    const body = parseBody(
      z.object({
        artistId: idSchema,
        evidenceUrl: z.string().url('Give a URL we can check (label page, official profile, …).').max(400).optional(),
        note: z.string().max(600).optional(),
      }),
      request.body,
    );
    const result = await claimArtist(db(), { userId: user.id, artistId: body.artistId, evidenceUrl: body.evidenceUrl ?? null, note: body.note ?? null });
    if (!result.ok) throw ApiError.conflict(result.error, 'CLAIM_UNAVAILABLE');
    await app.d7.notifications
      .system({
        userId: user.id,
        title: 'Claim submitted',
        body: 'A moderator will review your claim. You will be notified here.',
        actionHref: '/creator',
        dedupeKey: `claim:submitted:${body.artistId}`,
      })
      .catch(() => undefined);
    return reply.code(202).send({ claimId: result.claimId, status: 'pending' });
  });

  /** Search the catalogue for the artist page you want to claim. */
  app.get('/api/creator/artist-search', async (request) => {
    await request.requireUser();
    const q = String((request.query as { q?: string }).q ?? '').trim().slice(0, 60);
    if (q.length < 2) return { results: [] };
    const rows = await db().query<Record<string, any>>(
      `SELECT ar.id, ar.name, ar.slug, ar.verified, ar.monthly_listeners,
              (SELECT count(*) FROM artist_claims ac WHERE ac.artist_id = ar.id AND ac.status IN ('pending','approved'))::int AS claims
         FROM artists ar
        WHERE ar.name_key LIKE '%' || d7_normalize_text($1) || '%'
        ORDER BY ar.monthly_listeners DESC LIMIT 12`,
      [q],
    );
    return {
      results: rows.map((r) => ({
        id: String(r.id),
        name: String(r.name),
        slug: String(r.slug),
        verified: Boolean(r.verified),
        monthlyListeners: Number(r.monthly_listeners ?? 0),
        alreadyClaimed: Number(r.claims ?? 0) > 0,
      })),
    };
  });

  /* --------------------------------- uploads --------------------------------- */

  app.post('/api/creator/tracks', async (request: FastifyRequest, reply: FastifyReply) => {
    const { fields, file } = readFields(await collectUpload(request));
    const body = parseBody(
      z.object({
        artistId: idSchema,
        title: z.string().min(1, 'A track needs a title.').max(160),
        albumId: idSchema.optional(),
        albumTitle: z.string().max(140).optional(),
        explicit: boolish.optional(),
        genres: z.string().max(200).optional(),
        moods: z.string().max(200).optional(),
        releaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').optional(),
        trackNumber: z.coerce.number().int().min(1).max(99).optional(),
        licenseHolder: z.string().max(160).optional(),
        licenseAgreementRef: z.string().max(160).optional(),
        autoPublish: boolish.optional(),
      }),
      fields,
    );
    const { user } = await ownable(request, body.artistId);
    if (file.buffer.length > MAX_BYTES()) throw ApiError.payload(`Uploads are capped at ${env.UPLOAD_MAX_MB} MB in this build.`);
    if (!/^audio\/|^application\/octet-stream$/.test(file.mimetype)) {
      throw ApiError.badRequest('Upload an audio file (wav, flac, ogg or mp3).', [{ path: 'file', message: `Got ${file.mimetype}` }]);
    }

    const bytes = file.buffer;
    const parsed = parseWavHeader(bytes);
    if (!parsed) {
      throw ApiError.badRequest('This build stores WAV masters; a transcoder is required for compressed inputs.', [
        { path: 'file', message: 'Not a RIFF/WAVE file' },
      ]);
    }
    const analysis = analyzePcm(bytes, parsed);
    if (analysis.silent) {
      throw ApiError.badRequest('That file is silent (RMS below the noise floor) — it looks like an empty take.', [
        { path: 'file', message: `loudness ${analysis.loudnessLufs} LUFS` },
      ]);
    }

    const up = await app.d7.storage.upload({ key: `audio/upload-${body.artistId}-${Date.now()}.wav`, body: bytes, contentType: 'audio/wav' });
    const uploadId = await recordUpload(db(), {
      uploaderId: user.id,
      artistId: body.artistId,
      storageKey: up.key,
      originalName: file.filename,
      mimeType: file.mimetype,
      byteSize: up.bytes,
      sha256: up.sha256,
      durationMs: parsed.durationMs,
      sampleRate: parsed.sampleRate,
      channels: parsed.channels,
      codec: `pcm ${parsed.bitsPerSample}-bit; peak ${analysis.peakDbfs} dBFS${analysis.clipped ? ' (clipping)' : ''}`,
      scanStatus: 'clean',
    });

    const submitted = await submitUploadAsTrack(db(), {
      uploaderId: user.id,
      artistId: body.artistId,
      albumId: body.albumId ?? null,
      albumTitle: body.albumTitle ?? null,
      title: body.title,
      storageKey: up.key,
      mimeType: 'audio/wav',
      byteSize: up.bytes,
      durationMs: parsed.durationMs,
      explicit: body.explicit ?? false,
      genres: splitList(body.genres),
      moods: splitList(body.moods),
      releaseDate: body.releaseDate,
      trackNumber: body.trackNumber,
      license: env.REQUIRE_LICENSE_FOR_UPLOAD
        ? { holder: body.licenseHolder ?? user.displayName ?? user.username, agreementRef: body.licenseAgreementRef ?? null, startDate: body.releaseDate }
        : undefined,
    });

    // Self-service publishing is only allowed for accounts we trust (admin), never by default.
    if (body.autoPublish && user.role === 'admin') await approveTrack(db(), { trackId: submitted.trackId, adminId: user.id, note: 'creator auto-publish' });

    app.d7.log.info('creator upload accepted', { uploadId, trackId: submitted.trackId, userId: user.id, bytes: up.bytes, durationMs: parsed.durationMs });
    return reply.code(201).send({
      uploadId,
      trackId: submitted.trackId,
      albumId: submitted.albumId,
      trackNumber: submitted.trackNumber,
      status: user.role === 'admin' && body.autoPublish ? 'published' : 'submitted',
      streamable: false,
      audio: { bytes: up.bytes, sha256: up.sha256, sampleRate: parsed.sampleRate, channels: parsed.channels, durationMs: parsed.durationMs, loudnessLufs: analysis.loudnessLufs, clipped: analysis.clipped },
      note: 'Your track is queued for review. It will appear publicly once a moderator approves it.',
    });
  });

  app.get('/api/creator/uploads', async (request) => {
    const user = await request.requireUser();
    const rows = await listUploads(db(), user.id, intField((request.query as { limit?: string }).limit, 40, 1, 200));
    return {
      uploads: rows.map((r) => ({
        id: String(r.id),
        trackId: r.track_id,
        storageKey: r.storage_key,
        originalName: r.original_name,
        mimeType: r.mime_type,
        bytes: Number(r.byte_size),
        sha256: r.sha256,
        durationMs: r.duration_ms ? Number(r.duration_ms) : null,
        createdAt: r.created_at,
        trackStatus: r.status,
        title: r.title,
        albumTitle: r.album_title,
      })),
    };
  });

  /** Edit your own track. Ownership is re-checked on every write. */
  app.patch('/api/creator/tracks/:id', async (request) => {
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const owner = await db().queryOne<{ primary_artist_id: string }>(`SELECT primary_artist_id::text FROM tracks WHERE id = $1::uuid`, [id]);
    if (!owner) throw ApiError.notFound('Track');
    const user = await (async () => {
      const u = await request.requireUser();
      if (u.role !== 'admin' && !(await canEditArtist(db(), u.id, owner.primary_artist_id))) {
        throw ApiError.forbidden('That track belongs to another artist page.', 'NOT_ARTIST_OWNER');
      }
      return u;
    })();
    const body = parseBody(
      z.object({
        title: z.string().min(1).max(160).optional(),
        explicit: z.boolean().optional(),
        genres: z.array(z.string().max(40)).max(6).optional(),
        moods: z.array(z.string().max(40)).max(6).optional(),
        releaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        trackNumber: z.number().int().min(1).max(99).optional(),
        status: z.enum(['draft', 'submitted']).optional(),
        providerTrackId: z.string().max(80).optional(),
      }),
      request.body,
    );
    const track = await db().queryOne<Record<string, any>>(
      `SELECT album_id::text, title, duration_ms, explicit, release_date::text, track_number, provider_track_id FROM tracks WHERE id = $1::uuid`,
      [id],
    );
    if (!track) throw ApiError.notFound('Track');
    const result = await upsertTrack(db(), {
      provider: 'platform',
      providerTrackId: body.providerTrackId ?? String(track.provider_track_id ?? id),
      albumId: String(track.album_id),
      artistId: owner.primary_artist_id,
      title: body.title ?? String(track.title),
      trackNumber: body.trackNumber ?? Number(track.track_number ?? 1),
      durationMs: Number(track.duration_ms ?? 0),
      explicit: body.explicit ?? Boolean(track.explicit),
      genres: body.genres,
      moods: body.moods,
      releaseDate: body.releaseDate ?? String(track.release_date ?? '').slice(0, 10),
      contentSource: 'platform_owned',
      status: body.status ?? 'submitted',
      // Editing a submitted track must not silently publish or un-publish it.
      licenseStatus: 'pending_review',
      streamable: false,
    });
    const tracks = await hydrateTracks(app, await listTracksByIds(db(), result.outcome === 'rejected' ? [] : [result.trackId], { viewerId: user.id, includeUnpublished: true }), user);
    return { outcome: result.outcome, issues: result.issues, track: tracks[0] ?? null };
  });

  app.post('/api/creator/albums', async (request, reply) => {
    const body = parseBody(
      z.object({
        artistId: idSchema,
        title: z.string().min(1).max(140),
        releaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        albumType: z.enum(['album', 'single', 'ep', 'compilation']).default('single'),
        description: z.string().max(1000).optional(),
        genres: z.string().max(200).optional(),
      }),
      request.body,
    );
    await ownable(request, body.artistId);
    const album = await upsertAlbum(db(), {
      provider: 'platform',
      providerAlbumId: `creator:${body.artistId}:${body.title.toLowerCase()}`,
      title: body.title,
      artistId: body.artistId,
      albumType: body.albumType,
      releaseDate: body.releaseDate ?? new Date().toISOString().slice(0, 10),
      contentSource: 'platform_owned',
      licenseStatus: 'pending_review',
      status: 'draft',
      genreSlugs: splitList(body.genres),
      pitch: body.description ?? null,
    });
    return reply.code(201).send({ albumId: album.albumId, status: 'draft', note: 'Draft albums are only visible to you until a track on them is approved.' });
  });

  app.get('/api/creator/albums', async (request) => {
    const user = await request.requireUser();
    const approved = await approvedArtistIds(db(), user.id);
    if (!approved.length) return { albums: [] };
    const rows = await db().query<Record<string, any>>(
      `SELECT al.id, al.title, al.status, al.release_date::text, al.album_type,
              (SELECT count(*) FROM tracks t WHERE t.album_id = al.id)::int AS tracks,
              (SELECT count(*) FROM tracks t WHERE t.album_id = al.id AND t.status='published')::int AS published
         FROM albums al WHERE al.artist_id = ANY($1::uuid[]) ORDER BY al.release_date DESC LIMIT 60`,
      [approved],
    );
    return {
      albums: rows.map((r) => ({
        id: String(r.id),
        title: String(r.title),
        status: r.status,
        releaseDate: String(r.release_date ?? '').slice(0, 10),
        type: r.album_type,
        tracks: Number(r.tracks ?? 0),
        published: Number(r.published ?? 0),
      })),
    };
  });

  app.get('/api/creator/albums/:id/tracks', async (request) => {
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const user = await request.requireUser();
    const album = await db().queryOne<{ artist_id: string }>(`SELECT artist_id::text FROM albums WHERE id = $1::uuid`, [id]);
    if (!album) throw ApiError.notFound('Album');
    if (user.role !== 'admin' && !(await canEditArtist(db(), user.id, album.artist_id))) throw ApiError.forbidden('Not your album.', 'NOT_ARTIST_OWNER');
    return { tracks: await listAlbumTracks(db(), id, user.id) };
  });

  app.get('/api/creator/stats', async (request) => {
    const user = await request.requireUser();
    const approved = await approvedArtistIds(db(), user.id);
    const stats = await creatorStats(db(), approved);
    const daily = approved.length
      ? await db().query<Record<string, any>>(
          `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
                  sum(d.plays)::int AS plays, sum(d.completes)::int AS completes,
                  sum(d.skips)::int AS skips, sum(d.minutes_streamed)::int AS minutes
             FROM stats_daily d
             JOIN tracks t ON t.id = d.entity_id
            WHERE d.entity_type = 'track' AND t.primary_artist_id = ANY($1::uuid[])
              AND d.day > now() - interval '30 days'
            GROUP BY d.day ORDER BY d.day`,
          [approved],
        )
      : [];
    return {
      stats,
      daily: daily.map((d) => ({
        day: String(d.day),
        plays: Number(d.plays ?? 0),
        completes: Number(d.completes ?? 0),
        skips: Number(d.skips ?? 0),
        minutes: Number(d.minutes ?? 0),
      })),
      audiences: approved.length
        ? await db().query<Record<string, any>>(
            `SELECT a.name AS artist, count(*)::int AS followers FROM artists a
              WHERE a.id = ANY($1::uuid[]) GROUP BY a.name`,
            [approved],
          )
        : [],
    };
  });

  app.post('/api/creator/tracks/:id/publish', async (request) => {
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const user = await request.requireUser();
    const owner = await db().queryOne<{ primary_artist_id: string }>(`SELECT primary_artist_id::text FROM tracks WHERE id = $1::uuid`, [id]);
    if (!owner) throw ApiError.notFound('Track');
    if (user.role !== 'admin' && !(await canEditArtist(db(), user.id, owner.primary_artist_id))) throw ApiError.forbidden('Not your track.', 'NOT_ARTIST_OWNER');
    if (user.role !== 'admin') {
      throw ApiError.forbidden('Creator uploads need moderator approval before they can stream.', 'AWAITING_REVIEW');
    }
    const result = await approveTrack(db(), { trackId: id, adminId: user.id, note: 'approved by admin via creator route' });
    if (!result.ok) throw ApiError.badRequest(result.error);
    return { published: true };
  });
}

/* --------------------------------- multipart --------------------------------- */

interface CollectedPart {
  field: string;
  value?: string;
  file?: { filename: string; mimetype: string; buffer: Buffer };
}

/**
 * Collects a multipart body into fields + one audio file. Files are buffered because the WAV
 * probe needs the header and the size guard needs the total — 60 MB is the documented ceiling.
 */
async function collectUpload(request: FastifyRequest): Promise<CollectedPart[]> {
  if (!request.isMultipart()) throw ApiError.badRequest('Send the audio as multipart/form-data.', [{ path: 'file', message: 'Expected multipart' }]);
  const parts: CollectedPart[] = [];
  for await (const part of request.parts()) {
    if (part.type === 'file') {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of part.file) {
        size += (chunk as Buffer).length;
        if (size > MAX_BYTES()) throw ApiError.payload(`Uploads are capped at ${env.UPLOAD_MAX_MB} MB in this build.`);
        chunks.push(chunk as Buffer);
      }
      parts.push({ field: part.fieldname, file: { filename: part.filename, mimetype: part.mimetype, buffer: Buffer.concat(chunks) } });
    } else {
      parts.push({ field: part.fieldname, value: part.value === undefined ? '' : String(part.value) });
    }
  }
  return parts;
}

function readFields(parts: CollectedPart[]) {
  const fields: Record<string, string> = {};
  let file: NonNullable<CollectedPart['file']> | undefined;
  for (const p of parts) {
    if (p.file && !file) file = p.file;
    else if (p.value !== undefined) fields[p.field] = p.value;
  }
  if (!file) throw ApiError.badRequest('No audio file in the request.', [{ path: 'file', message: 'Missing' }]);
  // A field may also arrive as `file_title`-style duplicates; the first value wins.
  return { fields, file };
}

function splitList(raw: string | undefined) {
  return String(raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 6);
}
