import { waitUntil } from '@vercel/functions';
import type { VercelRequest, VercelResponse } from '@vercel/node';
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
 * Сигнатура нодовская (req, res), а не веб-стандартная Request/Response:
 * рантайм в папке api/ ждёт именно её и вызова res.end(). Возвращённый
 * объект Response он игнорирует, и запрос висит до таймаута.
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

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(200).send('ok');
    return;
  }

  // Единственная защита вебхука: URL публичный, и без секрета его мог бы
  // дёргать кто угодно, скармливая боту поддельные сообщения.
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    logger.warn('запрос к вебхуку с неверным секретом');
    res.status(403).send('forbidden');
    return;
  }

  const update = req.body as Update | undefined;
  if (!update || typeof update.update_id !== 'number') {
    res.status(400).send('bad request');
    return;
  }

  // Отвечаем Telegram сразу, а работу продолжаем в фоне: иначе он посчитает
  // вебхук провалившимся по таймауту и пришлёт тот же апдейт заново.
  waitUntil(
    (async () => {
      const bot = await getIdentity();
      await handleUpdate({ update, api, bot, pipeline, defer: (work) => waitUntil(work) });
    })().catch((err) => logger.error({ err, updateId: update.update_id }, 'обработка апдейта упала')),
  );

  res.status(200).send('ok');
}
