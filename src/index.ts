/**
 * Локальный режим разработки: long polling, туннель не нужен.
 *
 * В продакшне на Vercel точка входа другая — api/telegram.ts. Общая часть
 * обработки живёт в src/bot/telegram/handler.ts, так что оба режима ведут себя
 * одинаково.
 */
import { Bot } from 'grammy';
import { ModelRouter } from './ai/router.js';
import { handleUpdate } from './bot/telegram/handler.js';
import { env } from './config/env.js';
import { Pipeline } from './core/pipeline.js';
import { TaskQueue } from './core/queue.js';
import * as db from './db/index.js';
import { logger } from './util/logger.js';

async function main(): Promise<void> {
  await db.migrate();

  const pipeline = new Pipeline(new ModelRouter());
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  await bot.init();

  const identity = { id: bot.botInfo.id, username: bot.botInfo.username };
  const queue = new TaskQueue(env.WORKER_CONCURRENCY);

  logger.info({ username: identity.username }, 'бот инициализирован');

  bot.on('message', (ctx) => {
    // Приём и обработка разнесены: модели отвечают медленно, а grammY
    // не должен ждать их, удерживая цикл получения апдейтов.
    queue.push({
      id: `tg:${ctx.update.update_id}`,
      run: () =>
        handleUpdate({
          update: ctx.update,
          api: bot.api,
          bot: identity,
          pipeline,
          defer: (work) => void Promise.resolve(work).catch(() => {}),
        }),
    });
  });

  bot.catch((err) => logger.error({ err: err.error }, 'ошибка grammY'));

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'останавливаюсь');
    await bot.stop();
    await db.pool.end();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  // Локальный режим и вебхук взаимоисключающи: пока висит вебхук,
  // Telegram не отдаёт апдейты через getUpdates.
  await bot.api.deleteWebhook({ drop_pending_updates: true });
  logger.info('запускаюсь в режиме long polling');
  void bot.start({ onStart: (info) => logger.info({ username: info.username }, 'бот принимает сообщения') });

  setInterval(() => {
    void db.pruneRateCounters().catch(() => {});
    void db.pruneProcessedUpdates().catch(() => {});
  }, 60 * 60 * 1000).unref();
}

main().catch((err) => {
  logger.error({ err }, 'не удалось запуститься');
  process.exit(1);
});
