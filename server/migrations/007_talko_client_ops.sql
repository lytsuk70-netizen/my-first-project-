-- Idempotency for the phone's offline queue: a resent change is answered from here instead of written to TALKO twice.
CREATE TABLE talko_client_ops (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id  TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  result     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, client_id)
);
