/** AI assistant persistence: conversations, per-user daily quota (spec §10, §19). */
import type { Db } from './client.js';

export async function ensureConversation(db: Db, conversationId: string | null | undefined, userId: string | null, title: string) {
  if (conversationId) {
    const exists = await db.queryOne<{ id: string }>(`SELECT id FROM assistant_conversations WHERE id = $1::uuid`, [conversationId]);
    if (exists) {
      await db.execute(`UPDATE assistant_conversations SET updated_at = now() WHERE id = $1::uuid`, [conversationId]);
      return exists.id;
    }
  }
  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO assistant_conversations (id, user_id, title, created_at, updated_at)
     VALUES (coalesce($1::uuid, d7_uuid()), $2::uuid, $3, now(), now()) RETURNING id`,
    [conversationId ?? null, userId, title.slice(0, 120)],
  );
  return String(row!.id);
}

export async function appendMessage(
  db: Db,
  input: {
    conversationId: string;
    role: 'user' | 'assistant';
    content: string;
    parsedQuery?: unknown;
    engine?: string;
    model?: string | null;
    trackIds?: string[];
    rejected?: unknown;
    playlistId?: string | null;
  },
) {
  const row = await db.queryOne<{ id: string }>(
    `INSERT INTO assistant_messages (id, conversation_id, role, content, parsed_query, engine, model, track_ids, rejected, playlist_id, created_at)
     VALUES (d7_uuid(), $1::uuid, $2, $3, $4::jsonb, $5, $6, $7::uuid[], $8::jsonb, $9::uuid, now()) RETURNING id`,
    [
      input.conversationId,
      input.role,
      input.content,
      input.parsedQuery ? JSON.stringify(input.parsedQuery) : null,
      input.engine ?? null,
      input.model ?? null,
      input.trackIds ?? [],
      JSON.stringify(input.rejected ?? []),
      input.playlistId ?? null,
    ],
  );
  await db.execute(`UPDATE assistant_conversations SET updated_at = now() WHERE id = $1::uuid`, [input.conversationId]);
  return String(row!.id);
}

export async function listConversation(db: Db, conversationId: string, limit = 50) {
  return db.query<Record<string, any>>(
    `SELECT id, role, content, created_at::text, parsed_query, engine, model, track_ids, playlist_id
       FROM assistant_messages WHERE conversation_id = $1::uuid ORDER BY created_at ASC LIMIT $2`,
    [conversationId, limit],
  );
}

export async function listConversations(db: Db, userId: string, limit = 20) {
  return db.query(
    `SELECT c.id, c.title, c.updated_at::text,
            (SELECT count(*) FROM assistant_messages m WHERE m.conversation_id = c.id)::int AS message_count
       FROM assistant_conversations c WHERE c.user_id = $1::uuid ORDER BY c.updated_at DESC LIMIT $2`,
    [userId, limit],
  );
}

/**
 * Counts today's requests and answers whether one more is allowed. `limit` is only used to
 * compute `remaining` — the SQL must bind exactly one parameter (the user id).
 */
export async function readAndIncrementUsage(db: Db, userId: string, limit: number): Promise<{ used: number; remaining: number; allowed: boolean }> {
  const row = await db.queryOne<{ requests: number }>(
    `INSERT INTO assistant_usage (user_id, day, requests) VALUES ($1::uuid, now()::date, 1)
     ON CONFLICT (user_id, day) DO UPDATE SET requests = assistant_usage.requests + 1
     RETURNING requests`,
    [userId],
  );
  const used = Number(row?.requests ?? 1);
  return { used, remaining: Math.max(0, limit - used), allowed: used <= limit };
}
