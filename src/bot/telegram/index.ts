import { Bot, type Context } from 'grammy';
import type { Message } from 'grammy/types';
import { env } from '../../config/env.js';
import { Pipeline } from '../../core/pipeline.js';
import { TaskQueue } from '../../core/queue.js';
import type { IncomingMessage } from '../../core/types.js';
import * as db from '../../db/index.js';
import { logger } from '../../util/logger.js';
import { splitForTelegram } from './format.js';
import { collectImages } from './media.js';
import { detectTrigger, stripMention } from './triggers.js';

const HELP_TEXT = `Я AI-помощник. Позови меня — отвечу.

В личке: просто пиши или присылай фото.

В группе:
• @{username} вопрос — отвечу на вопрос
• ответь на моё сообщение — продолжу разговор
• ответь на фото и напиши @{username} реши — разберу картинку

Про фото: в группе я не вижу картинки без подписи. Либо добавь подпись с моим
именем, либо ответь на фото сообщением с упоминанием.

Команды:
/help — эта справка
/reset — забыть историю разговора в этом чате`;

export async function createTelegramBot(pipeline: Pipeline): Promise<Bot> {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  await bot.init();

  const botId = bot.botInfo.id;
  const botUsername = bot.botInfo.username;
  const queue = new TaskQueue(env.WORKER_CONCURRENCY);

  logger.info({ username: botUsername, id: botId }, 'бот инициализирован');

  bot.command('help', (ctx) => ctx.reply(HELP_TEXT.replaceAll('{username}', botUsername)));
  bot.command('start', (ctx) => ctx.reply(HELP_TEXT.replaceAll('{username}', botUsername)));

  bot.command('reset', async (ctx) => {
    const key = conversationKey(ctx.chat.id, ctx.message?.message_thread_id);
    const id = await db.getOrCreateConversation({
      conversationKey: key,
      platform: 'telegram',
      chatId: String(ctx.chat.id),
      threadId: ctx.message?.message_thread_id ? String(ctx.message.message_thread_id) : undefined,
    });
    await db.clearConversation(id);
    await ctx.reply('История этого чата забыта.');
  });

  bot.on('message', async (ctx) => {
    const msg = ctx.message;
    const trigger = detectTrigger(msg, botId, botUsername);
    if (!trigger || trigger === 'command') return;

    // Telegram переприсылает апдейт, если мы не ответили вовремя, — а бесплатные
    // модели думают долго. Без этой проверки бот отвечает по два-три раза.
    const fresh = await db.claimUpdate('telegram', String(ctx.update.update_id));
    if (!fresh) {
      logger.debug({ updateId: ctx.update.update_id }, 'повторный апдейт, пропускаю');
      return;
    }

    // Возврат управления Telegram сразу: тяжёлая работа уходит в очередь.
    queue.push({
      id: `tg:${ctx.update.update_id}`,
      run: () => processMessage(ctx, msg, pipeline, botUsername),
    });
  });

  bot.catch((err) => logger.error({ err: err.error, ctx: err.ctx?.update?.update_id }, 'ошибка grammY'));

  return bot;
}

async function processMessage(
  ctx: Context,
  msg: Message,
  pipeline: Pipeline,
  botUsername: string,
): Promise<void> {
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id;

  // Бесплатные модели отвечают 5–30 секунд — без индикатора чат выглядит мёртвым.
  const typing = startTyping(ctx, threadId);

  try {
    const images = await collectImages(ctx.api, env.TELEGRAM_BOT_TOKEN, msg);
    const rawText = msg.text ?? msg.caption ?? '';

    const incoming: IncomingMessage = {
      platform: 'telegram',
      conversationKey: conversationKey(chatId, threadId),
      chatId: String(chatId),
      threadId: threadId ? String(threadId) : undefined,
      userId: String(msg.from?.id ?? 'unknown'),
      userName: displayName(msg),
      messageId: String(msg.message_id),
      text: stripMention(rawText, botUsername),
      attachments: images,
      isDirect: msg.chat.type === 'private',
      quotedText: quotedText(msg),
    };

    const result = await pipeline.handle(incoming);
    if (result.kind === 'silent') return;

    for (const chunk of splitForTelegram(result.text)) {
      await ctx.api.sendMessage(chatId, chunk, {
        reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
        ...(threadId ? { message_thread_id: threadId } : {}),
      });
    }
  } catch (err) {
    logger.error({ err }, 'не удалось обработать сообщение');
  } finally {
    typing.stop();
  }
}

/** Telegram гасит индикатор через ~5 секунд, поэтому его надо продлевать. */
function startTyping(ctx: Context, threadId?: number): { stop: () => void } {
  const send = () => {
    void ctx.api
      .sendChatAction(ctx.chat!.id, 'typing', threadId ? { message_thread_id: threadId } : {})
      .catch(() => {});
  };
  send();
  const timer = setInterval(send, 4000);
  return { stop: () => clearInterval(timer) };
}

/**
 * Ключ изоляции. В супергруппах с топиками разные обсуждения обязаны иметь
 * разный контекст, иначе они смешаются в одну кашу.
 */
function conversationKey(chatId: number, threadId?: number): string {
  return threadId ? `telegram:${chatId}:${threadId}` : `telegram:${chatId}`;
}

function displayName(msg: Message): string {
  const from = msg.from;
  if (!from) return 'Пользователь';
  return from.first_name || from.username || `id${from.id}`;
}

function quotedText(msg: Message): string | undefined {
  const quoted = msg.reply_to_message;
  if (!quoted) return undefined;
  // Реплай на самого бота не цитируем: его ответ и так лежит в истории.
  if (quoted.from?.is_bot) return undefined;
  return quoted.text ?? quoted.caption ?? undefined;
}
