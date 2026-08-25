import { buildContext, buildSummaryRequest, shouldSummarize } from '../ai/context.js';
import { AllModelsFailedError, ModelRouter } from '../ai/router.js';
import { env } from '../config/env.js';
import * as db from '../db/index.js';
import { logger } from '../util/logger.js';
import { stripReasoning } from '../util/text.js';
import { checkRateLimit } from './ratelimit.js';
import type { IncomingMessage } from './types.js';

export type PipelineResult =
  | { kind: 'reply'; text: string }
  | { kind: 'silent' }
  | { kind: 'error'; text: string };

/**
 * Обработка одного сообщения — одинаковая для всех платформ.
 * Адаптеры отвечают только за нормализацию входа и доставку ответа.
 */
export class Pipeline {
  constructor(private readonly router: ModelRouter) {}

  async handle(incoming: IncomingMessage): Promise<PipelineResult> {
    const limit = checkRateLimit(incoming.userId, incoming.conversationKey);
    if (!limit.ok) {
      logger.debug({ userId: incoming.userId, reason: limit.reason }, 'сработал рейт-лимит');
      // Молчим вместо ответа: иначе флуд превращается в удвоенный флуд.
      return { kind: 'silent' };
    }

    const conversationId = await db.getOrCreateConversation({
      conversationKey: incoming.conversationKey,
      platform: incoming.platform,
      chatId: incoming.chatId,
      threadId: incoming.threadId,
    });

    const [history, summary] = await Promise.all([
      db.getRecentMessages(conversationId, env.CONTEXT_KEEP_RECENT_MESSAGES * 2),
      db.getSummary(conversationId),
    ]);

    const hasImages = incoming.attachments.some((a) => a.kind === 'image');
    const role = hasImages ? 'vision' : 'text';
    const messages = buildContext({ incoming, history, summary });

    let answer: string;
    try {
      const result = await this.router.complete(role, messages);
      answer = stripReasoning(result.text);

      await db.logUsage({
        conversationId,
        model: result.model,
        roleName: role,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      });
      logger.info(
        { model: result.model, role, conversationKey: incoming.conversationKey },
        'ответ сформирован',
      );
    } catch (err) {
      if (err instanceof AllModelsFailedError) {
        return { kind: 'error', text: 'Сейчас все модели заняты. Попробуй через минуту.' };
      }
      logger.error({ err }, 'пайплайн упал');
      return { kind: 'error', text: 'Что-то пошло не так. Попробуй ещё раз.' };
    }

    await db.saveMessage({
      conversationId,
      platformUserId: incoming.userId,
      userName: incoming.userName,
      role: 'user',
      content: incoming.text || (hasImages ? '[изображение]' : ''),
      hasMedia: incoming.attachments.length > 0,
    });
    await db.saveMessage({
      conversationId,
      platformUserId: null,
      userName: null,
      role: 'assistant',
      content: answer,
    });

    // Сводка пересобирается в фоне: пользователь не должен ждать служебный вызов.
    void this.maybeSummarize(conversationId, summary);

    return { kind: 'reply', text: answer };
  }

  private async maybeSummarize(conversationId: number, previous: string | null): Promise<void> {
    try {
      const history = await db.getRecentMessages(conversationId, 200);
      if (!shouldSummarize(history)) return;

      const result = await this.router.complete('summary', buildSummaryRequest(history, previous), 0.3);
      await db.upsertSummary(conversationId, stripReasoning(result.text));
      await db.logUsage({
        conversationId,
        model: result.model,
        roleName: 'summary',
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      });
      logger.info({ conversationId }, 'сводка обновлена');
    } catch (err) {
      // Неудачная сводка — не повод ломать разговор: в следующий раз попробуем снова.
      logger.warn({ err, conversationId }, 'не удалось обновить сводку');
    }
  }
}
