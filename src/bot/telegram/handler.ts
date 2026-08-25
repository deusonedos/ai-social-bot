import type { Api } from 'grammy';
import type { Message, Update } from 'grammy/types';
import { env } from '../../config/env.js';
import type { Defer, Pipeline } from '../../core/pipeline.js';
import type { IncomingMessage } from '../../core/types.js';
import * as db from '../../db/index.js';
import { logger } from '../../util/logger.js';
import { splitForTelegram } from './format.js';
import { collectImages } from './media.js';
import { detectTrigger, stripMention } from './triggers.js';

export const HELP_TEXT = `Я AI-помощник. Позови меня — отвечу.

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

export interface BotIdentity {
  id: number;
  username: string;
}

/**
 * Обработка одного апдейта Telegram.
 *
 * Общая точка для обоих режимов: вебхук на Vercel и long polling локально.
 * Различаются они только тем, откуда берётся апдейт и что подставляется в `defer`.
 */
export async function handleUpdate(params: {
  update: Update;
  api: Api;
  bot: BotIdentity;
  pipeline: Pipeline;
  defer: Defer;
}): Promise<void> {
  const { update, api, bot, pipeline, defer } = params;
  const msg = update.message;
  if (!msg) return;

  const trigger = detectTrigger(msg, bot.id, bot.username);
  if (!trigger) return;

  // Telegram переприсылает апдейт, если мы не ответили вовремя, — а бесплатные
  // модели думают долго. Без этой проверки бот отвечает по два-три раза.
  const fresh = await db.claimUpdate('telegram', String(update.update_id));
  if (!fresh) {
    logger.debug({ updateId: update.update_id }, 'повторный апдейт, пропускаю');
    return;
  }

  if (trigger === 'command') {
    await handleCommand(msg, api, bot);
    return;
  }

  await processMessage(msg, api, bot, pipeline, defer);
}

async function handleCommand(msg: Message, api: Api, bot: BotIdentity): Promise<void> {
  const text = msg.text ?? '';
  const command = text.split(/\s+/)[0]?.split('@')[0];

  if (command === '/help' || command === '/start') {
    await api.sendMessage(msg.chat.id, HELP_TEXT.replaceAll('{username}', bot.username), threadOpts(msg));
    return;
  }

  if (command === '/reset') {
    const conversationId = await db.getOrCreateConversation({
      conversationKey: conversationKey(msg.chat.id, msg.message_thread_id),
      platform: 'telegram',
      chatId: String(msg.chat.id),
      threadId: msg.message_thread_id ? String(msg.message_thread_id) : undefined,
    });
    await db.clearConversation(conversationId);
    await api.sendMessage(msg.chat.id, 'История этого чата забыта.', threadOpts(msg));
  }
}

async function processMessage(
  msg: Message,
  api: Api,
  bot: BotIdentity,
  pipeline: Pipeline,
  defer: Defer,
): Promise<void> {
  // Бесплатные модели отвечают 5–30 секунд — без индикатора чат выглядит мёртвым.
  const typing = startTyping(api, msg);

  try {
    const images = await collectImages(api, env.TELEGRAM_BOT_TOKEN, msg);
    const rawText = msg.text ?? msg.caption ?? '';

    const incoming: IncomingMessage = {
      platform: 'telegram',
      conversationKey: conversationKey(msg.chat.id, msg.message_thread_id),
      chatId: String(msg.chat.id),
      threadId: msg.message_thread_id ? String(msg.message_thread_id) : undefined,
      userId: String(msg.from?.id ?? 'unknown'),
      userName: displayName(msg),
      messageId: String(msg.message_id),
      text: stripMention(rawText, bot.username),
      attachments: images,
      isDirect: msg.chat.type === 'private',
      quotedText: quotedText(msg),
    };

    const result = await pipeline.handle(incoming, defer);
    if (result.kind === 'silent') return;

    for (const chunk of splitForTelegram(result.text)) {
      await api.sendMessage(msg.chat.id, chunk, {
        reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
        ...threadOpts(msg),
      });
    }
  } catch (err) {
    logger.error({ err }, 'не удалось обработать сообщение');
  } finally {
    typing.stop();
  }
}

/** Telegram гасит индикатор через ~5 секунд, поэтому его надо продлевать. */
function startTyping(api: Api, msg: Message): { stop: () => void } {
  const send = () => {
    void api.sendChatAction(msg.chat.id, 'typing', threadOpts(msg)).catch(() => {});
  };
  send();
  const timer = setInterval(send, 4000);
  return { stop: () => clearInterval(timer) };
}

function threadOpts(msg: Message): { message_thread_id?: number } {
  return msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {};
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
