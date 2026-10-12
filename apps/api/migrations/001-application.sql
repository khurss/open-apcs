CREATE TABLE apcs_users (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE apcs_sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES apcs_users(id) ON DELETE CASCADE,
  csrf_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX apcs_sessions_expiry ON apcs_sessions(expires_at);
CREATE TABLE apcs_projects (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  owner_id uuid NOT NULL REFERENCES apcs_users(id)
);
CREATE TABLE apcs_devices (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES apcs_projects(id),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('virtual-led', 'esp32-led')),
  site_id text NOT NULL,
  protocol_device_id text NOT NULL,
  UNIQUE (site_id, protocol_device_id)
);
CREATE INDEX apcs_devices_project ON apcs_devices(project_id);
CREATE TABLE apcs_signals (
  id uuid PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES apcs_devices(id),
  name text NOT NULL,
  data_type text NOT NULL CHECK (data_type = 'boolean'),
  direction text NOT NULL CHECK (direction = 'output'),
  freshness_ms integer NOT NULL DEFAULT 3000 CHECK (freshness_ms > 0)
);
CREATE INDEX apcs_signals_device ON apcs_signals(device_id);
CREATE TABLE apcs_audit (
  id bigserial PRIMARY KEY,
  actor_id uuid REFERENCES apcs_users(id),
  action text NOT NULL,
  resource_id text,
  data jsonb NOT NULL,
  at timestamptz NOT NULL DEFAULT clock_timestamp()
);
