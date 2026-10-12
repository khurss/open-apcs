CREATE TABLE apcs_commands (
  id text PRIMARY KEY,
  actor_id text NOT NULL,
  idempotency_key text NOT NULL,
  target_signal_id text NOT NULL,
  fingerprint text NOT NULL,
  request jsonb NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  UNIQUE (actor_id, idempotency_key),
  CHECK (snapshot->>'id' = id),
  CHECK (snapshot->>'targetSignalId' = target_signal_id),
  CHECK (snapshot->>'state' IN ('Requested', 'Rejected', 'Accepted', 'Dispatched',
    'DeviceAccepted', 'Verified', 'Failed', 'Expired', 'Cancelled', 'Unknown'))
);

-- Unknown keeps the output blocked until explicit reconciliation is implemented.
CREATE UNIQUE INDEX apcs_one_unfinished_command_per_output ON apcs_commands (target_signal_id)
  WHERE snapshot->>'state' IN ('Accepted', 'Dispatched', 'DeviceAccepted', 'Unknown');
CREATE INDEX apcs_command_deadlines ON apcs_commands (expires_at, id)
  WHERE snapshot->>'state' IN ('Accepted', 'Dispatched', 'DeviceAccepted');

CREATE TABLE apcs_command_events (
  command_id text NOT NULL REFERENCES apcs_commands(id),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  state text NOT NULL,
  at timestamptz NOT NULL,
  reason text,
  PRIMARY KEY (command_id, ordinal)
);

CREATE TABLE apcs_command_outbox (
  command_id text PRIMARY KEY REFERENCES apcs_commands(id),
  state text NOT NULL CHECK (state IN ('pending', 'consumed', 'closed')),
  attempt_id uuid,
  CHECK (state <> 'pending' OR attempt_id IS NULL),
  CHECK (state <> 'consumed' OR attempt_id IS NOT NULL)
);
CREATE INDEX apcs_pending_deliveries ON apcs_command_outbox (command_id) WHERE state = 'pending';
