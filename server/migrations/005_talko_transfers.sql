-- TALKO has no "list transfers" tool, so the app keeps its own log of transfers it made (for the Перекази screen).
CREATE TABLE talko_transfer_log (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  talko_id        TEXT,
  from_account_id TEXT NOT NULL,
  to_account_id   TEXT NOT NULL,
  amount          NUMERIC(18,2) NOT NULL,
  amount_to       NUMERIC(18,2),
  description     TEXT NOT NULL DEFAULT '',
  op_date         DATE NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX talko_transfer_log_user ON talko_transfer_log (user_id, op_date DESC, id DESC);
