import { env } from '../config/env.js';
import { MODEL_CHAINS, OVERFLOW_CHAINS, type ModelRole, type ModelSpec } from '../config/models.js';
import { acquireModelSlot } from '../core/throttle.js';
import * as db from '../db/index.js';
import { logger } from '../util/logger.js';
import { GatewayError, OpenRouterGateway, type ChatMessage, type CompletionResult } from './gateway.js';

const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 5 * 60_000;

export class AllModelsFailedError extends Error {
  constructor(
    readonly role: ModelRole,
    /** Не `cause` — это имя занято стандартным свойством Error. */
    readonly reason: 'throttled' | 'exhausted',
  ) {
    super(`все модели для роли "${role}" недоступны (${reason})`);
    this.name = 'AllModelsFailedError';
  }
}

/**
 * Выбирает модель под задачу и переживает её недоступность.
 *
 * Всё состояние (circuit breaker, суточная квота, лимит запросов в минуту) живёт
 * в Postgres: в serverless между вызовами функции ничего не сохраняется, а решения
 * должны быть общими для всех параллельных инстансов.
 */
export class ModelRouter {
  private readonly gateway = new OpenRouterGateway();

  async complete(role: ModelRole, messages: ChatMessage[], temperature?: number): Promise<CompletionResult> {
    const [chain, unhealthy] = await Promise.all([this.buildChain(role), db.getUnhealthyModels()]);

    let lastError: unknown;
    for (const spec of chain) {
      const health = unhealthy.get(spec.id);
      if (health?.dead) continue;
      if (health?.openUntil && health.openUntil.getTime() > Date.now()) continue;

      // Слот берём перед каждой моделью: фолбэк — это тоже обращение к OpenRouter,
      // и оно точно так же считается в лимит 20 запросов в минуту.
      const gotSlot = await acquireModelSlot(env.MODEL_SLOT_WAIT_MS);
      if (!gotSlot) throw new AllModelsFailedError(role, 'throttled');

      try {
        const result = await this.callWithRetry(spec, messages, temperature);
        void db.recordModelSuccess(spec.id).catch(() => {});
        if (spec.free) void db.quotaTracker.increment().catch(() => {});
        return result;
      } catch (err) {
        lastError = err;
        await this.onFailure(spec.id, err);
      }
    }

    logger.error({ role, lastError: String(lastError) }, 'цепочка моделей исчерпана');
    throw new AllModelsFailedError(role, 'exhausted');
  }

  /**
   * Бесплатные модели, а при исчерпанной квоте — платные.
   * Overflow приклеивается в хвост, а не заменяет цепочку: если бесплатная модель
   * всё-таки ответит, платить незачем.
   */
  private async buildChain(role: ModelRole): Promise<ModelSpec[]> {
    const free = MODEL_CHAINS[role] ?? [];
    const overflow = OVERFLOW_CHAINS[role] ?? [];

    if (!env.PAID_OVERFLOW_ENABLED || overflow.length === 0) return free;

    const used = await db.quotaTracker.used().catch(() => 0);
    if (used >= env.FREE_TIER_DAILY_QUOTA) {
      // Квота кончилась — бесплатные всё равно вернут 429, не тратим на них ни слоты, ни время.
      return overflow;
    }
    return [...free, ...overflow];
  }

  private async callWithRetry(
    spec: ModelSpec,
    messages: ChatMessage[],
    temperature?: number,
  ): Promise<CompletionResult> {
    const call = () =>
      this.gateway.complete({ model: spec.id, messages, maxTokens: spec.maxTokens, temperature });

    try {
      return await call();
    } catch (err) {
      if (err instanceof GatewayError && err.retryable) {
        await new Promise((r) => setTimeout(r, 1000));
        return call();
      }
      throw err;
    }
  }

  private async onFailure(modelId: string, err: unknown): Promise<void> {
    try {
      if (err instanceof GatewayError && err.kind === 'not_found') {
        logger.error({ model: modelId }, 'модель исчезла из каталога OpenRouter — проверь src/config/models.ts');
        await db.markModelDead(modelId);
        return;
      }
      await db.recordModelFailure(modelId, BREAKER_THRESHOLD, BREAKER_COOLDOWN_MS);
    } catch (dbErr) {
      logger.warn({ dbErr, modelId }, 'не удалось записать состояние модели');
    }
  }
}
