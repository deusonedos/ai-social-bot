/**
 * Реестр моделей. Единственное место в проекте, где встречаются их имена —
 * бизнес-логика оперирует только ролями (TEXT / VISION / SUMMARY / ...).
 *
 * Список бесплатных моделей на OpenRouter меняется часто: модель может исчезнуть
 * или перестать быть бесплатной в любой день. Поэтому есть `scripts/check-models.ts`,
 * который сверяет этот файл с живым каталогом OpenRouter.
 */

export type ModelRole = 'text' | 'vision' | 'summary' | 'classify' | 'moderation' | 'audio';

export interface ModelSpec {
  id: string;
  /** Ожидаемые модальности входа — health-check сверяет их с каталогом. */
  expectInput: Array<'text' | 'image' | 'audio' | 'video'>;
  /** Ожидаемые модальности выхода. Защита от ловушки вида Lyria (output: audio). */
  expectOutput: Array<'text' | 'image' | 'audio'>;
  free: boolean;
  maxTokens: number;
}

const freeText = (id: string, maxTokens = 1200): ModelSpec => ({
  id,
  expectInput: ['text'],
  expectOutput: ['text'],
  free: true,
  maxTokens,
});

const freeVision = (id: string, maxTokens = 1200): ModelSpec => ({
  id,
  expectInput: ['text', 'image'],
  expectOutput: ['text'],
  free: true,
  maxTokens,
});

/**
 * Цепочки фолбэка. Порядок значим: первая живая модель отвечает.
 * Внутри цепочки модели намеренно от разных провайдеров — чтобы они
 * не легли одновременно.
 */
export const MODEL_CHAINS: Record<ModelRole, ModelSpec[]> = {
  text: [
    freeText('z-ai/glm-5.2:free'),
    freeText('nvidia/nemotron-3-super-120b-a12b:free'),
    freeText('minimax/minimax-m2.7:free'),
    // Роутер OpenRouter по случайным живым бесплатным моделям — страховка на случай,
    // когда все явно перечисленные недоступны.
    { id: 'openrouter/free', expectInput: ['text'], expectOutput: ['text'], free: true, maxTokens: 1200 },
  ],

  vision: [
    freeVision('minimax/minimax-m3:free'),
    freeVision('google/gemma-4-31b-it:free'),
    freeVision('thinkingmachines/inkling:free'),
    freeVision('google/gemma-4-26b-a4b-it:free'),
  ],

  // Служебные вызовы идут на самые дешёвые и быстрые модели: они не должны
  // конкурировать за качество с основным ответом.
  summary: [
    freeText('nvidia/nemotron-3.5-lightning:free', 500),
    freeText('nvidia/nemotron-3-super-120b-a12b:free', 500),
  ],

  classify: [
    freeText('liquid/lfm-2.5-2.6b:free', 50),
    freeText('nvidia/nemotron-3.5-lightning:free', 50),
  ],

  moderation: [
    {
      id: 'nvidia/nemotron-3.5-content-safety:free',
      expectInput: ['text', 'image'],
      expectOutput: ['text'],
      free: true,
      maxTokens: 100,
    },
  ],

  /**
   * Голосовые пока не включены в пайплайн — это задел.
   * Все три модели ниже принимают аудио нативно, отдельный STT не нужен.
   * Останется добавить перекодирование ogg/opus → mp3 через ffmpeg
   * и обработчик `voice` в Telegram-адаптере.
   */
  audio: [
    {
      id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
      expectInput: ['text', 'audio', 'image', 'video'],
      expectOutput: ['text'],
      free: true,
      maxTokens: 800,
    },
    {
      id: 'thinkingmachines/inkling-small:free',
      expectInput: ['text', 'image', 'audio'],
      expectOutput: ['text'],
      free: true,
      maxTokens: 800,
    },
  ],
};

/** Платный overflow — включается только при PAID_OVERFLOW_ENABLED и исчерпанной квоте. */
export const OVERFLOW_CHAINS: Partial<Record<ModelRole, ModelSpec[]>> = {
  text: [{ id: 'openai/gpt-oss-120b', expectInput: ['text'], expectOutput: ['text'], free: false, maxTokens: 1200 }],
  vision: [
    { id: 'qwen/qwen3.7-flash', expectInput: ['text', 'image'], expectOutput: ['text'], free: false, maxTokens: 1200 },
  ],
  summary: [
    { id: 'mistralai/mistral-nemo', expectInput: ['text'], expectOutput: ['text'], free: false, maxTokens: 500 },
  ],
};
