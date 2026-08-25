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
export default async function handler(request: Request): Promise<Response> {
  // Vercel подставляет CRON_SECRET в заголовок, если переменная задана.
  // Без проверки эндпоинт мог бы дёргать кто угодно.
  if (env.CRON_SECRET) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${env.CRON_SECRET}`) {
      return new Response('forbidden', { status: 403 });
    }
  }

  try {
    await db.pruneRateCounters();
    await db.pruneProcessedUpdates();
    logger.info('служебные таблицы очищены');
    return Response.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'уборка не удалась');
    return Response.json({ ok: false }, { status: 500 });
  }
}
