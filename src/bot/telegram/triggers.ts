import type { Message } from 'grammy/types';

export type TriggerReason = 'direct' | 'mention' | 'reply_to_bot' | 'command' | null;

/**
 * Решает, должен ли бот отвечать.
 *
 * Работает вместе с privacy mode Telegram (включён по умолчанию, и мы его НЕ выключаем):
 * в группах бот и так получает только упоминания, реплаи на себя и команды.
 * Это снимает необходимость в правах администратора и на порядки уменьшает
 * поток апдейтов — но проверку всё равно делаем явно.
 */
export function detectTrigger(msg: Message, botId: number, botUsername: string): TriggerReason {
  if (msg.chat.type === 'private') return 'direct';

  if (msg.reply_to_message?.from?.id === botId) return 'reply_to_bot';

  // Упоминание может быть и в тексте, и в подписи к фото — это разные поля.
  const entities = msg.entities ?? msg.caption_entities ?? [];
  const source = msg.text ?? msg.caption ?? '';

  for (const e of entities) {
    if (e.type === 'bot_command' && e.offset === 0) return 'command';
    if (e.type === 'mention') {
      const handle = source.slice(e.offset, e.offset + e.length);
      if (handle.toLowerCase() === `@${botUsername.toLowerCase()}`) return 'mention';
    }
  }

  return null;
}

/** Убирает обращение к боту, чтобы модель не считала «@bot» частью вопроса. */
export function stripMention(text: string, botUsername: string): string {
  return text
    .replace(new RegExp(`@${botUsername}\\b`, 'gi'), '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
