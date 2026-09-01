/**
 * Admin routes (spec §15): sync controls, catalogue moderation, licence decisions, reports,
 * user status and claim approvals. Everything here is `requireRole('admin')` — no exceptions,
 * including the read-only views, because the numbers are business-sensitive.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '@d7/config';
import {
  getAdminCoreStats,
  getProviderStatusRows,
  getSyncStatus,
  listCatalogForAdmin,
  listPendingClaims,
  listRecentRuns,
  listReportedContent,
  listUsersForAdmin,
  markTrending,
  rebuildSearchIndex,
  resolveClaim,
  setAlbumStatus,
  setTrackLicense,
  setUserStatus,
  updateContentReport,
  pushNotification,
} from '@d7/database';
import { ApiError, boolField, guardRate, idSchema, intField, listField, parseBody } from '../lib/http.js';

export default async function adminRoutes(app: FastifyInstance) {
  const db = () => app.d7.db;

  app.get('/api/admin/overview', async (request) => {
    await request.requireRole('admin');
    const [stats, providers, sync, queue, reports] = await Promise.all([
      getAdminCoreStats(db()),
      getProviderStatusRows(db()),
      getSyncStatus(db(), env.RELEASE_SYNC_INTERVAL_MIN),
      app.d7.queue.stats(),
      db().queryOne<{ open: number; total: number }>(`SELECT count(*) FILTER (WHERE status = 'open')::int AS open, count(*)::int AS total FROM content_reports`),
    ]);
    return {
      ...stats,
      providers,
      sync: { ...sync, enabled: env.RELEASE_SYNC_ENABLED, everyMinutes: env.RELEASE_SYNC_INTERVAL_MIN },
      queue: { driver: app.d7.queue.driver, ...queue },
      reports: { open: Number(reports?.open ?? 0), total: Number(reports?.total ?? 0) },
      storage: { driver: app.d7.storage.name, audioProvider: app.d7.providers.audio.name },
      cache: { driver: app.d7.cache.driver },
    };
  });

  /* ---------------------------------- sync ---------------------------------- */

  app.post('/api/admin/sync', async (request, reply) => {
    await request.requireRole('admin');
    await guardRate(app, request, reply, { bucket: 'admin:sync', limit: 6, windowSec: 600, message: 'A sync is already scheduled; give it a minute.' });
    const body = parseBody(
      z.object({
        provider: z.string().max(40).optional(),
        lookbackDays: z.number().int().min(1).max(3650).optional(),
        maxAlbums: z.number().int().min(1).max(500).optional(),
        indexOnly: z.boolean().optional(),
      }),
      request.body ?? {},
    );
    const result = await app.d7.releaseSync.runOnce({
      provider: body.provider,
      lookbackDays: body.lookbackDays,
      maxAlbums: body.maxAlbums,
      indexOnly: body.indexOnly,
      triggeredBy: 'api',
      requestedBy: (await request.requireRole('admin')).id,
    });
    app.d7.log.info('manual sync run finished', { status: result.status, inserted: result.insertedTracks + result.insertedAlbums });
    return { run: result };
  });

  app.get('/api/admin/sync-runs', async (request) => {
    await request.requireRole('admin');
    const provider = (request.query as { provider?: string }).provider;
    return { runs: await listRecentRuns(db(), provider, intField((request.query as { limit?: string }).limit, 20, 1, 100)) };
  });

  app.get('/api/admin/providers', async (request) => {
    await request.requireRole('admin');
    const rows = await getProviderStatusRows(db());
    const health = await Promise.all(
      app.d7.providers.descriptors.map(async (d) => {
        let probe: { ok: boolean; latencyMs: number; message?: string } | null = null;
        try {
          const provider = d.kind === 'audio' ? app.d7.providers.audio : (app.d7.providers.metadata as { name: string; healthCheck: () => Promise<{ ok: boolean; latencyMs: number; message?: string }> }[]).find((m) => m.name === d.name);
          probe = provider ? await provider.healthCheck() : null;
        } catch (err) {
          probe = { ok: false, latencyMs: 0, message: (err as Error).message };
        }
        return { ...d, probe };
      }),
    );
    return { rows, descriptors: health, summary: app.d7.providers.summary };
  });

  app.post('/api/admin/sync/album', async (request, reply) => {
    await request.requireRole('admin');
    const body = parseBody(z.object({ provider: z.string().min(2).max(40), providerAlbumId: z.string().min(1).max(120), defer: z.boolean().optional() }), request.body);
    if (body.defer) {
      await app.d7.queue.add('album_import', { provider: body.provider, providerAlbumId: body.providerAlbumId }, { provider: body.provider });
      return reply.code(202).send({ queued: true });
    }
    const result = await app.d7.releaseSync.importByProviderAlbumId(body.provider, body.providerAlbumId);
    return { imported: result };
  });

  app.post('/api/admin/trending/refresh', async (request) => {
    await request.requireRole('admin');
    const limit = intField((request.query as { limit?: string }).limit, 25, 5, 100);
    await app.d7.releaseSync.refreshTrending(limit);
    return { refreshed: limit };
  });

  app.post('/api/admin/reindex', async (request, reply) => {
    await request.requireRole('admin');
    await guardRate(app, request, reply, { bucket: 'admin:reindex', limit: 2, windowSec: 600, message: 'Reindexing is heavy; one at a time.' });
    const result = await rebuildSearchIndex(db());
    const version = await app.d7.cache.incr('catalog_version');
    return { ...result, catalogVersion: version };
  });

  /* -------------------------------- catalogue -------------------------------- */

  app.get('/api/admin/catalog', async (request) => {
    await request.requireRole('admin');
    const query = request.query as Record<string, string | undefined>;
    const type = (['tracks', 'albums', 'artists'] as const).includes(String(query.type) as 'tracks') ? (String(query.type) as 'tracks' | 'albums' | 'artists') : 'tracks';
    return {
      items: await listCatalogForAdmin(db(), {
        type,
        q: query.q,
        status: query.status,
        license: query.license,
        limit: intField(query.limit, 25, 1, 100),
        offset: intField(query.offset, 0, 0, 5000),
      }),
    };
  });

  app.patch('/api/admin/tracks/:id', async (request) => {
    const admin = await request.requireRole('admin');
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const body = parseBody(
      z.object({
        licenseStatus: z.enum(['unlicensed', 'pending_review', 'licensed', 'rejected', 'expired']).optional(),
        status: z.enum(['draft', 'submitted', 'approved', 'rejected', 'scheduled', 'published']).optional(),
        streamable: z.boolean().optional(),
        note: z.string().max(500).optional(),
        trending: z.boolean().optional(),
      }),
      request.body,
    );
    const updated = await setTrackLicense(db(), id, {
      licenseStatus: body.licenseStatus,
      status: body.status,
      streamable: body.streamable,
      note: body.note,
      by: admin.id,
    });
    if (body.trending !== undefined) {
      // "Trending" is an album-level flag in this schema, so it moves to the parent release.
      const parent = await db().queryOne<{ album_id: string }>(`SELECT album_id::text FROM tracks WHERE id = $1::uuid`, [id]);
      if (parent) await markTrending(db(), [parent.album_id], body.trending);
    }
    // Any visibility change must invalidate both the search doc and cached home pages.
    const { touchSearchDocument } = await import('@d7/database');
    await touchSearchDocument(db(), 'track', id);
    await app.d7.cache.incr('catalog_version');
    return { updated, note: 'Cached home and search responses expire with the catalog version bump.' };
  });

  app.patch('/api/admin/albums/:id', async (request) => {
    await request.requireRole('admin');
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const body = parseBody(
      z.object({
        status: z.enum(['draft', 'submitted', 'approved', 'rejected', 'scheduled', 'published']).optional(),
        licenseStatus: z.enum(['unlicensed', 'pending_review', 'licensed', 'rejected', 'expired']).optional(),
        streamable: z.boolean().optional(),
      }),
      request.body,
    );
    const updated = await setAlbumStatus(db(), id, body);
    const { touchSearchDocument } = await import('@d7/database');
    await touchSearchDocument(db(), 'album', id);
    await app.d7.cache.incr('catalog_version');
    return { updated };
  });

  /* --------------------------------- reports --------------------------------- */

  app.get('/api/admin/reports', async (request) => {
    await request.requireRole('admin');
    const query = request.query as Record<string, string | undefined>;
    return { reports: await listReportedContent(db(), { status: query.status, limit: intField(query.limit, 50, 1, 200) }) };
  });

  app.patch('/api/admin/reports/:id', async (request) => {
    const admin = await request.requireRole('admin');
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const body = parseBody(z.object({ status: z.enum(['open', 'reviewing', 'actioned', 'dismissed']), resolution: z.string().max(600).optional() }), request.body);
    const ok = await updateContentReport(db(), id, { status: body.status, resolution: body.resolution ?? null, by: admin.id });
    if (!ok) throw ApiError.notFound('Report');
    return { updated: true };
  });

  /* ---------------------------------- users ---------------------------------- */

  app.get('/api/admin/users', async (request) => {
    await request.requireRole('admin');
    const query = request.query as Record<string, string | undefined>;
    return {
      users: await listUsersForAdmin(db(), { q: query.q, limit: intField(query.limit, 25, 1, 100), offset: intField(query.offset, 0, 0, 5000) }),
    };
  });

  app.patch('/api/admin/users/:id', async (request) => {
    const admin = await request.requireRole('admin');
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const body = parseBody(
      z.object({
        status: z.enum(['active', 'suspended', 'deleted']).optional(),
        role: z.enum(['listener', 'artist', 'admin']).optional(),
        tier: z.enum(['free', 'premium']).optional(),
        notify: z.string().max(400).optional(),
      }),
      request.body,
    );
    if (id === admin.id && body.status && body.status !== 'active') throw ApiError.badRequest('You cannot suspend your own account.', [{ path: 'status', message: 'Refusing to lock you out' }]);
    if (body.status) await setUserStatus(db(), id, body.status);
    if (body.role) {
      const { updateUser } = await import('@d7/database');
      await updateUser(db(), id, { role: body.role });
    }
    if (body.tier) {
      const { changeTier } = await import('@d7/database');
      await changeTier(db(), id, body.tier, { provider: 'manual', reference: `admin:${admin.id}`, months: body.tier === 'premium' ? 12 : undefined });
    }
    if (body.status === 'suspended') {
      // Live sessions are revoked too, otherwise suspension only applies at next login.
      await db().execute(`UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1::uuid AND revoked_at IS NULL`, [id]);
    }
    if (body.notify) {
      await pushNotification(db(), { userId: id, kind: 'system', title: 'A moderator updated your account', body: body.notify, actionHref: '/settings', dedupeKey: `admin:note:${id}:${Date.now()}` });
    }
    return { updated: true, revokedSessions: body.status === 'suspended' };
  });

  /* --------------------------------- claims --------------------------------- */

  app.get('/api/admin/claims', async (request) => {
    await request.requireRole('admin');
    return { claims: await listPendingClaims(db(), intField((request.query as { limit?: string }).limit, 50, 1, 200)) };
  });

  app.post('/api/admin/claims/:id', async (request) => {
    const admin = await request.requireRole('admin');
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const body = parseBody(z.object({ approve: z.boolean(), note: z.string().max(500).optional() }), request.body);
    const result = await resolveClaim(db(), { claimId: id, adminId: admin.id, approve: body.approve, note: body.note ?? null });
    if (!result.ok) throw ApiError.notFound(result.error);
    const claim = await db().queryOne<{ user_id: string }>(`SELECT user_id::text FROM artist_claims WHERE id = $1::uuid`, [id]);
    if (claim) {
      await pushNotification(db(), {
        userId: claim.user_id,
        kind: body.approve ? 'claim_approved' : 'claim_denied',
        title: body.approve ? 'Your artist claim was approved' : 'Your artist claim was declined',
        body: body.approve ? 'You can now upload and edit releases for that artist.' : (body.note ?? 'Reply in your dashboard if you believe this is a mistake.'),
        actionHref: '/creator',
        dedupeKey: `claim:${id}:${body.approve ? 'ok' : 'no'}`,
      });
    }
    return { resolved: true, approved: body.approve, artistId: result.artistId };
  });

  /* ------------------------------- moderation ops ------------------------------- */

  app.post('/api/admin/notify', async (request) => {
    await request.requireRole('admin');
    const body = parseBody(
      z.object({ userIds: z.array(idSchema).max(500).optional(), allPremium: z.boolean().optional(), title: z.string().min(3).max(120), body: z.string().max(600), actionHref: z.string().max(200).optional() }),
      request.body,
    );
    let targets = body.userIds ?? [];
    if (body.allPremium) {
      targets = await db()
        .query<{ user_id: string }>(
          `SELECT s.user_id FROM subscriptions s WHERE s.tier = 'premium' AND (s.current_period_end IS NULL OR s.current_period_end > now()) LIMIT 2000`,
        )
        .then((r) => r.map((x) => String(x.user_id)));
    }
    if (!targets.length) throw ApiError.badRequest('No recipients given.', [{ path: 'userIds', message: 'Provide ids or allPremium' }]);
    let sent = 0;
    for (const userId of targets) {
      const ok = await app.d7.notifications.system({ userId, title: body.title, body: body.body, actionHref: body.actionHref, dedupeKey: `admin:broadcast:${Date.now()}:${userId}` });
      if (ok) sent += 1;
    }
    return { sent, recipients: targets.length, idempotent: 'dedupe_key per user per minute' };
  });

  app.get('/api/admin/queue', async (request) => {
    await request.requireRole('admin');
    const stats = await app.d7.queue.stats();
    const runs = await listRecentRuns(db(), undefined, 5);
    return { driver: app.d7.queue.driver, ...stats, recentRuns: runs.map((r) => ({ id: r.id, status: r.status, provider: r.provider, startedAt: r.startedAt, errors: r.errors.length })) };
  });

  app.delete('/api/admin/cache', async (request) => {
    await request.requireRole('admin');
    await app.d7.cache.clearNamespace();
    const version = await app.d7.cache.incr('catalog_version');
    return {
      cleared: true,
      catalogVersion: version,
      note: boolField((request.query as { all?: string }).all) ? 'The memory driver flushes everything; Redis keeps other namespaces intact.' : 'Cache entries are keyed by catalog version, so the bump alone invalidates HTTP caches.',
    };
  });
}
