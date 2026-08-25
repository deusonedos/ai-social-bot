import { ModelRouter } from './ai/router.js';
import { createTelegramBot } from './bot/telegram/index.js';
import { env } from './config/env.js';
import { Pipeline } from './core/pipeline.js';
import * as db from './db/index.js';
import { logger } from './util/logger.js';

async function main(): Promise<void> {
  await db.migrate();

  const router = new ModelRouter(db.quotaTracker);
  const pipeline = new Pipeline(router);
  const bot = await createTelegramBot(pipeline);

  // Суточные лимиты OpenRouter считаются по UTC — сбрасываем флаг overflow тогда же.
  scheduleDailyReset(() => {
    router.resetDaily();
    void db.pruneProcessedUpdates();
    logger.info('суточные счётчики сброшены');
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'останавливаюсь');
    await bot.stop();
    await db.pool.end();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  if (env.TELEGRAM_WEBHOOK_URL) {
    // Продакшн: вебхук с секретом, чтобы принимать апдейты только от Telegram.
    await bot.api.setWebhook(env.TELEGRAM_WEBHOOK_URL, {
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      drop_pending_updates: true,
    });
    logger.warn('webhook установлен, но HTTP-сервер ещё не поднят — для локальной разработки убери TELEGRAM_WEBHOOK_URL');
  } else {
    // Локальная разработка: long polling, туннель не нужен.
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    logger.info('запускаюсь в режиме long polling');
    void bot.start({ onStart: (info) => logger.info({ username: info.username }, 'бот принимает сообщения') });
  }
}

function scheduleDailyReset(fn: () => void): void {
  const now = new Date();
  const nextUtcMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    5,
  );
  setTimeout(() => {
    fn();
    setInterval(fn, 24 * 60 * 60 * 1000).unref();
  }, nextUtcMidnight - now.getTime()).unref();
}

main().catch((err) => {
  logger.error({ err }, 'не удалось запуститься');
  process.exit(1);
});
