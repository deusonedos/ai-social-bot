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
  /**
   * Глубина размышлений. Почти все актуальные бесплатные модели — reasoning,
   * и при усилии по умолчанию они успевают израсходовать весь max_tokens на
   * рассуждения, вернув пустой ответ. Запрос при этом потрачен: OpenRouter
   * считает его в лимит 20 в минуту независимо от результата.
   */
  reasoningEffort?: 'low' | 'medium' | 'high';
}

/**
 * Бюджет ответа. 2000 вместо прежних 1200: у reasoning-моделей в этот лимит
 * входят и размышления, и сам ответ, а короткого ответа в чат надо ещё достичь.
 */
const CHAT_TOKENS = 2000;

const freeText = (id: string, maxTokens = CHAT_TOKENS): ModelSpec => ({
  id,
  expectInput: ['text'],
  expectOutput: ['text'],
  free: true,
  maxTokens,
  reasoningEffort: 'low',
});

const freeVision = (id: string, maxTokens = CHAT_TOKENS): ModelSpec => ({
  id,
  expectInput: ['text', 'image'],
  expectOutput: ['text'],
  free: true,
  maxTokens,
  reasoningEffort: 'low',
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
    {
      id: 'openrouter/free',
      expectInput: ['text'],
      expectOutput: ['text'],
      free: true,
      maxTokens: CHAT_TOKENS,
      reasoningEffort: 'low',
    },
  ],

  vision: [
    freeVision('minimax/minimax-m3:free'),
    freeVision('google/gemma-4-31b-it:free'),
    freeVision('thinkingmachines/inkling:free'),
    freeVision('google/gemma-4-26b-a4b-it:free'),
  ],

  // Служебные вызовы идут на самые дешёвые и быстрые модели: они не должны
  // конкурировать за качество с основным ответом.
  //
  // Лимиты с запасом относительно нужного объёма: сводка занимает ~200 токенов,
  // но у reasoning-моделей в лимит входят ещё и рассуждения, и при нехватке
  // модель возвращает пустоту, потратив запрос впустую.
  summary: [
    freeText('nvidia/nemotron-3.5-lightning:free', 900),
    freeText('nvidia/nemotron-3-super-120b-a12b:free', 900),
  ],

  classify: [
    freeText('liquid/lfm-2.5-2.6b:free', 300),
    freeText('nvidia/nemotron-3.5-lightning:free', 300),
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
