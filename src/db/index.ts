import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { env } from '../config/env.js';
import type { StoredMessage } from '../core/types.js';
import { logger } from '../util/logger.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Пул создаётся на уровне модуля, чтобы «тёплые» вызовы Vercel переиспользовали
 * соединение вместо того, чтобы открывать новое на каждый запрос.
 *
 * max: 1 — сознательно. В serverless параллельные запросы разъезжаются по разным
 * инстансам функции, поэтому большой локальный пул не помогает, а суммарно по всем
 * инстансам легко исчерпать лимит соединений Supabase.
 *
 * Про transaction pooler (порт 6543): он не поддерживает именованные prepared
 * statements. node-postgres их не использует, пока в запрос не передан `name`, —
 * мы этого нигде не делаем, поэтому драйвер совместим как есть.
 */
export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  max: env.SERVERLESS ? 1 : 10,
  idleTimeoutMillis: env.SERVERLESS ? 10_000 : 30_000,
  connectionTimeoutMillis: 10_000,
});

// Оборванное соединение к пулеру не должно ронять процесс.
pool.on('error', (err) => logger.warn({ err }, 'ошибка соединения с БД в пуле'));

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

/**
 * Увеличивает счётчик в минутном окне и возвращает новое значение.
 * Одним запросом — важно, потому что вызывается на каждое сообщение.
 */
export async function bumpRateCounter(bucketKey: string): Promise<number> {
  const { rows } = await pool.query<{ hits: number }>(
    `INSERT INTO rate_counters (bucket_key, window_start, hits)
     VALUES ($1, date_trunc('minute', now()), 1)
     ON CONFLICT (bucket_key, window_start)
       DO UPDATE SET hits = rate_counters.hits + 1
     RETURNING hits`,
    [bucketKey],
  );
  return rows[0]!.hits;
}

/** Откат счётчика: запрос отменили, слот занимать не нужно. */
export async function releaseRateCounter(bucketKey: string): Promise<void> {
  await pool.query(
    `UPDATE rate_counters SET hits = GREATEST(hits - 1, 0)
      WHERE bucket_key = $1 AND window_start = date_trunc('minute', now())`,
    [bucketKey],
  );
}

export async function pruneRateCounters(): Promise<void> {
  await pool.query("DELETE FROM rate_counters WHERE window_start < now() - INTERVAL '1 hour'");
}

export interface ModelHealth {
  modelId: string;
  failures: number;
  openUntil: Date | null;
  dead: boolean;
}

/**
 * Все нездоровые модели одним запросом.
 *
 * Читаем разом, а не по модели: иначе на каждый вызов цепочки приходился бы
 * отдельный поход в базу, и фолбэк стал бы дороже самого запроса к модели.
 */
export async function getUnhealthyModels(): Promise<Map<string, ModelHealth>> {
  const { rows } = await pool.query<{
    model_id: string;
    failures: number;
    open_until: Date | null;
    dead: boolean;
  }>(
    `SELECT model_id, failures, open_until, dead
       FROM model_health
      WHERE dead = true OR open_until > now()`,
  );

  return new Map(
    rows.map((r) => [
      r.model_id,
      { modelId: r.model_id, failures: r.failures, openUntil: r.open_until, dead: r.dead },
    ]),
  );
}

export async function recordModelFailure(modelId: string, threshold: number, cooldownMs: number): Promise<void> {
  await pool.query(
    `INSERT INTO model_health (model_id, failures, updated_at)
     VALUES ($1, 1, now())
     ON CONFLICT (model_id) DO UPDATE SET
       failures = CASE
         WHEN model_health.failures + 1 >= $2 THEN 0
         ELSE model_health.failures + 1
       END,
       open_until = CASE
         WHEN model_health.failures + 1 >= $2 THEN now() + ($3 || ' milliseconds')::interval
         ELSE model_health.open_until
       END,
       updated_at = now()`,
    [modelId, threshold, String(cooldownMs)],
  );
}

export async function recordModelSuccess(modelId: string): Promise<void> {
  await pool.query(
    `UPDATE model_health SET failures = 0, open_until = NULL, updated_at = now()
      WHERE model_id = $1 AND dead = false`,
    [modelId],
  );
}

export async function markModelDead(modelId: string): Promise<void> {
  await pool.query(
    `INSERT INTO model_health (model_id, dead, updated_at)
     VALUES ($1, true, now())
     ON CONFLICT (model_id) DO UPDATE SET dead = true, updated_at = now()`,
    [modelId],
  );
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
