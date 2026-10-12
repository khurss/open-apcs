CREATE TABLE apcs_notification_routes (
  id text PRIMARY KEY,
  metadata jsonb NOT NULL,
  fingerprint text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  dropped bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE apcs_notification_deliveries (
  id uuid PRIMARY KEY,
  route_id text NOT NULL REFERENCES apcs_notification_routes(id),
  fingerprint text NOT NULL,
  project_id uuid NOT NULL REFERENCES apcs_projects(id),
  alarm_id uuid NOT NULL REFERENCES apcs_alarms(id),
  event_id text NOT NULL,
  body text NOT NULL CHECK (octet_length(body)<=8192),
  state text NOT NULL CHECK (state IN ('Pending','Sending','Delivered','Dead','Cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 8),
  due_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  lease_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE(route_id,event_id)
);
CREATE INDEX apcs_notification_due ON apcs_notification_deliveries(due_at,id) WHERE state IN ('Pending','Sending');
CREATE INDEX apcs_notification_project ON apcs_notification_deliveries(project_id,created_at DESC,id);
CREATE TABLE apcs_notification_attempts (
  delivery_id uuid NOT NULL REFERENCES apcs_notification_deliveries(id) ON DELETE CASCADE,
  attempt integer NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  outcome text CHECK (outcome IN ('Delivered','Retry','Dead','Unknown','Cancelled')),
  PRIMARY KEY(delivery_id,attempt)
);
