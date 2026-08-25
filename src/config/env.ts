import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),

  TELEGRAM_BOT_TOKEN: z.string().min(10, 'получить у @BotFather'),
  /** Пустой в dev: тогда работаем long polling, туннель не нужен. */
  TELEGRAM_WEBHOOK_URL: z.string().url().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),

  OPENROUTER_API_KEY: z.string().min(10),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  /** Уходят в заголовки OpenRouter, влияют на рейтинг приложения в их каталоге. */
  OPENROUTER_APP_URL: z.string().default('https://github.com/local/ai-social-bot'),
  OPENROUTER_APP_NAME: z.string().default('AI Social Bot'),

  DATABASE_URL: z.string().min(1),
  /** Supabase/Neon требуют TLS, локальный Postgres — нет. */
  DATABASE_SSL: z.coerce.boolean().default(false),

  /** Суточная квота бесплатного тира OpenRouter: 50 без пополнения, 1000 после $10. */
  FREE_TIER_DAILY_QUOTA: z.coerce.number().int().positive().default(1000),
  /** Пускать ли трафик на платные модели после исчерпания бесплатной квоты. */
  PAID_OVERFLOW_ENABLED: z.coerce.boolean().default(false),

  MAX_REQUESTS_PER_USER_PER_MIN: z.coerce.number().int().positive().default(3),
  MAX_REQUESTS_PER_CHAT_PER_MIN: z.coerce.number().int().positive().default(10),
  /** Сколько сообщений обрабатываем одновременно в режиме long polling. */
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),

  /**
   * Лимит OpenRouter — 20 запросов в минуту на аккаунт. Берём 18: запас на служебные
   * вызовы (суммаризация) и на расхождение наших минутных окон с их учётом.
   */
  OPENROUTER_RPM_LIMIT: z.coerce.number().int().positive().default(18),
  /** Сколько ждать освобождения слота, прежде чем сдаться. */
  MODEL_SLOT_WAIT_MS: z.coerce.number().int().nonnegative().default(75_000),

  /** Включается автоматически на Vercel: меняет размер пула соединений. */
  SERVERLESS: z.coerce.boolean().default(false),
  /** Защита cron-эндпоинта на Vercel. Если не задан — проверка не выполняется. */
  CRON_SECRET: z.string().optional(),

  /** Целевой размер контекста в токенах — намеренно меньше окна моделей. */
  CONTEXT_TOKEN_BUDGET: z.coerce.number().int().positive().default(6000),
  CONTEXT_KEEP_RECENT_MESSAGES: z.coerce.number().int().positive().default(20),

  MAX_IMAGES_PER_MESSAGE: z.coerce.number().int().positive().default(3),
  MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),

  /** ID администраторов через запятую — им доступны /stats и /health. */
  ADMIN_USER_IDS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number)
        .filter((n) => Number.isFinite(n)),
    ),
});

const parsed = schema.safeParse({
  ...process.env,
  // Vercel сам выставляет VERCEL=1 — не заставляем задавать это руками.
  SERVERLESS: process.env.SERVERLESS ?? (process.env.VERCEL ? 'true' : 'false'),
});

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  console.error(`Некорректная конфигурация окружения:\n${issues}\n\nСм. .env.example`);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
