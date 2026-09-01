/** Likes, follows, profiles, notifications. */
import type { Db } from './client.js';
import { Sql } from './sql.js';
import { map } from './map.js';
import type { NotificationKind, PublicUser } from '@d7/types';

/* --------------------------------- users --------------------------------- */

export interface UserRecord {
  id: string;
  username: string;
  email: string;
  password_hash: string | null;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  role: 'listener' | 'artist' | 'admin';
  status: string;
  email_verified: boolean;
  created_at: string;
  last_seen_at: string | null;
}

export async function findUserByLogin(db: Db, login: string): Promise<UserRecord | undefined> {
  return db.queryOne<UserRecord>(
    `SELECT id, username, email, password_hash, display_name, avatar_url, bio, role, status,
            email_verified, created_at::text, last_seen_at::text
       FROM users WHERE email_key = d7_normalize_text($1) OR username_key = d7_normalize_text($1) LIMIT 1`,
    [login],
  );
}

export async function findUserById(db: Db, id: string): Promise<UserRecord | undefined> {
  return db.queryOne<UserRecord>(
    `SELECT id, username, email, password_hash, display_name, avatar_url, bio, role, status,
            email_verified, created_at::text, last_seen_at::text FROM users WHERE id = $1::uuid`,
    [id],
  );
}

export async function createUser(
  db: Db,
  input: { username: string; email: string; passwordHash: string | null; displayName?: string | null; role?: 'listener' | 'artist' | 'admin'; emailVerified?: boolean },
): Promise<UserRecord> {
  const row = await db.queryOne<UserRecord>(
    `INSERT INTO users (id, username, email, password_hash, display_name, role, email_verified, created_at, last_seen_at)
     VALUES (d7_uuid(), $1, $2, $3, $4, $5, $6, now(), now())
     RETURNING id, username, email, password_hash, display_name, avatar_url, bio, role, status, email_verified,
               created_at::text, last_seen_at::text`,
    [input.username, input.email, input.passwordHash, input.displayName ?? null, input.role ?? 'listener', input.emailVerified ?? false],
  );
  if (!row) throw new Error('user creation failed');
  await db.execute(
    `INSERT INTO user_preferences (user_id) VALUES ($1::uuid) ON CONFLICT DO NOTHING`,
    [row.id],
  );
  await db.execute(
    `INSERT INTO subscriptions (id, user_id, tier, status, payment_provider, price_cents)
     VALUES (d7_uuid(), $1::uuid, 'free', 'active', 'manual', 0) ON CONFLICT DO NOTHING`,
    [row.id],
  );
  return row;
}

export async function updateUser(db: Db, userId: string, patch: Partial<{ displayName: string | null; avatarUrl: string | null; bio: string | null; role: 'listener' | 'artist' | 'admin' }>) {
  const q = new Sql();
  const uid = q.bind(userId);
  const sets: string[] = [];
  if (patch.displayName !== undefined) sets.push(`display_name = ${q.bind(patch.displayName)}`);
  if (patch.avatarUrl !== undefined) sets.push(`avatar_url = ${q.bind(patch.avatarUrl)}`);
  if (patch.bio !== undefined) sets.push(`bio = ${q.bind(patch.bio)}`);
  if (patch.role !== undefined) sets.push(`role = ${q.bind(patch.role)}`);
  if (!sets.length) return findUserById(db, userId);
  await db.execute(`UPDATE users SET ${sets.join(', ')} WHERE id = ${uid}::uuid`, q.values);
  return findUserById(db, userId);
}

export async function getPreferences(db: Db, userId: string) {
  const row = await db.queryOne<Record<string, any>>(`SELECT * FROM user_preferences WHERE user_id = $1::uuid`, [userId]);
  return {
    theme: (row?.theme as 'dark' | 'system') ?? 'dark',
    explicitFilter: map.bool(row?.explicit_filter ?? true),
    autoplay: map.bool(row?.autoplay ?? true),
    audioQuality: (row?.audio_quality as 'low' | 'normal' | 'high') ?? 'normal',
    showListeningHistory: map.bool(row?.show_listening_history ?? false),
    notifyFollowedArtists: map.bool(row?.notify_followed_artists ?? true),
    locale: String(row?.locale ?? 'en'),
  };
}

export async function setPreferences(db: Db, userId: string, patch: Partial<Awaited<ReturnType<typeof getPreferences>>>) {
  await db.execute(
    `INSERT INTO user_preferences (user_id, theme, explicit_filter, autoplay, audio_quality, show_listening_history, notify_followed_artists, locale)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id) DO UPDATE SET
       theme = coalesce(NULLIF($2,''), user_preferences.theme),
       explicit_filter = $3, autoplay = $4,
       audio_quality = coalesce(NULLIF($5,''), user_preferences.audio_quality),
       show_listening_history = $6, notify_followed_artists = $7, locale = $8, updated_at = now()`,
    [
      userId,
      patch.theme ?? 'dark',
      patch.explicitFilter ?? true,
      patch.autoplay ?? true,
      patch.audioQuality ?? 'normal',
      patch.showListeningHistory ?? false,
      patch.notifyFollowedArtists ?? true,
      patch.locale ?? 'en',
    ],
  );
  return getPreferences(db, userId);
}

export async function touchLastSeen(db: Db, userId: string) {
  // Throttled by the caller; keep this a single cheap UPDATE.
  await db.execute(`UPDATE users SET last_seen_at = now() WHERE id = $1::uuid`, [userId]);
}

/* ------------------------------ public profile ------------------------------ */

export async function getPublicProfile(db: Db, username: string, viewerId?: string | null): Promise<PublicUser | undefined> {
  const q = new Sql();
  const uname = q.bind(username);
  const viewer = q.bind(viewerId ?? null);
  const row = await db.queryOne<Record<string, any>>(
    `SELECT u.id, u.username, u.display_name, u.avatar_url, u.bio, u.role,
            coalesce(sub.tier,'free') AS tier, u.created_at,
            (SELECT count(*) FROM user_follows f WHERE f.followee_id = u.id)::int AS followers_count,
            (SELECT count(*) FROM user_follows f WHERE f.follower_id = u.id)::int AS following_count,
            (SELECT count(*) FROM playlists p WHERE p.owner_id = u.id AND p.visibility <> 'private')::int AS public_playlist_count
       FROM users u
       LEFT JOIN LATERAL (
         SELECT s.tier FROM subscriptions s
          WHERE s.user_id = u.id AND s.status IN ('active','trialing','past_due')
          ORDER BY s.created_at DESC LIMIT 1
       ) sub ON true
      WHERE u.username_key = d7_normalize_text(${uname}) AND u.status = 'active'`,
    q.values,
  );
  if (!row) return undefined;
  void viewer;
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: row.display_name ?? null,
    avatarUrl: row.avatar_url ?? null,
    bio: row.bio ?? null,
    role: row.role,
    tier: row.tier,
    followersCount: Number(row.followers_count ?? 0),
    followingCount: Number(row.following_count ?? 0),
    publicPlaylistCount: Number(row.public_playlist_count ?? 0),
    createdAt: map.iso(row.created_at),
  };
}

/* ---------------------------------- likes ---------------------------------- */

export async function setLikedTrack(db: Db, userId: string, trackId: string, liked: boolean, source?: string) {
  if (liked) {
    await db.execute(`INSERT INTO liked_tracks (user_id, track_id, source) VALUES ($1::uuid, $2::uuid, $3) ON CONFLICT DO NOTHING`, [userId, trackId, source ?? null]);
  } else {
    await db.execute(`DELETE FROM liked_tracks WHERE user_id = $1::uuid AND track_id = $2::uuid`, [userId, trackId]);
  }
  const artistId = await db.queryOne<{ primary_artist_id: string }>(`SELECT primary_artist_id FROM tracks WHERE id = $1::uuid`, [trackId]);
  if (liked && artistId?.primary_artist_id) {
    // Auto-follow on save is the single most effective discovery affordance we have.
    await db.execute(`INSERT INTO followed_artists (user_id, artist_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`, [userId, artistId.primary_artist_id]);
  }
  const count = await db.queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM liked_tracks WHERE track_id = $1::uuid`, [trackId]);
  return { liked, likedCount: Number(count?.c ?? 0) };
}

export async function isTrackLiked(db: Db, userId: string, trackId: string) {
  const row = await db.queryOne<{ e: boolean }>(`SELECT EXISTS(SELECT 1 FROM liked_tracks WHERE user_id = $1::uuid AND track_id = $2::uuid) AS e`, [userId, trackId]);
  return Boolean(row?.e);
}

export async function listLikedTrackIds(db: Db, userId: string, limit = 500) {
  const rows = await db.query<{ track_id: string }>(
    `SELECT track_id FROM liked_tracks WHERE user_id = $1::uuid ORDER BY created_at DESC LIMIT $2`,
    [userId, Math.min(limit, 2000)],
  );
  return rows.map((r) => String(r.track_id));
}

export async function setLikedAlbum(db: Db, userId: string, albumId: string, liked: boolean) {
  if (liked) await db.execute(`INSERT INTO liked_albums (user_id, album_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`, [userId, albumId]);
  else await db.execute(`DELETE FROM liked_albums WHERE user_id = $1::uuid AND album_id = $2::uuid`, [userId, albumId]);
  await db.execute(
    `UPDATE albums SET popularity = popularity + (SELECT count(*) FROM liked_albums WHERE album_id = $2::uuid) * 0.01 WHERE id = $2::uuid`,
    [userId, albumId],
  );
  return { liked };
}

/* -------------------------------- follows -------------------------------- */

export async function setArtistFollow(db: Db, userId: string, artistId: string, follow: boolean) {
  if (follow) await db.execute(`INSERT INTO followed_artists (user_id, artist_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`, [userId, artistId]);
  else await db.execute(`DELETE FROM followed_artists WHERE user_id = $1::uuid AND artist_id = $2::uuid`, [userId, artistId]);
  const count = await db.queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM followed_artists WHERE artist_id = $1::uuid`, [artistId]);
  await db.execute(`UPDATE artists SET followers_count = $2::int WHERE id = $1::uuid`, [artistId, Number(count?.c ?? 0)]);
  return { following: follow, followersCount: Number(count?.c ?? 0) };
}

export async function isFollowingArtist(db: Db, userId: string | null | undefined, artistId: string) {
  if (!userId) return false;
  const row = await db.queryOne<{ e: boolean }>(`SELECT EXISTS(SELECT 1 FROM followed_artists WHERE user_id = $1::uuid AND artist_id = $2::uuid) AS e`, [userId, artistId]);
  return Boolean(row?.e);
}

export async function listFollowedArtistIds(db: Db, userId: string, limit = 500) {
  const rows = await db.query<{ artist_id: string }>(
    `SELECT artist_id FROM followed_artists WHERE user_id = $1::uuid ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  );
  return rows.map((r) => String(r.artist_id));
}

export async function setUserFollow(db: Db, followerId: string, followeeId: string, follow: boolean) {
  if (followerId === followeeId) throw new Error('cannot follow yourself');
  if (follow) await db.execute(`INSERT INTO user_follows (follower_id, followee_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`, [followerId, followeeId]);
  else await db.execute(`DELETE FROM user_follows WHERE follower_id = $1::uuid AND followee_id = $2::uuid`, [followerId, followeeId]);
  return { following: follow };
}

/* ------------------------------ notifications ------------------------------ */

export interface NotificationRow {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  image_url: string | null;
  action_href: string | null;
  payload: Record<string, unknown>;
  created_at: string;
  read: boolean;
}

/** `dedupeKey` makes fan-out idempotent: a repeated sync never spams the inbox. */
export async function pushNotification(
  db: Db,
  input: { userId: string; kind: NotificationKind; title: string; body?: string | null; imageUrl?: string | null; actionHref?: string | null; payload?: Record<string, unknown>; dedupeKey?: string | null },
) {
  const res = await db.execute(
    `INSERT INTO notifications (id, user_id, kind, title, body, image_url, action_href, payload, dedupe_key, created_at)
     VALUES (d7_uuid(), $1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8, now())
     ON CONFLICT (user_id, dedupe_key) DO NOTHING`,
    [
      input.userId,
      input.kind,
      input.title,
      input.body ?? null,
      input.imageUrl ?? null,
      input.actionHref ?? null,
      JSON.stringify(input.payload ?? {}),
      input.dedupeKey ?? null,
    ],
  );
  return res > 0;
}

export async function listNotifications(db: Db, userId: string, opts: { limit?: number; unreadOnly?: boolean } = {}) {
  const rows = await db.query<Record<string, any>>(
    `SELECT id, kind, title, body, image_url, action_href, payload, created_at::text, (read_at IS NOT NULL) AS read
       FROM notifications
      WHERE user_id = $1::uuid ${opts.unreadOnly ? 'AND read_at IS NULL' : ''}
      ORDER BY created_at DESC LIMIT $2`,
    [userId, opts.limit ?? 30],
  );
  return rows.map((r) => ({
    id: String(r.id),
    kind: r.kind,
    title: r.title,
    body: r.body ?? null,
    image_url: r.image_url ?? null,
    action_href: r.action_href ?? null,
    payload: map.obj<Record<string, unknown>>(r.payload, {}),
    created_at: map.iso(r.created_at),
    read: Boolean(r.read),
  })) as NotificationRow[];
}

export async function unreadCount(db: Db, userId: string) {
  const row = await db.queryOne<{ c: number }>(`SELECT count(*)::int AS c FROM notifications WHERE user_id = $1::uuid AND read_at IS NULL`, [userId]);
  return Number(row?.c ?? 0);
}

export async function markNotificationsRead(db: Db, userId: string, ids?: string[]) {
  if (ids?.length) {
    return db.execute(`UPDATE notifications SET read_at = now() WHERE user_id = $1::uuid AND id = ANY($2::uuid[]) AND read_at IS NULL`, [userId, ids]);
  }
  return db.execute(`UPDATE notifications SET read_at = now() WHERE user_id = $1::uuid AND read_at IS NULL`, [userId]);
}
