import { env } from '../config/env.js';

export interface ChatContentPart {
  type: 'text' | 'image_url' | 'input_audio';
  text?: string;
  image_url?: { url: string };
  input_audio?: { data: string; format: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatContentPart[];
}

export interface CompletionRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface CompletionResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** Классификация ошибки определяет, идти ли к следующей модели или ретраить эту. */
export type GatewayErrorKind =
  | 'rate_limit' // 429  → сразу следующая модель
  | 'quota' // 402  → весь роутер в overflow
  | 'not_found' // 404  → модель исчезла, пометить мёртвой
  | 'server' // 5xx  → можно ретраить
  | 'timeout'
  | 'bad_request'
  | 'unknown';

export class GatewayError extends Error {
  constructor(
    readonly kind: GatewayErrorKind,
    readonly model: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GatewayError';
  }

  /** Стоит ли повторить запрос к этой же модели. */
  get retryable(): boolean {
    return this.kind === 'server' || this.kind === 'timeout';
  }
}

function classify(status: number): GatewayErrorKind {
  if (status === 429) return 'rate_limit';
  if (status === 402) return 'quota';
  if (status === 404) return 'not_found';
  if (status === 400 || status === 422) return 'bad_request';
  if (status >= 500) return 'server';
  return 'unknown';
}

/**
 * Тонкая обёртка над OpenRouter. Никакой логики выбора модели —
 * этим занимается ModelRouter.
 */
export class OpenRouterGateway {
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), req.timeoutMs ?? 45_000);

    let res: Response;
    try {
      res = await fetch(`${env.OPENROUTER_BASE_URL}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          // OpenRouter использует эти заголовки для атрибуции приложения.
          'HTTP-Referer': env.OPENROUTER_APP_URL,
          'X-Title': env.OPENROUTER_APP_NAME,
        },
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          max_tokens: req.maxTokens,
          temperature: req.temperature ?? 0.6,
        }),
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      throw new GatewayError(
        aborted ? 'timeout' : 'unknown',
        req.model,
        aborted ? 'таймаут запроса' : String(err),
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new GatewayError(classify(res.status), req.model, body.slice(0, 300), res.status);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null; reasoning?: string | null } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string };
    };

    if (json.error) {
      throw new GatewayError('unknown', req.model, json.error.message ?? 'ошибка провайдера');
    }

    const content = json.choices?.[0]?.message?.content ?? '';
    if (!content.trim()) {
      // Reasoning-модель могла израсходовать весь бюджет на размышления и не дойти
      // до ответа. Для нас это неуспех — идём к следующей модели.
      throw new GatewayError('server', req.model, 'пустой ответ модели');
    }

    return {
      text: content,
      model: req.model,
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
    };
  }
}
