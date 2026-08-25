-- Применяется автоматически при старте (idempotent).

CREATE TABLE IF NOT EXISTS conversations (
  id               BIGSERIAL PRIMARY KEY,
  conversation_key TEXT NOT NULL UNIQUE,
  platform         TEXT NOT NULL,
  chat_id          TEXT NOT NULL,
  thread_id        TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  platform_user_id TEXT,
  user_name       TEXT,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT NOT NULL,
  has_media       BOOLEAN NOT NULL DEFAULT false,
  model           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Основной индекс выборки контекста: последние N сообщений одного разговора.
CREATE INDEX IF NOT EXISTS messages_conversation_created_idx
  ON messages (conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS summaries (
  conversation_id      BIGINT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  summary              TEXT NOT NULL,
  -- До какого сообщения история уже свёрнута: всё новее идёт в контекст сырым.
  covered_until_msg_id BIGINT NOT NULL,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usage_log (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT REFERENCES conversations(id) ON DELETE SET NULL,
  model           TEXT NOT NULL,
  role_name       TEXT NOT NULL,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS usage_log_created_idx ON usage_log (created_at DESC);

-- Счётчик суточной квоты бесплатного тира. Одна строка на сутки UTC.
-- Живёт в БД, а не в памяти, чтобы переживать рестарт.
CREATE TABLE IF NOT EXISTS quota_usage (
  day        DATE PRIMARY KEY,
  free_calls INTEGER NOT NULL DEFAULT 0
);

-- Идемпотентность: Telegram переприсылает апдейт, если вебхук не ответил вовремя.
CREATE TABLE IF NOT EXISTS processed_updates (
  platform     TEXT NOT NULL,
  update_id    TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, update_id)
);

-- Закрываем таблицы от Data API.
--
-- На Supabase всё, что лежит в схеме public, автоматически доступно через PostgREST
-- по anon-ключу, а этот ключ публичен по замыслу. История переписки публичной быть
-- не должна. Политик не создаём ни одной — значит для anon и authenticated доступа
-- нет вообще. Боту это не мешает: он подключается под владельцем таблиц, а владелец
-- RLS не подчиняется.
--
-- На «чистом» Postgres без PostgREST эти строки безвредны.
ALTER TABLE conversations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages           ENABLE ROW LEVEL SECURITY;
ALTER TABLE summaries          ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_log          ENABLE ROW LEVEL SECURITY;
ALTER TABLE quota_usage        ENABLE ROW LEVEL SECURITY;
ALTER TABLE processed_updates  ENABLE ROW LEVEL SECURITY;
