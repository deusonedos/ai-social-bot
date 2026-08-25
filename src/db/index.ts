import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { env } from '../config/env.js';
import type { StoredMessage } from '../core/types.js';
import { logger } from '../util/logger.js';

const here = dirname(fileURLToPath(import.meta.url));

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

export async function migrate(): Promise<void> {
  const sql = await readFile(join(here, 'schema.sql'), 'utf8');
  await pool.query(sql);
  logger.info('схема БД применена');
}

export async function getOrCreateConversation(params: {
  conversationKey: string;
  platform: string;
  chatId: string;
  threadId?: string;
}): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO conversations (conversation_key, platform, chat_id, thread_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (conversation_key)
       DO UPDATE SET updated_at = now()
     RETURNING id`,
    [params.conversationKey, params.platform, params.chatId, params.threadId ?? null],
  );
  return Number(rows[0]!.id);
}

export async function saveMessage(params: {
  conversationId: number;
  platformUserId: string | null;
  userName: string | null;
  role: 'user' | 'assistant';
  content: string;
  hasMedia?: boolean;
  model?: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO messages (conversation_id, platform_user_id, user_name, role, content, has_media, model)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      params.conversationId,
      params.platformUserId,
      params.userName,
      params.role,
      params.content,
      params.hasMedia ?? false,
      params.model ?? null,
    ],
  );
}

/**
 * История ТОЛЬКО этого разговора. Единственная точка чтения истории —
 * фильтр по conversation_id здесь обязателен и не параметризуется.
 */
export async function getRecentMessages(conversationId: number, limit: number): Promise<StoredMessage[]> {
  const { rows } = await pool.query<{
    role: 'user' | 'assistant';
    user_name: string | null;
    content: string;
    created_at: Date;
  }>(
    `SELECT role, user_name, content, created_at
       FROM messages
      WHERE conversation_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [conversationId, limit],
  );

  return rows
    .map((r) => ({ role: r.role, userName: r.user_name, content: r.content, createdAt: r.created_at }))
    .reverse();
}

export async function getSummary(conversationId: number): Promise<string | null> {
  const { rows } = await pool.query<{ summary: string }>(
    'SELECT summary FROM summaries WHERE conversation_id = $1',
    [conversationId],
  );
  return rows[0]?.summary ?? null;
}

export async function upsertSummary(conversationId: number, summary: string): Promise<void> {
  await pool.query(
    `INSERT INTO summaries (conversation_id, summary, covered_until_msg_id, updated_at)
     VALUES ($1, $2, COALESCE((SELECT MAX(id) FROM messages WHERE conversation_id = $1), 0), now())
     ON CONFLICT (conversation_id)
       DO UPDATE SET summary = EXCLUDED.summary,
                     covered_until_msg_id = EXCLUDED.covered_until_msg_id,
                     updated_at = now()`,
    [conversationId, summary],
  );
}

export async function clearConversation(conversationId: number): Promise<void> {
  await pool.query('DELETE FROM messages WHERE conversation_id = $1', [conversationId]);
  await pool.query('DELETE FROM summaries WHERE conversation_id = $1', [conversationId]);
}

export async function logUsage(params: {
  conversationId: number | null;
  model: string;
  roleName: string;
  inputTokens: number;
  outputTokens: number;
}): Promise<void> {
  await pool.query(
    `INSERT INTO usage_log (conversation_id, model, role_name, input_tokens, output_tokens)
     VALUES ($1, $2, $3, $4, $5)`,
    [params.conversationId, params.model, params.roleName, params.inputTokens, params.outputTokens],
  );
}

/**
 * true — апдейт новый и его надо обработать; false — это повтор.
 * Telegram переприсылает апдейты при таймауте вебхука, а бесплатные модели
 * отвечают медленно, так что повторы будут регулярно.
 */
export async function claimUpdate(platform: string, updateId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO processed_updates (platform, update_id)
     VALUES ($1, $2)
     ON CONFLICT (platform, update_id) DO NOTHING`,
    [platform, updateId],
  );
  return rowCount === 1;
}

export async function pruneProcessedUpdates(): Promise<void> {
  await pool.query("DELETE FROM processed_updates WHERE processed_at < now() - INTERVAL '2 days'");
}

export const quotaTracker = {
  async used(): Promise<number> {
    const { rows } = await pool.query<{ free_calls: number }>(
      "SELECT free_calls FROM quota_usage WHERE day = (now() AT TIME ZONE 'utc')::date",
    );
    return rows[0]?.free_calls ?? 0;
  },

  async increment(): Promise<void> {
    await pool.query(
      `INSERT INTO quota_usage (day, free_calls)
       VALUES ((now() AT TIME ZONE 'utc')::date, 1)
       ON CONFLICT (day) DO UPDATE SET free_calls = quota_usage.free_calls + 1`,
    );
  },
};
