/**
 * AI music assistant routes (spec §13).
 *
 * The endpoint always answers with which engine produced the result (`rule_based`, `llm` or
 * `hybrid`) and how many of today's requests are left, because a silent fallback to a keyword
 * matcher would be indistinguishable from a broken model.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '@d7/config';
import { ensureConversation, listConversation, listConversations } from '@d7/database';
import { ApiError, guardRate, idSchema, intField, parseBody } from '../lib/http.js';
import { hydrateTracks } from '../lib/media.js';

export default async function assistantRoutes(app: FastifyInstance) {
  const db = () => app.d7.db;

  const askSchema = z.object({
    prompt: z.string().trim().min(3, 'Tell me what you feel like hearing.').max(500),
    conversationId: z.string().uuid().nullable().optional(),
    createPlaylist: z.boolean().optional(),
    playlistTitle: z.string().max(80).optional(),
    visibility: z.enum(['private', 'public']).optional(),
    excludeExplicit: z.boolean().optional(),
    limit: z.number().int().min(3).max(50).optional(),
    seedTrackId: z.string().uuid().nullable().optional(),
  });

  app.post('/api/assistant', async (request, reply) => {
    const body = parseBody(askSchema, request.body);
    const user = await request.optionalUser();
    await guardRate(app, request, reply, {
      bucket: 'assistant',
      limit: env.RATE_LIMIT_ASSISTANT,
      message: 'The assistant has a per-minute ceiling so one listener cannot exhaust the model budget.',
    });

    const tier = user?.subscription?.tier === 'premium' ? 'premium' : 'free';
    const limit = tier === 'premium' ? env.ASSISTANT_DAILY_LIMIT_PREMIUM : env.ASSISTANT_DAILY_LIMIT_FREE;
    // Read-only pre-check: `ask()` performs the authoritative increment, so this only exists
    // to answer early instead of paying for a retrieval the user cannot use.
    const before = user ? await readUsage(db(), user.id) : null;
    if (before !== null && before >= limit) {
      return reply.code(429).send({
        error: {
          code: 'ASSISTANT_QUOTA',
          message: `You have used all ${limit} assistant requests for today.`,
          requestId: request.id,
          details: [{ path: '', message: tier === 'free' ? 'Premium removes the daily limit.' : 'It resets at midnight UTC.' }],
        },
      });
    }

    const response = await app.d7.assistant.ask({
      prompt: body.prompt,
      viewerId: user?.id ?? null,
      tier,
      conversationId: body.conversationId ?? null,
      createPlaylist: user ? body.createPlaylist : false,
      playlistTitle: body.playlistTitle ?? null,
      visibility: body.visibility ?? 'private',
      seedTrackId: body.seedTrackId ?? null,
      excludeExplicit: body.excludeExplicit ?? (user ? user.preferences.explicitFilter : false),
    });

    const tracks = await hydrateTracks(app, response.tracks, user);
    const used = (before ?? 0) + 1;
    const usage = user ? { used, remaining: Math.max(0, limit - used), limit } : null;

    reply.header('cache-control', 'no-store');
    return {
      ...response,
      tracks,
      usage: usage ?? { used: null, remaining: null, limit, note: 'Sign in to see your daily allowance.' },
      llmConfigured: Boolean(env.LLM_BASE_URL && env.LLM_API_KEY),
      model: response.model,
      engine: response.engine,
    };
  });

  app.get('/api/assistant/conversations', async (request) => {
    const user = await request.requireUser();
    return { conversations: await listConversations(db(), user.id, intField((request.query as { limit?: string }).limit, 20, 1, 50)) };
  });

  app.get('/api/assistant/conversations/:id', async (request) => {
    const user = await request.requireUser();
    const { id } = parseBody(z.object({ id: idSchema }), request.params as { id: string });
    const owner = await db().queryOne<{ user_id: string }>(`SELECT user_id::text FROM assistant_conversations WHERE id = $1::uuid`, [id]);
    if (!owner) throw ApiError.notFound('Conversation');
    if (owner.user_id !== user.id && user.role !== 'admin') throw ApiError.forbidden('This conversation belongs to someone else.', 'NOT_CONVERSATION_OWNER');
    return { conversationId: id, messages: await listConversation(db(), id, 100) };
  });

  app.post('/api/assistant/conversations', async (request) => {
    const user = await request.requireUser();
    const body = parseBody(z.object({ title: z.string().max(120).optional() }), request.body ?? {});
    const id = await ensureConversation(db(), null, user.id, body.title ?? 'New conversation');
    return { conversationId: id };
  });

  app.get('/api/assistant/usage', async (request) => {
    const user = await request.requireUser();
    const limit = user.subscription?.tier === 'premium' ? env.ASSISTANT_DAILY_LIMIT_PREMIUM : env.ASSISTANT_DAILY_LIMIT_FREE;
    const used = await readUsage(db(), user.id);
    return { used, remaining: Math.max(0, limit - used), limit, tier: user.subscription?.tier ?? 'free', llmConfigured: Boolean(env.LLM_BASE_URL && env.LLM_API_KEY) };
  });
}

/** Today's counter from `assistant_usage`, the same row `readAndIncrementUsage()` writes. */
async function readUsage(db: import('@d7/database').Db, userId: string) {
  const row = await db.queryOne<{ requests: number }>(
    `SELECT requests FROM assistant_usage WHERE user_id = $1::uuid AND day = (now() at time zone 'utc')::date`,
    [userId],
  );
  return Number(row?.requests ?? 0);
}
