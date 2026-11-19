-- Гроші ОК — initial schema
-- Money is stored as BIGINT minor units (e.g. kopiyky / cents) in the account's own currency.
-- Exchange rates are NUMERIC(20,10). No floating point is used for money anywhere.

CREATE TABLE currencies (
  code      CHAR(3) PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),
  name_uk   TEXT NOT NULL,
  name_en   TEXT NOT NULL,
  symbol    TEXT NOT NULL,
  decimals  SMALLINT NOT NULL DEFAULT 2 CHECK (decimals BETWEEN 0 AND 4)
);

INSERT INTO currencies (code, name_uk, name_en, symbol, decimals) VALUES
  ('UAH', 'Гривня', 'Hryvnia', '₴', 2),
  ('USD', 'Долар США', 'US Dollar', '$', 2),
  ('EUR', 'Євро', 'Euro', '€', 2),
  ('PLN', 'Злотий', 'Polish Zloty', 'zł', 2),
  ('GBP', 'Фунт стерлінгів', 'Pound Sterling', '£', 2),
  ('CHF', 'Швейцарський франк', 'Swiss Franc', 'Fr', 2),
  ('CZK', 'Чеська крона', 'Czech Koruna', 'Kč', 2),
  ('CAD', 'Канадський долар', 'Canadian Dollar', 'C$', 2),
  ('JPY', 'Єна', 'Japanese Yen', '¥', 0),
  ('BTC', 'Біткоїн', 'Bitcoin', '₿', 4);

CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          TEXT NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) BETWEEN 3 AND 200),
  password_hash  TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE settings (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  base_currency  CHAR(3) NOT NULL DEFAULT 'UAH' REFERENCES currencies(code),
  language       TEXT NOT NULL DEFAULT 'uk' CHECK (language IN ('uk', 'en')),
  timezone       TEXT NOT NULL DEFAULT 'Europe/Kyiv',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                   TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 60),
  type                   TEXT NOT NULL CHECK (type IN ('cash', 'bank', 'card', 'savings', 'debt', 'other')),
  currency               CHAR(3) NOT NULL REFERENCES currencies(code),
  initial_balance_minor  BIGINT NOT NULL DEFAULT 0,
  description            TEXT NOT NULL DEFAULT '',
  sms_keywords           TEXT NOT NULL DEFAULT '',
  is_archived            BOOLEAN NOT NULL DEFAULT false,
  sort_order             INTEGER NOT NULL DEFAULT 0,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name),
  UNIQUE (id, user_id)
);

CREATE TABLE categories (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 60),
  type         TEXT NOT NULL CHECK (type IN ('income', 'expense')),
  icon         TEXT NOT NULL DEFAULT '•',
  color        TEXT NOT NULL DEFAULT '#8e8e93' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  parent_id    UUID REFERENCES categories(id) ON DELETE RESTRICT,
  is_archived  BOOLEAN NOT NULL DEFAULT false,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, type, name),
  CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE TABLE projects (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  description  TEXT NOT NULL DEFAULT '',
  is_archived  BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

-- One logical transfer. Its two legs live in `transactions` (transfer_out / transfer_in).
-- "1 rate_base = rate rate_quote"; amounts are the exact values confirmed by the user.
CREATE TABLE transfers (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_account_id        UUID NOT NULL REFERENCES accounts(id),
  to_account_id          UUID NOT NULL REFERENCES accounts(id),
  amount_sent_minor      BIGINT NOT NULL CHECK (amount_sent_minor > 0),
  amount_received_minor  BIGINT NOT NULL CHECK (amount_received_minor > 0),
  rate                   NUMERIC(20, 10) NOT NULL CHECK (rate > 0),
  rate_base              CHAR(3) NOT NULL REFERENCES currencies(code),
  rate_quote             CHAR(3) NOT NULL REFERENCES currencies(code),
  occurred_at            TIMESTAMPTZ NOT NULL,
  comment                TEXT NOT NULL DEFAULT '',
  deleted_at             TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_account_id <> to_account_id)
);
CREATE INDEX transfers_user_date_idx ON transfers(user_id, occurred_at DESC);

CREATE TABLE transactions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          TEXT NOT NULL CHECK (type IN ('expense', 'income', 'transfer_out', 'transfer_in', 'correction')),
  account_id    UUID NOT NULL REFERENCES accounts(id),
  -- Positive for expense/income/transfer legs (direction comes from type); signed for corrections.
  amount_minor  BIGINT NOT NULL,
  currency      CHAR(3) NOT NULL REFERENCES currencies(code),
  category_id   UUID REFERENCES categories(id),
  project_id    UUID REFERENCES projects(id),
  transfer_id   UUID REFERENCES transfers(id),
  occurred_at   TIMESTAMPTZ NOT NULL,
  comment       TEXT NOT NULL DEFAULT '',
  details       TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'voice', 'sms', 'duplicate')),
  deleted_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((type = 'correction' AND amount_minor <> 0) OR (type <> 'correction' AND amount_minor > 0)),
  CHECK ((type IN ('transfer_out', 'transfer_in')) = (transfer_id IS NOT NULL)),
  CHECK (type IN ('income', 'expense') OR (category_id IS NULL AND project_id IS NULL)),
  CHECK (type NOT IN ('income', 'expense') OR category_id IS NOT NULL)
);
CREATE INDEX transactions_user_date_idx ON transactions(user_id, occurred_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX transactions_account_idx ON transactions(account_id) WHERE deleted_at IS NULL;
CREATE INDEX transactions_category_idx ON transactions(category_id);
CREATE INDEX transactions_transfer_idx ON transactions(transfer_id);

-- Integrity: currency must match the account; category type must match the transaction type;
-- every referenced row must belong to the same user.
CREATE FUNCTION transactions_integrity() RETURNS trigger AS $$
DECLARE
  acc RECORD;
  cat RECORD;
BEGIN
  SELECT user_id, currency INTO acc FROM accounts WHERE id = NEW.account_id;
  IF acc.user_id <> NEW.user_id THEN
    RAISE EXCEPTION 'account belongs to another user';
  END IF;
  IF acc.currency <> NEW.currency THEN
    RAISE EXCEPTION 'transaction currency % does not match account currency %', NEW.currency, acc.currency;
  END IF;
  IF NEW.category_id IS NOT NULL THEN
    SELECT user_id, type INTO cat FROM categories WHERE id = NEW.category_id;
    IF cat.user_id <> NEW.user_id OR cat.type <> NEW.type THEN
      RAISE EXCEPTION 'category type mismatch';
    END IF;
  END IF;
  IF NEW.project_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'project belongs to another user';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER transactions_integrity_trg BEFORE INSERT OR UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION transactions_integrity();

-- Accounts may not change currency once they have transactions.
CREATE FUNCTION accounts_currency_lock() RETURNS trigger AS $$
BEGIN
  IF NEW.currency <> OLD.currency AND EXISTS (SELECT 1 FROM transactions WHERE account_id = OLD.id) THEN
    RAISE EXCEPTION 'cannot change currency of an account that has transactions';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER accounts_currency_lock_trg BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION accounts_currency_lock();

-- 1 base = rate quote, e.g. base USD, quote UAH, rate 41.50
CREATE TABLE exchange_rates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rate_date   DATE NOT NULL,
  base        CHAR(3) NOT NULL REFERENCES currencies(code),
  quote       CHAR(3) NOT NULL REFERENCES currencies(code),
  rate        NUMERIC(20, 10) NOT NULL CHECK (rate > 0),
  source      TEXT NOT NULL CHECK (source IN ('manual', 'imported', 'transfer')),
  transfer_id UUID REFERENCES transfers(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (base <> quote)
);
CREATE INDEX exchange_rates_lookup_idx ON exchange_rates(user_id, base, quote, rate_date DESC);

CREATE TABLE attachments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transaction_id  UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  filename        TEXT NOT NULL,
  mime_type       TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf')),
  size_bytes      INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 8388608),
  data            BYTEA NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX attachments_tx_idx ON attachments(transaction_id);

CREATE TABLE imported_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source          TEXT NOT NULL CHECK (source IN ('sms', 'share', 'paste')),
  raw_text        TEXT NOT NULL,
  text_hash       TEXT NOT NULL,
  parsed          JSONB NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'imported', 'ignored')),
  transaction_id  UUID REFERENCES transactions(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, text_hash)
);

CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity      TEXT NOT NULL,
  entity_id   UUID NOT NULL,
  action      TEXT NOT NULL,
  before      JSONB,
  after       JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_user_idx ON audit_log(user_id, created_at DESC);

-- The single source of truth for balances:
-- balance = initial + income - expenses + transfers in - transfers out + corrections
CREATE VIEW account_balances AS
SELECT a.id AS account_id,
       a.user_id,
       a.currency,
       (a.initial_balance_minor
         + COALESCE(SUM(CASE t.type
               WHEN 'income' THEN t.amount_minor
               WHEN 'transfer_in' THEN t.amount_minor
               WHEN 'expense' THEN -t.amount_minor
               WHEN 'transfer_out' THEN -t.amount_minor
               WHEN 'correction' THEN t.amount_minor
             END) FILTER (WHERE t.deleted_at IS NULL), 0))::bigint AS balance_minor
FROM accounts a
LEFT JOIN transactions t ON t.account_id = a.id
GROUP BY a.id;
