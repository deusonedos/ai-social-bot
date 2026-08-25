import { env } from '../config/env.js';
import * as db from '../db/index.js';
import { logger } from '../util/logger.js';

const GLOBAL_BUCKET = 'openrouter:rpm';

/**
 * Глобальный ограничитель обращений к OpenRouter.
 *
 * Зачем он нужен именно в serverless: у бесплатного тира лимит 20 запросов в минуту
 * на весь аккаунт, а функции Vercel масштабируются автоматически. Двадцать человек,
 * написавших одновременно, породят двадцать параллельных вызовов — и все получат 429.
 * В варианте с постоянным процессом эту роль играла очередь с WORKER_CONCURRENCY,
 * здесь общий счётчик живёт в Postgres, потому что другого общего состояния нет.
 *
 * Счётчик с фиксированным минутным окном: если слота нет, ждём начала следующего окна.
 * Ждать мы можем себе позволить — у функции 300 секунд, а альтернатива (отказ)
 * выглядела бы для пользователя как поломка.
 */
export async function acquireModelSlot(maxWaitMs: number): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;

  for (;;) {
    const hits = await db.bumpRateCounter(GLOBAL_BUCKET);
    if (hits <= env.OPENROUTER_RPM_LIMIT) return true;

    // Слот не достался — счётчик надо вернуть, иначе неудачные попытки
    // будут накручивать окно и блокировать его до конца минуты.
    await db.releaseRateCounter(GLOBAL_BUCKET);

    const msToNextWindow = 60_000 - (Date.now() % 60_000) + 250;
    if (Date.now() + msToNextWindow > deadline) {
      logger.warn({ hits }, 'лимит OpenRouter в минуту исчерпан, ждать дольше нельзя');
      return false;
    }

    logger.debug({ hits, waitMs: msToNextWindow }, 'жду следующего минутного окна OpenRouter');
    await sleep(msToNextWindow);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
