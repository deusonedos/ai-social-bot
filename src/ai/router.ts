import { env } from '../config/env.js';
import { MODEL_CHAINS, OVERFLOW_CHAINS, type ModelRole, type ModelSpec } from '../config/models.js';
import { logger } from '../util/logger.js';
import { GatewayError, OpenRouterGateway, type ChatMessage, type CompletionResult } from './gateway.js';

const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 5 * 60_000;

interface BreakerState {
  failures: number;
  openedUntil: number;
}

export class AllModelsFailedError extends Error {
  constructor(readonly role: ModelRole) {
    super(`все модели для роли "${role}" недоступны`);
    this.name = 'AllModelsFailedError';
  }
}

export interface QuotaTracker {
  /** Сколько бесплатных запросов уже потрачено за текущие сутки (UTC). */
  used(): Promise<number>;
  increment(): Promise<void>;
}

/**
 * Выбирает модель под задачу и переживает её недоступность.
 *
 * Два независимых механизма:
 *  - circuit breaker — не тратить время на модель, которая только что падала;
 *  - квота — бесплатный тир OpenRouter ограничен числом запросов в сутки,
 *    и при исчерпании мы либо уходим на платные модели, либо мягко отказываем.
 */
export class ModelRouter {
  private readonly gateway = new OpenRouterGateway();
  private readonly breakers = new Map<string, BreakerState>();
  /** Модели, которых больше нет в каталоге (404). Исключаются до перезапуска. */
  private readonly dead = new Set<string>();
  /** Взводится при 402 — до конца суток идём сразу в overflow. */
  private quotaExhausted = false;

  constructor(private readonly quota: QuotaTracker) {}

  async complete(role: ModelRole, messages: ChatMessage[], temperature?: number): Promise<CompletionResult> {
    const chain = await this.buildChain(role);

    let lastError: unknown;
    for (const spec of chain) {
      if (!this.available(spec.id)) continue;

      try {
        const result = await this.callWithRetry(spec, messages, temperature);
        this.onSuccess(spec.id);
        if (spec.free) await this.quota.increment();
        return result;
      } catch (err) {
        lastError = err;
        this.onFailure(spec.id, err);

        if (err instanceof GatewayError && err.kind === 'quota') {
          logger.warn({ model: spec.id }, 'квота бесплатного тира исчерпана, переключаюсь на overflow');
          this.quotaExhausted = true;
        }
      }
    }

    logger.error({ role, lastError: String(lastError) }, 'цепочка моделей исчерпана');
    throw new AllModelsFailedError(role);
  }

  /**
   * Собирает цепочку: бесплатные модели, а при исчерпанной квоте — платные.
   * Overflow приклеивается в хвост, а не заменяет цепочку: если бесплатная
   * модель всё-таки ответит, платить незачем.
   */
  private async buildChain(role: ModelRole): Promise<ModelSpec[]> {
    const free = MODEL_CHAINS[role] ?? [];
    const overflow = OVERFLOW_CHAINS[role] ?? [];

    if (!env.PAID_OVERFLOW_ENABLED || overflow.length === 0) return free;

    const used = await this.quota.used();
    const nearLimit = used >= env.FREE_TIER_DAILY_QUOTA;

    if (this.quotaExhausted || nearLimit) {
      // Квота кончилась — бесплатные всё равно вернут 429, не тратим на них время.
      return overflow;
    }
    return [...free, ...overflow];
  }

  private async callWithRetry(
    spec: ModelSpec,
    messages: ChatMessage[],
    temperature?: number,
  ): Promise<CompletionResult> {
    try {
      return await this.gateway.complete({
        model: spec.id,
        messages,
        maxTokens: spec.maxTokens,
        temperature,
      });
    } catch (err) {
      if (err instanceof GatewayError && err.retryable) {
        await new Promise((r) => setTimeout(r, 1000));
        return this.gateway.complete({
          model: spec.id,
          messages,
          maxTokens: spec.maxTokens,
          temperature,
        });
      }
      throw err;
    }
  }

  private available(modelId: string): boolean {
    if (this.dead.has(modelId)) return false;
    const state = this.breakers.get(modelId);
    return !state || Date.now() >= state.openedUntil;
  }

  private onSuccess(modelId: string): void {
    this.breakers.delete(modelId);
  }

  private onFailure(modelId: string, err: unknown): void {
    if (err instanceof GatewayError && err.kind === 'not_found') {
      logger.error({ model: modelId }, 'модель исчезла из каталога OpenRouter — проверь src/config/models.ts');
      this.dead.add(modelId);
      return;
    }

    const state = this.breakers.get(modelId) ?? { failures: 0, openedUntil: 0 };
    state.failures += 1;
    if (state.failures >= BREAKER_THRESHOLD) {
      state.openedUntil = Date.now() + BREAKER_COOLDOWN_MS;
      state.failures = 0;
      logger.warn({ model: modelId }, 'circuit breaker открыт на 5 минут');
    }
    this.breakers.set(modelId, state);
  }

  /** Для /health. */
  status() {
    return {
      quotaExhausted: this.quotaExhausted,
      dead: [...this.dead],
      tripped: [...this.breakers.entries()]
        .filter(([, s]) => Date.now() < s.openedUntil)
        .map(([id]) => id),
    };
  }

  /** Вызывается планировщиком в полночь UTC. */
  resetDaily(): void {
    this.quotaExhausted = false;
  }
}
