/**
 * Playlist persistence, including collaborative editing + reordering.
 *
 * Visibility rules are enforced here (not in the routes) so every entry point —
 * REST, admin, the AI assistant — behaves identically.
 */
import type { Db } from './client.js';
import { Sql } from './sql.js';
import { mapPlaylist } from './map.js';
import { listTracksByIds } from './catalog.js';
import { touchSearchDocument, removeSearchDocument } from './sync.js';
import type { Playlist, PlaylistDetail } from '@d7/types';

function playlistCols(viewerToken: string) {
  return `
  p.id, p.title, p.description, p.image_url, p.visibility, p.collaborative, p.is_editorial,
  p.follower_count, p.like_count, p.created_at, p.updated_at, p.owner_id, p.generated_by,
  u.username AS owner_username, u.display_name AS owner_display_name,
  (SELECT count(*) FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
    WHERE pt.playlist_id = p.id)::int AS track_count,
  coalesce((SELECT sum(t.duration_ms) FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
             WHERE pt.playlist_id = p.id), 0)::int AS duration_ms,
  EXISTS (SELECT 1 FROM playlist_followers pf WHERE pf.playlist_id = p.id AND pf.user_id = ${viewerToken}::uuid) AS liked_by_me`;
}

export async function canEditPlaylist(db: Db, playlistId: string, userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const row = await db.queryOne<{ can: boolean }>(
    `SELECT (
       EXISTS (SELECT 1 FROM playlists p WHERE p.id = $2::uuid AND p.owner_id = $1::uuid)
       OR EXISTS (SELECT 1 FROM playlists p WHERE p.id = $2::uuid AND p.collaborative AND EXISTS (
             SELECT 1 FROM playlist_collaborators c WHERE c.playlist_id = p.id AND c.user_id = $1::uuid
               AND c.status = 'accepted' AND c.permission IN ('edit','manage')))
       OR EXISTS (SELECT 1 FROM users uu WHERE uu.id = $1::uuid AND uu.role = 'admin')
     ) AS can`,
    [userId, playlistId],
  );
  return Boolean(row?.can);
}

export async function getPlaylist(db: Db, id: string, viewerId?: string | null): Promise<Playlist | undefined> {
  const q = new Sql();
  const viewer = q.bind(viewerId ?? null);
  const pid = q.bind(id);
  const row = await db.queryOne<Record<string, any>>(
    `SELECT ${playlistCols(viewer)}
       FROM playlists p LEFT JOIN users u ON u.id = p.owner_id
      WHERE p.id = ${pid}::uuid`,
    q.values,
  );
  if (!row) return undefined;
  const isOwner = !!viewerId && String(row.owner_id) === String(viewerId);
  if (row.visibility === 'private' && !isOwner) {
    const allowed = await canEditPlaylist(db, id, viewerId);
    if (!allowed) return undefined;
  }
  const canEdit = await canEditPlaylist(db, id, viewerId);
  return mapPlaylist(row, { canEdit });
}

export async function getPlaylistDetail(db: Db, id: string, viewerId?: string | null): Promise<PlaylistDetail | undefined> {
  const playlist = await getPlaylist(db, id, viewerId);
  if (!playlist) return undefined;
  const rows = await db.query<{ track_id: string; position: number }>(
    `SELECT pt.track_id, pt.position FROM playlist_tracks pt WHERE pt.playlist_id = $1::uuid ORDER BY pt.position`,
    [id],
  );
  const tracks = await listTracksByIds(db, rows.map((r) => String(r.track_id)), { viewerId, includeUnpublished: false });
  return { ...playlist, tracks };
}

export async function listUserPlaylists(db: Db, userId: string, opts: { viewerId?: string | null; includePrivate?: boolean; limit?: number } = {}) {
  const q = new Sql();
  const uid = q.bind(userId);
  const lim = q.bind(opts.limit ?? 50);
  const where = [`p.owner_id = ${uid}::uuid`];
  if (!opts.includePrivate) where.push(`p.visibility <> 'private'`);
  const viewer = q.bind(opts.viewerId ?? null);
  const rows = await db.query<Record<string, any>>(
    `SELECT ${playlistCols(viewer)} FROM playlists p LEFT JOIN users u ON u.id = p.owner_id
      WHERE ${where.join(' AND ')}
      ORDER BY p.updated_at DESC LIMIT ${lim}`,
    q.values,
  );
  return rows.map((r) => mapPlaylist(r, { canEdit: opts.includePrivate }));
}

export async function listCollaborativePlaylists(db: Db, userId: string) {
  const rows = await db.query<Record<string, any>>(
    `SELECT ${playlistCols('$1')} FROM playlists p LEFT JOIN users u ON u.id = p.owner_id
      JOIN playlist_collaborators c ON c.playlist_id = p.id AND c.user_id = $1::uuid AND c.status = 'accepted'
      WHERE p.owner_id <> $1::uuid ORDER BY p.updated_at DESC LIMIT 30`,
    [userId],
  );
  return rows.map((r) => mapPlaylist(r, { canEdit: true }));
}

/**
 * The public "editorial" shelves. `viewerId` is a separate bind on purpose: the same `$1`
 * cannot serve both `LIMIT` and the viewer's uuid test, because Postgres infers one type per
 * parameter ("argument of LIMIT must be type bigint, not type uuid").
 */
export async function listPublicPlaylistShelves(db: Db, limit = 24, viewerId?: string | null) {
  const rows = await db.query<Record<string, any>>(
    `SELECT ${playlistCols('$2')} FROM playlists p LEFT JOIN users u ON u.id = p.owner_id
      WHERE p.visibility = 'public' ORDER BY p.is_editorial DESC, p.follower_count DESC, p.updated_at DESC LIMIT $1`,
    [limit, viewerId ?? null],
  );
  return rows.map((r) => mapPlaylist(r));
}

export interface CreatePlaylistInput {
  ownerId: string | null;
  title: string;
  description?: string | null;
  visibility?: 'private' | 'public' | 'collaborative';
  collaborative?: boolean;
  imageUrl?: string | null;
  isEditorial?: boolean;
  generatedBy?: string | null;
  seedContext?: Record<string, unknown>;
  trackIds?: string[];
}

export async function createPlaylist(db: Db, input: CreatePlaylistInput): Promise<Playlist> {
  const title = input.title.trim().slice(0, 120);
  const created = await db.queryOne<{ id: string }>(
    `INSERT INTO playlists (id, owner_id, title, description, image_url, visibility, collaborative, is_editorial,
                            generated_by, seed_context, created_at, updated_at)
     VALUES (d7_uuid(), $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now(), now())
     ON CONFLICT (owner_id, title_key) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [
      input.ownerId,
      title,
      input.description ?? null,
      input.imageUrl ?? null,
      input.collaborative ? 'collaborative' : (input.visibility ?? 'private'),
      input.collaborative ?? false,
      input.isEditorial ?? false,
      input.generatedBy ?? null,
      JSON.stringify(input.seedContext ?? {}),
    ],
  );
  if (!created) throw new Error('playlist creation failed');
  const id = created.id;
  if (input.ownerId) {
    await db.execute(
      `INSERT INTO playlist_collaborators (playlist_id, user_id, permission, status)
       VALUES ($1::uuid, $2::uuid, 'manage', 'accepted') ON CONFLICT DO NOTHING`,
      [id, input.ownerId],
    );
  }
  if (input.trackIds?.length) await addTracks(db, id, input.trackIds, { actorId: input.ownerId, replace: true });
  await touchSearchDocument(db, 'playlist', id);
  const playlist = await getPlaylist(db, id, input.ownerId);
  return playlist!;
}

/** Ensures the "already exists" path still lands on a usable playlist id. */
export async function findOrCreatePlaylist(db: Db, input: CreatePlaylistInput): Promise<{ playlist: Playlist; existed: boolean }> {
  if (input.ownerId) {
    const existing = await db.queryOne<{ id: string }>(
      `SELECT id FROM playlists WHERE owner_id = $1::uuid AND title_key = d7_normalize_text($2)`,
      [input.ownerId, input.title.trim()],
    );
    if (existing) {
      const playlist = await getPlaylist(db, String(existing.id), input.ownerId);
      if (playlist) return { playlist, existed: true };
    }
  }
  return { playlist: await createPlaylist(db, input), existed: false };
}

export async function addTracks(
  db: Db,
  playlistId: string,
  trackIds: string[],
  opts: { actorId?: string | null; position?: number; replace?: boolean; allowMissing?: boolean } = {},
): Promise<{ added: number; skippedDuplicates: number; rejected: string[] }> {
  const valid = await db.query<{ id: string }>(
    `SELECT id FROM tracks WHERE id = ANY($1::uuid[]) AND status = 'published'`,
    [trackIds],
  );
  // Preserve the caller's order: the id set comes back in heap order, and playlist
  // positions are exactly the order the user arranged (or the reorder just requested).
  const validSet = new Set(valid.map((v) => String(v.id)));
  const seenInput = new Set<string>();
  const validIds: string[] = [];
  const rejected: string[] = [];
  for (const id of trackIds) {
    if (!validSet.has(id)) {
      if (!opts.allowMissing) rejected.push(id);
      continue;
    }
    if (seenInput.has(id)) continue;
    seenInput.add(id);
    validIds.push(id);
  }

  if (opts.replace) await db.execute(`DELETE FROM playlist_tracks WHERE playlist_id = $1::uuid`, [playlistId]);

  let added = 0;
  let skippedDuplicates = 0;
  let next = opts.position;
  if (next === undefined) {
    const max = await db.queryOne<{ m: number }>(`SELECT coalesce(max(position),0)::int AS m FROM playlist_tracks WHERE playlist_id = $1::uuid`, [playlistId]);
    next = Number(max?.m ?? 0) + 1;
  }
  for (const trackId of validIds) {
    const res = await db.execute(
      `INSERT INTO playlist_tracks (playlist_id, track_id, position, added_by, added_at)
       SELECT $1::uuid, $2::uuid, $3::int, $4::uuid, now()
       WHERE NOT EXISTS (SELECT 1 FROM playlist_tracks WHERE playlist_id = $1::uuid AND track_id = $2::uuid)`,
      [playlistId, trackId, next, opts.actorId ?? null],
    );
    if (res > 0) {
      added += 1;
      next += 1;
      await db.execute(`UPDATE tracks SET save_count = save_count + 1 WHERE id = $1::uuid`, [trackId]);
      await db.execute(
        `INSERT INTO playlist_edit_events (id, playlist_id, actor_id, action, track_id, position, created_at)
         VALUES (d7_uuid(), $1::uuid, $2::uuid, 'add', $3::uuid, $4::int, now())`,
        [playlistId, opts.actorId ?? null, trackId, next - 1],
      );
    } else skippedDuplicates += 1;
  }
  if (added) await touchPlaylist(db, playlistId);
  return { added, skippedDuplicates, rejected };
}

export async function removeTrack(db: Db, playlistId: string, trackId: string, actorId?: string | null) {
  const res = await db.execute(`DELETE FROM playlist_tracks WHERE playlist_id = $1::uuid AND track_id = $2::uuid`, [playlistId, trackId]);
  if (res) {
    await normalizePositions(db, playlistId);
    await db.execute(
      `INSERT INTO playlist_edit_events (id, playlist_id, actor_id, action, track_id, created_at)
       VALUES (d7_uuid(), $1::uuid, $2::uuid, 'remove', $3::uuid, now())`,
      [playlistId, actorId ?? null, trackId],
    );
    await touchPlaylist(db, playlistId);
  }
  return res;
}

/** Reorder by rewriting positions from the resulting id order — O(n) but n is small. */
export async function reorderTrack(db: Db, playlistId: string, from: number, to: number) {
  const rows = await db.query<{ track_id: string }>(
    `SELECT track_id FROM playlist_tracks WHERE playlist_id = $1::uuid ORDER BY position`,
    [playlistId],
  );
  const ids = rows.map((r) => String(r.track_id));
  if (from < 0 || from >= ids.length) return { ok: false, error: 'source position out of range' } as const;
  const [moved] = ids.splice(from, 1);
  ids.splice(Math.max(0, Math.min(ids.length, to)), 0, moved!);
  await db.execute(`DELETE FROM playlist_tracks WHERE playlist_id = $1::uuid`, [playlistId]);
  const params: unknown[] = [playlistId];
  const values = ids.map((id, i) => {
    params.push(id, i + 1);
    return `($1::uuid, $${params.length - 1}::uuid, $${params.length}::int, now())`;
  });
  await db.execute(`INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at) VALUES ${values.join(',')}`, params);
  await db.execute(
    `INSERT INTO playlist_edit_events (id, playlist_id, action, position, created_at) VALUES (d7_uuid(), $1::uuid, 'reorder', $2::int, now())`,
    [playlistId, to],
  );
  await touchPlaylist(db, playlistId);
  return { ok: true, ids } as const;
}

async function normalizePositions(db: Db, playlistId: string) {
  await db.execute(
    `WITH ordered AS (SELECT track_id, row_number() OVER (ORDER BY position, added_at) AS rn
                        FROM playlist_tracks WHERE playlist_id = $1::uuid)
     UPDATE playlist_tracks pt SET position = ordered.rn FROM ordered WHERE pt.playlist_id = $1::uuid AND pt.track_id = ordered.track_id`,
    [playlistId],
  );
}

async function touchPlaylist(db: Db, playlistId: string) {
  await db.execute(`UPDATE playlists SET updated_at = now() WHERE id = $1::uuid`, [playlistId]);
  await touchSearchDocument(db, 'playlist', playlistId);
}

export async function updatePlaylist(
  db: Db,
  playlistId: string,
  patch: { title?: string; description?: string | null; visibility?: 'private' | 'public' | 'collaborative'; collaborative?: boolean; imageUrl?: string | null },
  actorId?: string | null,
) {
  // A Map keyed by column: Postgres rejects `SET visibility = $2, visibility = $3` outright
  // ("multiple assignments to same column"), and the collaborative flag below derives exactly
  // that column. The row id is bound as $1 and each value follows as $2..$n — an unreferenced
  // parameter is also an error ("could not determine data type of parameter $1"), which is what
  // building the id-first list here instead of appending it protects against.
  const assigns = new Map<string, unknown>();
  const add = (col: string, val: unknown) => assigns.set(col, val);
  if (patch.title !== undefined) add('title', patch.title.trim().slice(0, 120));
  if (patch.description !== undefined) add('description', patch.description);
  if (patch.visibility !== undefined) add('visibility', patch.visibility);
  if (patch.imageUrl !== undefined) add('image_url', patch.imageUrl);
  if (patch.collaborative !== undefined) {
    add('collaborative', patch.collaborative);
    // Enabling collaboration implies collaborative visibility, but an explicit
    // `visibility` in the same patch always wins over the derived value.
    if (patch.collaborative && patch.visibility === undefined) add('visibility', 'collaborative');
  }
  if (!assigns.size) return getPlaylist(db, playlistId);
  const params = [playlistId, ...assigns.values()];
  const sets = [...assigns.keys()].map((col, i) => `${col} = $${i + 2}`);
  await db.execute(`UPDATE playlists SET ${sets.join(', ')}, updated_at = now() WHERE id = $1::uuid`, params);
  if (actorId)
    await db.execute(
      `INSERT INTO playlist_edit_events (id, playlist_id, actor_id, action, created_at)
       VALUES (d7_uuid(), $1::uuid, $2::uuid, 'rename', now())`,
      [playlistId, actorId],
    );
  await touchSearchDocument(db, 'playlist', playlistId);
  return getPlaylist(db, playlistId);
}

export async function deletePlaylist(db: Db, playlistId: string) {
  await removeSearchDocument(db, 'playlist', playlistId);
  return db.execute(`DELETE FROM playlists WHERE id = $1::uuid`, [playlistId]);
}

export async function setPlaylistFollow(db: Db, playlistId: string, userId: string, follow: boolean) {
  if (follow) {
    await db.execute(
      `INSERT INTO playlist_followers (playlist_id, user_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`,
      [playlistId, userId],
    );
  } else {
    await db.execute(`DELETE FROM playlist_followers WHERE playlist_id = $1::uuid AND user_id = $2::uuid`, [playlistId, userId]);
  }
  await db.execute(
    `UPDATE playlists SET follower_count = (SELECT count(*) FROM playlist_followers WHERE playlist_id = $1::uuid)::int WHERE id = $1::uuid`,
    [playlistId],
  );
}

export async function inviteCollaborator(db: Db, playlistId: string, targetUserId: string, permission: 'view' | 'edit' | 'manage' = 'edit') {
  await db.execute(
    `INSERT INTO playlist_collaborators (playlist_id, user_id, permission, status)
     VALUES ($1::uuid, $2::uuid, $3, 'invited')
     ON CONFLICT (playlist_id, user_id) DO UPDATE SET permission = EXCLUDED.permission, status = 'invited'`,
    [playlistId, targetUserId, permission],
  );
  await db.execute(`UPDATE playlists SET collaborative = true, visibility = 'collaborative' WHERE id = $1::uuid AND visibility = 'private'`, [playlistId]);
}

export async function acceptCollaboration(db: Db, playlistId: string, userId: string) {
  const res = await db.execute(
    `UPDATE playlist_collaborators SET status = 'accepted' WHERE playlist_id = $1::uuid AND user_id = $2::uuid`,
    [playlistId, userId],
  );
  return res > 0;
}

export async function playlistTrackIds(db: Db, playlistId: string): Promise<string[]> {
  const rows = await db.query<{ track_id: string }>(
    `SELECT track_id FROM playlist_tracks WHERE playlist_id = $1::uuid ORDER BY position`,
    [playlistId],
  );
  return rows.map((r) => String(r.track_id));
}

export async function playlistEditLog(db: Db, playlistId: string, limit = 50) {
  return db.query(
    `SELECT pef.id, pef.action, pef.position, pef.created_at, pef.track_id,
            u.username AS actor_username, t.title AS track_title
       FROM playlist_edit_events pef
       LEFT JOIN users u ON u.id = pef.actor_id
       LEFT JOIN tracks t ON t.id = pef.track_id
      WHERE pef.playlist_id = $1::uuid ORDER BY pef.created_at DESC LIMIT $2`,
    [playlistId, Math.min(limit, 200)],
  );
}
