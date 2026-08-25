/**
 * Нормализованные типы, общие для всех платформ. Telegram/Threads/Instagram
 * адаптеры приводят свои события к ним, и пайплайн больше про платформу не знает.
 */

export type Platform = 'telegram' | 'threads' | 'instagram';

export interface Attachment {
  kind: 'image' | 'audio';
  /** base64 без префикса data: */
  data: string;
  mimeType: string;
  bytes: number;
}

export interface IncomingMessage {
  platform: Platform;
  /** Ключ изоляции контекста. Один чат никогда не видит историю другого. */
  conversationKey: string;
  /** Внешний id чата/треда — для ответа обратно. */
  chatId: string;
  /** Топик супергруппы, если есть. */
  threadId?: string;
  userId: string;
  userName: string;
  messageId: string;
  /** Текст уже очищен от упоминания бота. */
  text: string;
  attachments: Attachment[];
  isDirect: boolean;
  /** Текст сообщения, на которое отвечают, если есть — идёт в контекст. */
  quotedText?: string;
}

export interface OutgoingMessage {
  text: string;
  replyToMessageId: string;
  chatId: string;
  threadId?: string;
}

export type StoredRole = 'user' | 'assistant';

export interface StoredMessage {
  role: StoredRole;
  userName: string | null;
  content: string;
  createdAt: Date;
}
