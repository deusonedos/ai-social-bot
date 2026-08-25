import { env } from '../config/env.js';
import type { Attachment, IncomingMessage, StoredMessage } from '../core/types.js';
import { estimateTokens, IMAGE_TOKEN_COST } from '../util/tokens.js';
import type { ChatContentPart, ChatMessage } from './gateway.js';
import { buildSystemPrompt, SUMMARY_PROMPT } from './prompts.js';
import { formatForContext, type SearchResponse } from './search.js';

/**
 * Собирает запрос к модели из системного промпта, сводки и последних сообщений
 * ЭТОГО разговора.
 *
 * Контекст держим намеренно маленьким (~6k токенов при окне моделей в 256k–1M):
 * длинный контекст на бесплатных моделях означает секунды ожидания без выигрыша
 * в качестве ответа.
 */
export function buildContext(params: {
  incoming: IncomingMessage;
  history: StoredMessage[];
  summary: string | null;
  searchResults?: SearchResponse | null;
}): ChatMessage[] {
  const { incoming, history, summary, searchResults } = params;
  const hasImages = incoming.attachments.some((a) => a.kind === 'image');

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt({ hasImages, hasSearch: Boolean(searchResults) }) },
  ];

  if (summary) {
    messages.push({
      role: 'system',
      content: `Краткая сводка предыдущего разговора в этом чате:\n${summary}`,
    });
  }

  // Результаты поиска идут последним системным сообщением — ближе всего к вопросу,
  // чтобы модель не потеряла их за историей переписки.
  if (searchResults) {
    messages.push({ role: 'system', content: formatForContext(searchResults) });
  }

  // История ужимается под то, что осталось после картинок и результатов поиска:
  // свежие данные важнее старой переписки, поэтому урезаем именно историю.
  const budget =
    env.CONTEXT_TOKEN_BUDGET -
    (hasImages ? IMAGE_TOKEN_COST * incoming.attachments.length : 0) -
    (searchResults ? estimateTokens(formatForContext(searchResults)) : 0);
  for (const m of trimToBudget(history, budget)) {
    messages.push({
      role: m.role,
      // В группе говорят несколько человек — без имени модель их путает.
      content: m.role === 'user' && m.userName ? `${m.userName}: ${m.content}` : m.content,
    });
  }

  messages.push({ role: 'user', content: buildUserContent(incoming) });
  return messages;
}

function buildUserContent(incoming: IncomingMessage): string | ChatContentPart[] {
  const parts: string[] = [];

  if (incoming.quotedText) {
    parts.push(`[в ответ на сообщение: "${truncate(incoming.quotedText, 500)}"]`);
  }
  parts.push(incoming.text || (incoming.attachments.length ? 'Что здесь?' : ''));

  const text = `${incoming.userName}: ${parts.filter(Boolean).join('\n')}`;
  const images = incoming.attachments.filter((a) => a.kind === 'image');

  if (images.length === 0) return text;

  return [
    { type: 'text', text },
    ...images.map(
      (img): ChatContentPart => ({
        type: 'image_url',
        image_url: { url: toDataUri(img) },
      }),
    ),
  ];
}

export function toDataUri(a: Attachment): string {
  return `data:${a.mimeType};base64,${a.data}`;
}

/** Отбрасывает самые старые сообщения, пока не влезем в бюджет. */
function trimToBudget(history: StoredMessage[], budget: number): StoredMessage[] {
  const kept: StoredMessage[] = [];
  let used = 0;

  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    const cost = estimateTokens(m.content) + 8;
    if (used + cost > budget) break;
    used += cost;
    kept.unshift(m);
  }
  return kept;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/** Нужно ли сворачивать историю. */
export function shouldSummarize(history: StoredMessage[]): boolean {
  if (history.length <= env.CONTEXT_KEEP_RECENT_MESSAGES) return false;
  const total = history.reduce((acc, m) => acc + estimateTokens(m.content), 0);
  return total > env.CONTEXT_TOKEN_BUDGET * 0.8;
}

export function buildSummaryRequest(history: StoredMessage[], previous: string | null): ChatMessage[] {
  // Сворачиваем всё, кроме свежего хвоста: хвост и так уйдёт в контекст сырым.
  const older = history.slice(0, Math.max(0, history.length - env.CONTEXT_KEEP_RECENT_MESSAGES));
  const transcript = older
    .map((m) => `${m.role === 'assistant' ? 'Бот' : (m.userName ?? 'Пользователь')}: ${m.content}`)
    .join('\n');

  return [
    { role: 'system', content: SUMMARY_PROMPT },
    {
      role: 'user',
      content: previous
        ? `Предыдущая сводка:\n${previous}\n\nНовые сообщения:\n${transcript}\n\nОбнови сводку.`
        : transcript,
    },
  ];
}
