/**
 * Регистрирует вебхук Telegram на адрес, выданный Vercel.
 *
 * Запуск:
 *   npx tsx scripts/set-webhook.ts https://ai-social-bot.vercel.app
 *   npx tsx scripts/set-webhook.ts --info     — посмотреть текущее состояние
 *   npx tsx scripts/set-webhook.ts --delete   — снять вебхук (нужно перед long polling)
 *
 * Требует TELEGRAM_BOT_TOKEN и TELEGRAM_WEBHOOK_SECRET в окружении или .env.
 */
import 'dotenv/config';

const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;

if (!token) {
  console.error('Не задан TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

const api = (method: string, body?: unknown) =>
  fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then((r) => r.json() as Promise<{ ok: boolean; result?: unknown; description?: string }>);

async function main(): Promise<void> {
  const arg = process.argv[2];

  if (arg === '--info') {
    const res = await api('getWebhookInfo');
    console.log(JSON.stringify(res.result, null, 2));
    return;
  }

  if (arg === '--delete') {
    const res = await api('deleteWebhook', { drop_pending_updates: true });
    console.log(res.ok ? '✓ Вебхук снят — можно запускать long polling' : `✗ ${res.description}`);
    return;
  }

  if (!arg) {
    console.error('Укажи базовый URL, например: npx tsx scripts/set-webhook.ts https://ai-social-bot.vercel.app');
    process.exit(1);
  }

  if (!secret) {
    console.error('Не задан TELEGRAM_WEBHOOK_SECRET — без него вебхук будет отвергать все запросы');
    process.exit(1);
  }

  const url = `${arg.replace(/\/$/, '')}/api/telegram`;
  const res = await api('setWebhook', {
    url,
    secret_token: secret,
    drop_pending_updates: true,
    // Нам нужны только сообщения: лишние типы апдейтов — лишние вызовы функции.
    allowed_updates: ['message'],
  });

  if (!res.ok) {
    console.error(`✗ Не удалось установить вебхук: ${res.description}`);
    process.exit(1);
  }

  console.log(`✓ Вебхук установлен: ${url}`);
  const info = await api('getWebhookInfo');
  console.log(JSON.stringify(info.result, null, 2));
}

void main();
