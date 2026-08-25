import { waitUntil } from '@vercel/functions';
import { Api } from 'grammy';
import type { Update } from 'grammy/types';
import { ModelRouter } from '../src/ai/router.js';
import { handleUpdate, type BotIdentity } from '../src/bot/telegram/handler.js';
import { env } from '../src/config/env.js';
import { Pipeline } from '../src/core/pipeline.js';
import { logger } from '../src/util/logger.js';

/**
 * Вебхук Telegram на Vercel.
 *
 * Объекты создаются на уровне модуля, чтобы «тёплые» вызовы функции
 * переиспользовали их вместе с пулом соединений к базе.
 */
const api = new Api(env.TELEGRAM_BOT_TOKEN);
const pipeline = new Pipeline(new ModelRouter());

/**
 * Кто мы — узнаём один раз и держим в памяти инстанса. getMe на каждый апдейт
 * был бы лишним обращением к Telegram на горячем пути.
 */
let identity: Promise<BotIdentity> | null = null;
function getIdentity(): Promise<BotIdentity> {
  identity ??= api.getMe().then((me) => ({ id: me.id, username: me.username }));
  return identity;
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('ok', { status: 200 });
  }

  // Единственная защита вебхука: URL публичный, и без секрета его мог бы
  // дёргать кто угодно, скармливая боту поддельные сообщения.
  const secret = request.headers.get('x-telegram-bot-api-secret-token');
  if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    logger.warn('запрос к вебхуку с неверным секретом');
    return new Response('forbidden', { status: 403 });
  }

  let update: Update;
  try {
    update = (await request.json()) as Update;
  } catch {
    return new Response('bad request', { status: 400 });
  }

  const bot = await getIdentity();

  // Отвечаем Telegram сразу, а работу продолжаем в фоне: иначе он посчитает
  // вебхук провалившимся по таймауту и пришлёт тот же апдейт заново.
  waitUntil(
    handleUpdate({ update, api, bot, pipeline, defer: (work) => waitUntil(work) }).catch((err) =>
      logger.error({ err, updateId: update.update_id }, 'обработка апдейта упала'),
    ),
  );

  return new Response('ok', { status: 200 });
}
