-- Photos and scans attached to a TALKO operation in the app (the file itself is stored in TALKO).
CREATE TABLE talko_tx_files (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  talko_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,
  file_id     TEXT,
  content_type TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX talko_tx_files_tx ON talko_tx_files (user_id, talko_id);
