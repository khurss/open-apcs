CREATE TABLE apcs_report_jobs (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES apcs_users(id),
  signal_id uuid NOT NULL REFERENCES apcs_signals(id),
  request_key uuid NOT NULL,
  period text NOT NULL CHECK (period IN ('day','month')),
  date text NOT NULL CHECK (length(date) BETWEEN 7 AND 10),
  state text NOT NULL DEFAULT 'Queued' CHECK (state IN ('Queued','Generating','Ready','Failed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  lease_until timestamptz,
  lease_token uuid,
  report jsonb,
  pdf bytea CHECK (octet_length(pdf) <= 2097152),
  csv text CHECK (octet_length(csv) <= 524288),
  error text CHECK (length(error) <= 128),
  UNIQUE (actor_id, request_key),
  CHECK ((state='Generating') = (lease_until IS NOT NULL AND lease_token IS NOT NULL)),
  CHECK ((state='Ready') = (report IS NOT NULL AND pdf IS NOT NULL AND csv IS NOT NULL)),
  CHECK (report IS NULL OR octet_length(report::text) <= 524288),
  CHECK ((state IN ('Ready','Failed')) = (completed_at IS NOT NULL)),
  CHECK ((state='Failed') = (error IS NOT NULL))
);
CREATE INDEX apcs_report_queue ON apcs_report_jobs(created_at,id) WHERE state='Queued';
CREATE INDEX apcs_report_owner ON apcs_report_jobs(actor_id,signal_id,created_at DESC);
