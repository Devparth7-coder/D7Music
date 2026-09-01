/**
 * Notification fan-out (spec §13).
 *
 * Delivery is DB-backed (an inbox table) rather than push: the client polls the
 * unread badge. Every fan-out carries a deterministic `dedupeKey`, so replaying a
 * sync run — which is expected, idempotent behaviour here — cannot spam inboxes.
 */
import type { Db } from '@d7/database';
import { pushNotification, map } from '@d7/database';
import type { NotificationKind } from '@d7/types';

export interface NotificationDeps {
  db: Db;
  /** Max recipients per release fan-out (safety valve for large followings). */
  maxRecipients?: number;
  log?: (level: 'info' | 'warn', msg: string, meta?: Record<string, unknown>) => void;
}

export class NotificationService {
  constructor(private readonly deps: NotificationDeps) {}

  /** Called by ReleaseSyncService whenever a followed artist publishes something new. */
  async notifyNewReleases(input: {
    albumId: string;
    artistId: string;
    title: string;
    imageUrl: string | null;
    trackCount: number;
    isSingle: boolean;
  }): Promise<{ usersNotified: number }> {
    const { db } = this.deps;
    const cap = Math.min(this.deps.maxRecipients ?? 5000, 20_000);
    const followers = await db.query<{ user_id: string }>(
      `SELECT fa.user_id FROM followed_artists fa
         JOIN user_preferences up ON up.user_id = fa.user_id
        WHERE fa.artist_id = $1::uuid AND up.notify_followed_artists = true
        LIMIT ${cap}`,
      [input.artistId],
    );
    const kind: NotificationKind = 'artist_new_release';
    const what = input.isSingle ? 'a new single' : `a new ${input.trackCount > 4 ? 'album' : 'release'}`;
    let sent = 0;
    for (const f of followers) {
      const ok = await pushNotification(db, {
        userId: String(f.user_id),
        kind,
        title: `${input.title} just dropped`,
        body: `An artist you follow released ${what}.`,
        imageUrl: input.imageUrl,
        actionHref: `/album/${input.albumId}`,
        payload: { albumId: input.albumId, artistId: input.artistId, trackCount: input.trackCount },
        // One notification per (album, kind): sync replays are absorbed here.
        dedupeKey: `${kind}:${input.albumId}`,
      });
      if (ok) sent += 1;
    }
    if (sent) {
      await db.execute(`UPDATE new_releases SET notified_count = notified_count + $2::int WHERE entity_type='album' AND entity_id = $1::uuid`, [
        input.albumId,
        sent,
      ]);
      await db.execute(
        `UPDATE followed_artists SET notified = true WHERE artist_id = $1::uuid`,
        [input.artistId],
      );
    }
    this.deps.log?.('info', 'release notifications sent', { albumId: input.albumId, recipients: sent });
    return { usersNotified: sent };
  }

  /** Collaborative playlist change → everyone except the actor. */
  async notifyPlaylistChange(input: { playlistId: string; title: string; actorId: string | null; action: 'add' | 'remove' | 'reorder' | 'rename' | 'artwork' | 'visibility'; trackTitle?: string | null }): Promise<{ usersNotified: number }> {
    const { db } = this.deps;
    const audience = await db.query<{ user_id: string }>(
      `SELECT DISTINCT u.user_id FROM (
         SELECT owner_id AS user_id FROM playlists WHERE id = $1::uuid AND collaborative
         UNION SELECT user_id FROM playlist_collaborators WHERE playlist_id = $1::uuid AND status = 'accepted' AND permission IN ('edit','manage')
       ) u WHERE u.user_id IS NOT NULL AND u.user_id::text <> $2::text`,
      [input.playlistId, input.actorId ?? ''],
    );
    const verb =
      input.action === 'add'
        ? `added ${input.trackTitle ?? 'a track'}`
        : input.action === 'remove'
          ? `removed ${input.trackTitle ?? 'a track'}`
          : input.action === 'reorder'
            ? 'reordered the queue'
            : `updated ${input.action}`;
    let sent = 0;
    for (const a of audience) {
      const ok = await pushNotification(db, {
        userId: String(a.user_id),
        kind: 'collab_change',
        title: input.title,
        body: `A collaborator ${verb}.`,
        actionHref: `/playlist/${input.playlistId}`,
        payload: { playlistId: input.playlistId, action: input.action },
        // Coarse dedupe key: many edits in one session collapse into one inbox item.
        dedupeKey: `collab:${input.playlistId}:${input.action}:${Math.floor(Date.now() / 3_600_000)}`,
      });
      if (ok) sent += 1;
    }
    await db.execute(
      `INSERT INTO playlist_edit_events (id, playlist_id, actor_id, action, created_at)
       VALUES (d7_uuid(), $1::uuid, $2::uuid, $3, now()) ON CONFLICT DO NOTHING`,
      [input.playlistId, input.actorId ?? null, input.action],
    ).catch(() => undefined);
    return { usersNotified: sent };
  }

  /** Weekly-style "new songs picked for you" digest. */
  async notifyRecommendations(input: { userId: string; trackCount: number; topGenre?: string | null }): Promise<boolean> {
    if (input.trackCount < 3) return false;
    return pushNotification(this.deps.db, {
      userId: input.userId,
      kind: 'recommendation',
      title: 'Fresh picks are ready',
      body: `${input.trackCount} new tracks matched to what you have been playing${input.topGenre ? `, mostly ${input.topGenre}` : ''}.`,
      actionHref: '/collection/made-for-you',
      payload: { trackCount: input.trackCount },
      dedupeKey: `recommendation:${input.userId}:${new Date().toISOString().slice(0, 10)}`,
    });
  }

  async system(input: { userId: string; title: string; body: string; actionHref?: string; dedupeKey?: string }) {
    return pushNotification(this.deps.db, {
      userId: input.userId,
      kind: 'system',
      title: input.title,
      body: input.body,
      actionHref: input.actionHref ?? null,
      dedupeKey: input.dedupeKey ?? null,
    });
  }

  async badge(userId: string) {
    const row = await this.deps.db.queryOne<{ c: number }>(
      `SELECT count(*)::int AS c FROM notifications WHERE user_id = $1::uuid AND read_at IS NULL`,
      [userId],
    );
    return Number(row?.c ?? 0);
  }
}

export function createNotificationService(deps: NotificationDeps) {
  return new NotificationService(deps);
}

export { map };
