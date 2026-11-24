-- TALKO keeps only the day of an operation. The app remembers when it recorded each operation, to show the time like «Деньги ОК».
CREATE TABLE talko_tx_time (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  talko_id   TEXT NOT NULL,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, talko_id)
);
