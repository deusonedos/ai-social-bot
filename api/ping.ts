import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Диагностический эндпоинт: никаких импортов, никакой конфигурации.
 *
 * Нужен, чтобы отличать «сломался рантайм или сигнатура функции» от
 * «сломался наш код при загрузке модулей». Если /api/ping отвечает,
 * а /api/telegram нет — дело в наших импортах, а не в Vercel.
 */
export default function handler(_req: VercelRequest, res: VercelResponse): void {
  res.status(200).json({
    ok: true,
    runtime: process.version,
    nodeEnv: process.env.NODE_ENV ?? '(не задан)',
    vercel: process.env.VERCEL ?? '(не задан)',
    // Только факт наличия — сами значения наружу не отдаём.
    hasBotToken: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    hasOpenRouterKey: Boolean(process.env.OPENROUTER_API_KEY),
    hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
    hasWebhookSecret: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET),
  });
}
