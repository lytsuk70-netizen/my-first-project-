-- Bank feeds: Telegram bot, monobank personal API, SMS-forwarding webhook.

ALTER TABLE imported_messages DROP CONSTRAINT imported_messages_source_check;
ALTER TABLE imported_messages ADD CONSTRAINT imported_messages_source_check
  CHECK (source IN ('sms', 'share', 'paste', 'telegram', 'webhook', 'monobank'));
ALTER TABLE imported_messages ADD COLUMN external_id TEXT;
CREATE UNIQUE INDEX imported_messages_external_idx ON imported_messages(user_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX imported_messages_status_idx ON imported_messages(user_id, status, created_at DESC);

ALTER TABLE transactions DROP CONSTRAINT transactions_source_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_source_check
  CHECK (source IN ('manual', 'voice', 'sms', 'duplicate', 'telegram', 'webhook', 'monobank'));

CREATE TABLE integrations (
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('telegram', 'monobank', 'webhook')),
  enabled        BOOLEAN NOT NULL DEFAULT true,
  -- non-secret configuration (bot username, account mapping, link code expiry, …)
  config         JSONB NOT NULL DEFAULT '{}',
  -- secrets (bot token / monobank token) encrypted with AES-256-GCM, never returned by the API
  secret_enc     TEXT,
  -- webhook ingest token: only its SHA-256 is stored
  token_hash     TEXT UNIQUE,
  status         TEXT NOT NULL DEFAULT 'ok',
  last_error     TEXT,
  last_sync_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind)
);

CREATE TABLE telegram_chats (
  chat_id     BIGINT PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
