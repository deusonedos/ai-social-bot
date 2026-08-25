import type { VercelRequest, VercelResponse } from '@vercel/node';
import { env } from '../src/config/env.js';
import { logger } from '../src/util/logger.js';

/**
 * Одноразовая регистрация вебхука Telegram — изнутри самого приложения.
 *
 * Смысл: токен бота и секрет вебхука уже лежат в переменных окружения Vercel,
 * поэтому их не нужно копировать на локальную машину, чтобы дёрнуть setWebhook.
 *
 * Адрес берём из переменной, которую Vercel подставляет сам, а не из заголовка Host:
 * его можно подделать, и тогда вебхук увёл бы обновления на чужой сервер.
 * Здесь же проверка CRON_SECRET, так что дёрнуть эндпоинт с улицы нельзя.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const provided = req.query.secret ?? req.headers.authorization?.replace(/^Bearer /, '');
  if (!env.CRON_SECRET || provided !== env.CRON_SECRET) {
    res.status(403).json({ ok: false, error: 'нужен параметр ?secret=<CRON_SECRET>' });
    return;
  }

  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    res.status(500).json({ ok: false, error: 'не задан TELEGRAM_WEBHOOK_SECRET' });
    return;
  }

  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (!host) {
    res.status(500).json({ ok: false, error: 'Vercel не сообщил адрес продакшн-домена' });
    return;
  }

  const url = `https://${host}/api/telegram`;

  try {
    const call = (method: string, body?: unknown) =>
      fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }).then((r) => r.json() as Promise<{ ok: boolean; result?: any; description?: string }>);

    const set = await call('setWebhook', {
      url,
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      drop_pending_updates: true,
      // Нам нужны только сообщения: лишние типы апдейтов — лишние вызовы функции.
      allowed_updates: ['message'],
    });

    if (!set.ok) {
      res.status(500).json({ ok: false, error: set.description });
      return;
    }

    const [me, info] = await Promise.all([call('getMe'), call('getWebhookInfo')]);
    logger.info({ url }, 'вебхук зарегистрирован');

    res.status(200).json({
      ok: true,
      bot: me.result?.username ? `@${me.result.username}` : undefined,
      webhook: url,
      pendingUpdates: info.result?.pending_update_count,
      lastError: info.result?.last_error_message ?? null,
    });
  } catch (err) {
    logger.error({ err }, 'не удалось зарегистрировать вебхук');
    res.status(500).json({ ok: false, error: String(err) });
  }
}
