/**
 * Playlists, including collaborative editing (spec §8).
 *
 * Permissions are resolved by `canEditPlaylist` in the database layer — private is owner-only,
 * public is owner-only, collaborative is owner + accepted editors — so these routes never
 * re-implement the rules and the AI assistant gets identical behaviour.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
// Registers request.isMultipart()/request.file() types.
import '@fastify/multipart';
import { z } from 'zod';
import { env } from '@d7/config';
import {
  acceptCollaboration,
  addTracks,
  canEditPlaylist,
  createPlaylist,
  deletePlaylist,
  findUserByLogin,
  getPlaylistDetail,
  inviteCollaborator,
  listCollaborativePlaylists,
  listPublicPlaylistShelves,
  listUserPlaylists,
  playlistEditLog,
  playlistTrackIds,
  removeTrack,
  reorderTrack,
  setPlaylistFollow,
  updatePlaylist,
} from '@d7/database';
import { ApiError, boolField, guardRate, idSchema, intField, parseBody } from '../lib/http.js';
import { hydrateTracks } from '../lib/media.js';
import type { SessionUser } from '../plugins/session.js';

const visibility = z.enum(['private', 'public', 'collaborative']);

export default async function playlistRoutes(app: FastifyInstance) {
  const db = () => app.d7.db;

  const requireEditor = async (playlistId: string, request: FastifyRequest): Promise<SessionUser> => {
    const user = await request.requireUser();
    if (!(await canEditPlaylist(db(), playlistId, user.id))) {
      throw ApiError.forbidden('You do not have edit access to this playlist.', 'NOT_PLAYLIST_EDITOR');
    }
    return user;
  };

  /** Signed-in viewer's own playlists plus the ones they collaborate on. */
  app.get('/api/playlists', async (request) => {
    const user = await request.optionalUser();
    const limit = intField((request.query as { limit?: string }).limit, 24, 4, 60);
    if (!user) {
      return { mine: [], collaborative: [], editorial: await listPublicPlaylistShelves(db(), limit, null) };
    }
    const [mine, collaborative, editorial] = await Promise.all([
      listUserPlaylists(db(), user.id, { viewerId: user.id, includePrivate: true, limit: 60 }),
      listCollaborativePlaylists(db(), user.id),
      listPublicPlaylistShelves(db(), 12, user.id),
    ]);
    return { mine, collaborative, editorial };
  });

  app.post('/api/playlists', async (request, reply) => {
    const user = await request.requireUser();
    await guardRate(app, request, reply, { bucket: 'playlist:create', limit: env.RATE_LIMIT_WRITE, message: 'You are creating playlists very quickly.' });
    const body = parseBody(
      z.object({
        title: z.string().min(2, 'Give your playlist a name.').max(120),
        description: z.string().max(500).nullable().optional(),
        visibility: visibility.optional(),
        collaborative: z.boolean().optional(),
        imageUrl: z.string().max(500).nullable().optional(),
        trackIds: z.array(idSchema).max(500).optional(),
      }),
      request.body,
    );
    const playlist = await createPlaylist(db(), {
      ownerId: user.id,
      title: body.title.trim(),
      description: body.description ?? null,
      visibility: body.collaborative ? 'collaborative' : body.visibility ?? 'private',
      collaborative: body.collaborative ?? false,
      imageUrl: body.imageUrl ?? null,
      trackIds: body.trackIds ?? [],
    });
    return reply.code(201).send({ playlist });
  });

  app.get('/api/playlists/:id', async (request) => {
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const user = await request.optionalUser();
    const detail = await getPlaylistDetail(db(), id, user?.id ?? null);
    if (!detail) throw ApiError.notFound('Playlist');
    const tracks = await hydrateTracks(app, detail.tracks, user);
    return {
      playlist: { ...detail, tracks },
      trackIds: tracks.map((t) => t.id),
      canEdit: user ? await canEditPlaylist(db(), id, user.id) : false,
      owner: detail.owner,
    };
  });

  app.patch('/api/playlists/:id', async (request) => {
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const user = await requireEditor(id, request);
    const body = parseBody(
      z.object({
        title: z.string().min(2).max(120).optional(),
        description: z.string().max(500).nullable().optional(),
        visibility: visibility.optional(),
        collaborative: z.boolean().optional(),
        imageUrl: z.string().max(500).nullable().optional(),
      }),
      request.body,
    );
    const playlist = await updatePlaylist(db(), id, body, user.id);
    if (!playlist) throw ApiError.notFound('Playlist');
    void app.d7.notifications.notifyPlaylistChange({ playlistId: id, title: playlist.title, actorId: user.id, action: 'rename' });
    return { playlist };
  });

  app.delete('/api/playlists/:id', async (request) => {
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const user = await requireEditor(id, request);
    // Only the owner may delete a shared playlist; editors may only edit it.
    const ownerRow = await db().queryOne<{ owner_id: string }>(`SELECT owner_id::text FROM playlists WHERE id = $1::uuid`, [id]);
    if (ownerRow && ownerRow.owner_id !== user.id) throw ApiError.forbidden('Only the owner can delete this playlist.', 'NOT_OWNER');
    await deletePlaylist(db(), id);
    return { deleted: true };
  });

  app.post('/api/playlists/:id/tracks', async (request) => {
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const user = await requireEditor(id, request);
    const body = parseBody(
      z.object({
        trackIds: z.array(idSchema).min(1).max(500),
        position: z.number().int().min(0).optional(),
        replace: z.boolean().optional(),
      }),
      request.body,
    );
    const result = await addTracks(db(), id, body.trackIds, { actorId: user.id, position: body.position, replace: body.replace });
    const detail = await getPlaylistDetail(db(), id, user.id);
    if (detail && result.added) {
      void app.d7.notifications
        .notifyPlaylistChange({
          playlistId: id,
          title: detail.title,
          actorId: user.id,
          action: 'add',
          trackTitle: `${result.added} track${result.added === 1 ? '' : 's'}`,
        })
        .catch((err) => app.d7.log.warn('playlist notification failed', { message: (err as Error).message }));
    }
    return { ...result, playlist: detail ? { id: detail.id, trackCount: detail.trackCount } : null };
  });

  app.delete('/api/playlists/:id/tracks/:trackId', async (request) => {
    const { id, trackId } = parseBody(z.object({ id: idSchema, trackId: idSchema }), request.params as { id: string; trackId: string });
    const user = await requireEditor(id, request);
    const removed = await removeTrack(db(), id, trackId, user.id);
    const detail = await getPlaylistDetail(db(), id, user.id);
    if (detail && removed) {
      void app.d7.notifications.notifyPlaylistChange({ playlistId: id, title: detail.title, actorId: user.id, action: 'remove' });
    }
    return { removed: removed > 0 };
  });

  app.post('/api/playlists/:id/reorder', async (request) => {
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const user = await requireEditor(id, request);
    const body = parseBody(z.object({ from: z.number().int().min(0), to: z.number().int().min(0) }), request.body);
    const result = await reorderTrack(db(), id, body.from, body.to);
    if (!result.ok) throw ApiError.badRequest(result.error, [{ path: 'from', message: result.error }]);
    void app.d7.notifications.notifyPlaylistChange({ playlistId: id, title: '', actorId: user.id, action: 'reorder' });
    return { ok: true, order: result.ids };
  });

  /** Replace the full order in one shot (drag-and-drop reorder of a whole playlist). */
  app.put('/api/playlists/:id/order', async (request) => {
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const user = await requireEditor(id, request);
    const body = parseBody(z.object({ trackIds: z.array(idSchema).min(1).max(500) }), request.body);
    const current = await playlistTrackIds(db(), id);
    const sorted = [...current].sort();
    const wanted = [...body.trackIds].sort();
    if (sorted.join(',') !== wanted.join(',')) {
      throw ApiError.badRequest('The new order must contain exactly the tracks already in this playlist.', [
        { path: 'trackIds', message: `${body.trackIds.length} ids given, ${current.length} expected` },
      ]);
    }
    await addTracks(db(), id, body.trackIds, { actorId: user.id, replace: true });
    return { ok: true, trackIds: body.trackIds };
  });

  app.post('/api/playlists/:id/follow', async (request) => {
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const user = await request.requireUser();
    await setPlaylistFollow(db(), id, user.id, true);
    return { following: true };
  });

  app.delete('/api/playlists/:id/follow', async (request) => {
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const user = await request.requireUser();
    await setPlaylistFollow(db(), id, user.id, false);
    return { following: false };
  });

  app.post('/api/playlists/:id/collaborators', async (request) => {
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const user = await requireEditor(id, request);
    const body = parseBody(
      z.object({ username: z.string().min(2).max(40), permission: z.enum(['view', 'edit', 'manage']).optional(), acceptNow: z.boolean().optional() }),
      request.body,
    );
    const target = await findUserByLogin(db(), body.username.replace(/^@/, ''));
    if (!target) throw ApiError.notFound(`@${body.username}`);
    const invite = await inviteCollaborator(db(), id, target.id, body.permission ?? 'edit');
    if (body.acceptNow ?? true) await acceptCollaboration(db(), id, target.id);
    // Flipping to collaborative is what actually lets the invitee edit.
    await updatePlaylist(db(), id, { visibility: 'collaborative', collaborative: true }, user.id);
    const detail = await getPlaylistDetail(db(), id, user.id);
    void app.d7.notifications
      .system({
        userId: target.id,
        title: `You can edit "${detail?.title ?? 'a playlist'}"`,
        body: `${user.displayName ?? user.username} invited you as a ${body.permission ?? 'edit'} collaborator.`,
        actionHref: `/playlists/${id}`,
        dedupeKey: `playlist:collab:${id}:${user.id}`,
      })
      .catch(() => undefined);
    return { invited: true, userId: target.id, permission: body.permission ?? 'edit', inviteId: invite };
  });

  app.get('/api/playlists/:id/log', async (request) => {
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const user = await request.requireUser();
    if (!(await canEditPlaylist(db(), id, user.id))) throw ApiError.forbidden('Only editors can read the change log.', 'NOT_PLAYLIST_EDITOR');
    return { entries: await playlistEditLog(db(), id, intField((request.query as { limit?: string }).limit, 50, 5, 200)) };
  });

  app.get('/api/playlists/:id/preview', async (request) => {
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const user = await request.optionalUser();
    const detail = await getPlaylistDetail(db(), id, user?.id ?? null);
    if (!detail) throw ApiError.notFound('Playlist');
    const tracks = await hydrateTracks(app, detail.tracks.slice(0, 3), user);
    return { playlist: { id: detail.id, title: detail.title, imageUrl: detail.imageUrl, trackCount: detail.trackCount }, tracks };
  });

  app.get('/api/playlists/:id/shuffle-ok', async (request) => {
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const user = await request.optionalUser();
    const detail = await getPlaylistDetail(db(), id, user?.id ?? null);
    if (!detail) throw ApiError.notFound('Playlist');
    // Plan gating lives server-side; the UI only reflects what the API says it may do.
    const forced = boolField((request.query as { force?: string }).force);
    void forced;
    return {
      shuffleAllowed: Boolean(user?.plan.limits.ads === false) || detail.owner.id === user?.id,
      reason: user?.plan.limits.ads ? 'Free plans shuffle on play; Premium plays in order.' : null,
    };
  });

  /** Playlist cover art: stored through the same object store as audio, but public. */
  app.post('/api/playlists/:id/artwork', async (request, reply) => {
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const user = await requireEditor(id, request);
    if (!request.isMultipart()) throw ApiError.badRequest('Send the image as multipart/form-data.', [{ path: 'file', message: 'Expected a file field' }]);
    const file = await request.file();
    if (!file) throw ApiError.badRequest('No file part found.', [{ path: 'file', message: 'Missing' }]);
    const kind = file.mimetype;
    if (!/^image\/(png|jpe?g|webp|gif|avif|svg\+xml)$/.test(kind)) {
      throw ApiError.badRequest(`Unsupported image type "${kind}".`, [{ path: 'file', message: 'png, jpeg, webp, gif, avif or svg' }]);
    }
    const maxBytes = env.UPLOAD_MAX_MB * 1024 * 1024;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of file.file) {
      size += (chunk as Buffer).length;
      if (size > maxBytes) throw ApiError.payload(`Artwork must be under ${env.UPLOAD_MAX_MB} MB.`);
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks);
    if (!body.length) throw ApiError.badRequest('That file was empty.', [{ path: 'file', message: 'Zero bytes' }]);
    const ext = kind.includes('png') ? 'png' : kind.includes('jpeg') ? 'jpg' : kind.includes('webp') ? 'webp' : kind.includes('gif') ? 'gif' : kind.includes('avif') ? 'avif' : 'svg';
    const up = await app.d7.storage.upload({ key: `artwork/playlist-${id}-${Date.now()}.${ext}`, body, contentType: kind });
    const playlist = await updatePlaylist(db(), id, { imageUrl: `/media/${up.key}` }, user.id);
    void app.d7.notifications.notifyPlaylistChange({ playlistId: id, title: playlist?.title ?? '', actorId: user.id, action: 'artwork' });
    return reply.code(201).send({ imageUrl: `/media/${up.key}`, bytes: up.bytes, sha256: up.sha256 });
  });
}
