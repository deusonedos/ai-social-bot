import type { VercelRequest, VercelResponse } from '@vercel/node';
import { env } from '../src/config/env.js';
import * as db from '../src/db/index.js';
import { logger } from '../src/util/logger.js';

/**
 * Ежедневная уборка служебных таблиц.
 *
 * В варианте с постоянным процессом это делал setInterval. В serverless процесса нет,
 * поэтому чистку запускает Vercel Cron (см. vercel.json). На Hobby-плане крон
 * выполняется раз в сутки — для наших таблиц этого достаточно с запасом.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  // Vercel подставляет CRON_SECRET в заголовок, если переменная задана.
  // Без проверки эндпоинт мог бы дёргать кто угодно.
  if (env.CRON_SECRET && req.headers.authorization !== `Bearer ${env.CRON_SECRET}`) {
    res.status(403).send('forbidden');
    return;
  }

  try {
    await db.pruneRateCounters();
    await db.pruneProcessedUpdates();
    logger.info('служебные таблицы очищены');
    res.status(200).json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'уборка не удалась');
    res.status(500).json({ ok: false });
  }
}
