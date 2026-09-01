/**
 * Your library, social graph, notifications and preferences (spec §8, §9, §11).
 *
 * Notification fan-out happens in services/notifications; this file only reads the inbox and
 * exposes the follow/like writes that trigger it.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '@d7/config';
import {
  findUserById,
  getPreferences,
  getPublicProfile,
  isFollowingArtist,
  listAlbumsByIds,
  listFollowedArtistIds,
  listLikedTrackIds,
  listNotifications,
  listUserPlaylists,
  markNotificationsRead,
  type Db,
  setArtistFollow,
  setLikedAlbum,
  setPreferences,
  setUserFollow,
  unreadCount,
  updateUser,
} from '@d7/database';
import { ApiError, boolField, guardRate, idSchema, intField, parseBody } from '../lib/http.js';
import { hydrateTracks } from '../lib/media.js';
import { listTracksByIds, listArtistNames } from '@d7/database';

export default async function libraryRoutes(app: FastifyInstance) {
  const db = () => app.d7.db;

  /* ------------------------------- your library ------------------------------- */

  app.get('/api/library', async (request) => {
    const user = await request.requireUser();
    const [likedIds, followedArtistIds, likedAlbumIds, playlists] = await Promise.all([
      listLikedTrackIds(db(), user.id, 500),
      listFollowedArtistIds(db(), user.id, 200),
      db().query<{ album_id: string }>(`SELECT album_id FROM liked_albums WHERE user_id = $1::uuid ORDER BY created_at DESC LIMIT 60`, [user.id]).then((r) => r.map((x) => String(x.album_id))),
      listUserPlaylists(db(), user.id, { viewerId: user.id, includePrivate: true, limit: 60 }),
    ]);
    const [artists, albums] = await Promise.all([
      followedArtistIds.length
        ? db().query<Record<string, any>>(
            `SELECT ar.id FROM artists ar
              WHERE ar.id = ANY($1::uuid[]) ORDER BY ar.followers_count DESC LIMIT 40`,
            [followedArtistIds],
          ).then((rows) => Promise.all(rows.map((r) => db().queryOne<Record<string, any>>(`SELECT id FROM artists WHERE id = $1::uuid`, [r.id]))))
        : Promise.resolve([]),
      listAlbumsByIds(db(), likedAlbumIds),
    ]);
    const tracks = await hydrateTracks(app, await listTracksByIds(db(), likedIds, { viewerId: user.id }), user);
    return {
      liked: { tracks, total: tracks.length },
      albums,
      artists: (await import('@d7/database')).listArtistsByIds(db(), artists.map((a) => String(a!.id))),
      playlists,
      counts: { liked: likedIds.length, artists: followedArtistIds.length, albums: likedAlbumIds.length, playlists: playlists.length },
    };
  });

  app.get('/api/library/albums', async (request) => {
    const user = await request.requireUser();
    const ids = await db()
      .query<{ album_id: string }>(
        `SELECT album_id FROM liked_albums WHERE user_id = $1::uuid ORDER BY created_at DESC LIMIT $2`,
        [user.id, intField((request.query as { limit?: string }).limit, 40, 1, 100)],
      )
      .then((r) => r.map((x) => String(x.album_id)));
    return { albums: await listAlbumsByIds(db(), ids) };
  });

  app.get('/api/library/artists', async (request) => {
    const user = await request.requireUser();
    const ids = await listFollowedArtistIds(db(), user.id, intField((request.query as { limit?: string }).limit, 60, 1, 200));
    const { listArtistsByIds } = await import('@d7/database');
    return { artists: await listArtistsByIds(db(), ids) };
  });

  /** Offline downloads (Premium only) — the row records what the device may keep. */
  app.get('/api/library/downloads', async (request) => {
    const user = await request.requireUser();
    const rows = await db().query<Record<string, any>>(
      `SELECT od.id::text, od.track_id::text, od.device, od.status, od.expires_at::text, od.created_at::text, t.title
         FROM offline_downloads od JOIN tracks t ON t.id = od.track_id
        WHERE od.user_id = $1::uuid ORDER BY od.created_at DESC LIMIT 100`,
      [user.id],
    );
    return {
      downloads: rows.map((r) => ({
        id: String(r.id),
        trackId: String(r.track_id),
        trackTitle: r.title,
        device: r.device,
        status: r.status,
        expiresAt: r.expires_at ?? null,
        createdAt: r.created_at,
      })),
      allowed: !user.plan.limits.offlineDownloads ? false : true,
      quota: user.plan.limits.offlineDownloads,
    };
  });

  app.post('/api/library/downloads', async (request) => {
    const user = await request.requireUser();
    const body = parseBody(z.object({ trackId: idSchema, device: z.string().max(40).default('web') }), request.body);
    if (!user.plan.limits.offlineDownloads) {
      throw ApiError.forbidden('Offline downloads are a Premium feature.', 'PREMIUM_REQUIRED');
    }
    const used = await db().queryOne<{ c: number }>(
      `SELECT count(*)::int AS c FROM offline_downloads WHERE user_id = $1::uuid AND status = 'active'`,
      [user.id],
    );
    if (Number(used?.c ?? 0) >= user.plan.limits.offlineDownloads) {
      throw new ApiError(409, 'DOWNLOAD_QUOTA', `You have ${user.plan.limits.offlineDownloads} active downloads. Remove one to add another.`);
    }
    const row = await db().queryOne<{ storage_key: string | null; duration_ms: number }>(
      `SELECT storage_key, duration_ms FROM tracks WHERE id = $1::uuid AND streamable AND status = 'published'`,
      [body.trackId],
    );
    if (!row?.storage_key) throw ApiError.notFound('Playable track');
    const inserted = await db().queryOne<{ id: string }>(
      `INSERT INTO offline_downloads (id, user_id, track_id, storage_key, device, status, expires_at, created_at)
       VALUES (d7_uuid(), $1::uuid, $2::uuid, $3, $4, 'active', now() + interval '30 days', now()) RETURNING id`,
      [user.id, body.trackId, row.storage_key, body.device],
    );
    return { id: inserted!.id, url: await app.d7.storage.getSignedUrl(row.storage_key, { expiresSec: 600, download: true, filename: 'd7-download' }), expiresInSeconds: 600 };
  });

  app.delete('/api/library/downloads/:id', async (request) => {
    const user = await request.requireUser();
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    await db().execute(`UPDATE offline_downloads SET status = 'removed' WHERE id = $1::uuid AND user_id = $2::uuid`, [id, user.id]);
    return { removed: true };
  });

  /* --------------------------------- profiles --------------------------------- */

  app.get('/api/users/:username', async (request) => {
    const { username } = parseBody(z.object({ username: z.string().min(2).max(40) }), request.params as { username: string });
    const user = await request.optionalUser();
    const profile = await getPublicProfile(db(), username.replace(/^@/, ''), user?.id ?? null);
    if (!profile) throw ApiError.notFound('User');
    return { profile };
  });

  app.get('/api/users/:username/playlists', async (request) => {
    const { username } = parseBody(z.object({ username: z.string().min(2).max(40) }), request.params as { username: string });
    const target = await db().queryOne<{ id: string }>(`SELECT id FROM users WHERE username_key = d7_normalize_text($1)`, [username.replace(/^@/, '')]);
    if (!target) throw ApiError.notFound('User');
    const viewer = await request.optionalUser();
    const { listPublicPlaylistShelves } = await import('@d7/database');
    const owned = await listUserPlaylists(db(), String(target.id), { viewerId: viewer?.id ?? null, includePrivate: false, limit: 40 });
    return { playlists: owned.length ? owned : await listPublicPlaylistShelves(db(), 12) };
  });

  app.post('/api/users/:id/follow', async (request, reply) => {
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const user = await request.requireUser();
    if (id === user.id) throw ApiError.badRequest('You cannot follow yourself.', [{ path: 'id', message: 'That is you' }]);
    if (!(await findUserById(db(), id))) throw ApiError.notFound('User');
    await guardRate(app, request, reply, { bucket: 'follow', limit: env.RATE_LIMIT_WRITE, message: 'You are following people very quickly.' });
    await setUserFollow(db(), user.id, id, true);
    const { pushNotification } = await import('@d7/database');
    await pushNotification(db(), {
      userId: id,
      kind: 'new_follower',
      title: `${user.displayName ?? user.username} started following you`,
      body: 'They can see your public playlists.',
      actionHref: `/u/${user.username}`,
      dedupeKey: `follow:${user.id}`,
    });
    return { following: true };
  });

  app.delete('/api/users/:id/follow', async (request) => {
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const user = await request.requireUser();
    await setUserFollow(db(), user.id, id, false);
    return { following: false };
  });

  /* ------------------------------- notifications ------------------------------- */

  app.get('/api/notifications', async (request) => {
    const user = await request.requireUser();
    const limit = intField((request.query as { limit?: string }).limit, 30, 5, 100);
    const rows = await listNotifications(db(), user.id, { limit, unreadOnly: boolField((request.query as { unread?: string }).unread) ?? false });
    return {
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        title: r.title,
        body: r.body,
        imageUrl: r.image_url,
        actionHref: r.action_href,
        payload: r.payload,
        createdAt: r.created_at,
        read: r.read,
      })),
      unread: await unreadCount(db(), user.id),
    };
  });

  app.get('/api/notifications/badge', async (request) => {
    const user = await request.requireUser();
    return { unread: await app.d7.notifications.badge(user.id) };
  });

  app.post('/api/notifications/read', async (request) => {
    const user = await request.requireUser();
    const body = parseBody(z.object({ ids: z.array(idSchema).max(100).optional() }), request.body ?? {});
    const updated = await markNotificationsRead(db(), user.id, body.ids);
    return { markedRead: updated, unread: await unreadCount(db(), user.id) };
  });

  /* -------------------------------- preferences -------------------------------- */

  app.get('/api/users/me/preferences', async (request) => {
    const user = await request.requireUser();
    return { preferences: await getPreferences(db(), user.id) };
  });

  app.put('/api/users/me/preferences', async (request) => {
    const user = await request.requireUser();
    const body = parseBody(
      z.object({
        theme: z.enum(['dark', 'system']).optional(),
        explicitFilter: z.boolean().optional(),
        autoplay: z.boolean().optional(),
        audioQuality: z.enum(['low', 'normal', 'high']).optional(),
        showListeningHistory: z.boolean().optional(),
        notifyFollowedArtists: z.boolean().optional(),
        locale: z.string().length(2).optional(),
      }),
      request.body,
    );
    const preferences = await setPreferences(db(), user.id, body);
    // The signed-in user object is cached in `buildCurrentUser`; the next request rebuilds it.
    return { preferences };
  });

  app.patch('/api/users/me/avatar', async (request, reply) => {
    const user = await request.requireUser();
    if (!request.isMultipart()) throw ApiError.badRequest('Send the image as multipart/form-data.', [{ path: 'file', message: 'Expected a file field' }]);
    const file = await request.file();
    if (!file) throw ApiError.badRequest('No file part found.', [{ path: 'file', message: 'Missing' }]);
    if (!/^image\//.test(file.mimetype)) throw ApiError.badRequest('Avatars must be images.', [{ path: 'file', message: `Got ${file.mimetype}` }]);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of file.file) {
      size += (chunk as Buffer).length;
      if (size > 4 * 1024 * 1024) throw ApiError.payload('Avatars must be under 4 MB.');
      chunks.push(chunk as Buffer);
    }
    const up = await app.d7.storage.upload({ key: `artwork/avatar-${user.id}-${Date.now()}.png`, body: Buffer.concat(chunks), contentType: file.mimetype });
    await updateUser(db(), user.id, { avatarUrl: `/media/${up.key}` });
    return reply.code(201).send({ avatarUrl: `/media/${up.key}` });
  });

  /* ---------------------------------- summary ---------------------------------- */

  app.get('/api/me/stats', async (request) => {
    const user = await request.requireUser();
    const row = await db().queryOne<Record<string, any>>(
      `SELECT (SELECT count(*) FROM liked_tracks WHERE user_id = $1::uuid)::int AS likes,
              (SELECT count(*) FROM followed_artists WHERE user_id = $1::uuid)::int AS artists,
              (SELECT count(*) FROM playlists WHERE owner_id = $1::uuid)::int AS playlists,
              (SELECT coalesce(sum(total_listened_ms),0) FROM listening_history WHERE user_id = $1::uuid)::bigint AS listened_ms,
              (SELECT coalesce(sum(play_count),0) FROM listening_history WHERE user_id = $1::uuid)::bigint AS plays,
              (SELECT count(DISTINCT t.primary_artist_id) FROM listening_history lh
                  JOIN tracks t ON t.id = lh.track_id WHERE lh.user_id = $1::uuid)::int AS artists_heard,
              (SELECT count(*)::int FROM assistant_messages am
                 JOIN assistant_conversations ac ON ac.id = am.conversation_id
                WHERE ac.user_id = $1::uuid) AS assistant_messages`,
      [user.id],
    );
    const genreRow = await db().query<Record<string, any>>(
      `SELECT g.slug, count(*)::int AS plays
         FROM listening_history lh
         JOIN track_genres tg ON tg.track_id = lh.track_id
         JOIN genres g ON g.id = tg.genre_id
        WHERE lh.user_id = $1::uuid
        GROUP BY g.slug ORDER BY plays DESC LIMIT 6`,
      [user.id],
    );
    return {
      likes: Number(row?.likes ?? 0),
      artistsFollowed: Number(row?.artists ?? 0),
      playlists: Number(row?.playlists ?? 0),
      totalListenedMs: Number(row?.listened_ms ?? 0),
      plays: Number(row?.plays ?? 0),
      distinctArtistsHeard: Number(row?.artists_heard ?? 0),
      assistantMessages: Number(row?.assistant_messages ?? 0),
      topGenres: genreRow.map((g) => ({ genre: String(g.slug), plays: Number(g.plays) })),
      // Following a loved artist is the highest-value nudge we have; counts come from the DB,
      // not from a client-side guess.
      suggestions: await unFollowedArtistsFromHistory(db(), user.id),
    };
  });
}

async function unFollowedArtistsFromHistory(db: Db, userId: string, limit = 4) {
  const rows = await db.query<Record<string, any>>(
    `SELECT ar.id, ar.name, count(*)::int AS plays
       FROM listening_history lh
       JOIN tracks t ON t.id = lh.track_id
       JOIN artists ar ON ar.id = t.primary_artist_id
      WHERE lh.user_id = $1::uuid
        AND NOT EXISTS (SELECT 1 FROM followed_artists fa WHERE fa.user_id = $1::uuid AND fa.artist_id = ar.id)
      GROUP BY ar.id, ar.name
      ORDER BY plays DESC LIMIT $2`,
    [userId, limit],
  );
  return rows.map((r) => ({ id: String(r.id), name: String(r.name), plays: Number(r.plays), whyNotified: 'you play this artist but do not follow them' }));
}
