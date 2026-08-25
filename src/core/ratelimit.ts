import { env } from '../config/env.js';
import * as db from '../db/index.js';
import { logger } from '../util/logger.js';

export type RateLimitResult = { ok: true } | { ok: false; reason: 'user' | 'chat' };

/**
 * Лимиты на пользователя и на чат.
 *
 * Живут в Postgres, а не в памяти: в serverless соседние сообщения могут попасть
 * в разные инстансы функции, и локальный счётчик ничего не ограничит.
 *
 * Окно фиксированное, минутное — считается одним UPSERT'ом. Скользящее окно было бы
 * точнее, но требовало бы хранить отметку каждого запроса и чистить их; для защиты
 * от флуда точность на границе окна значения не имеет.
 */
export async function checkRateLimit(userId: string, conversationKey: string): Promise<RateLimitResult> {
  try {
    const userHits = await db.bumpRateCounter(`user:${userId}`);
    if (userHits > env.MAX_REQUESTS_PER_USER_PER_MIN) return { ok: false, reason: 'user' };

    const chatHits = await db.bumpRateCounter(`chat:${conversationKey}`);
    if (chatHits > env.MAX_REQUESTS_PER_CHAT_PER_MIN) return { ok: false, reason: 'chat' };

    return { ok: true };
  } catch (err) {
    // База недоступна — пропускаем запрос дальше. Отказать всем из-за сбоя счётчика
    // хуже, чем на время остаться без защиты от флуда: настоящим предохранителем
    // выступает глобальный лимит OpenRouter.
    logger.warn({ err }, 'не удалось проверить рейт-лимит, пропускаю');
    return { ok: true };
  }
}
