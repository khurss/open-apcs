CREATE TABLE apcs_signal_history (
  ordinal bigserial PRIMARY KEY,
  event_id text NOT NULL UNIQUE,
  signal_id uuid NOT NULL REFERENCES apcs_signals(id),
  observed_at timestamptz NOT NULL,
  snapshot jsonb NOT NULL,
  stored_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (jsonb_typeof(snapshot) = 'object'),
  CHECK (snapshot->>'quality' IN ('Good', 'Bad', 'Stale', 'Disconnected'))
);
CREATE INDEX apcs_signal_history_range ON apcs_signal_history(signal_id, observed_at DESC, ordinal DESC);
CREATE INDEX apcs_signal_history_retention ON apcs_signal_history(observed_at, ordinal);
