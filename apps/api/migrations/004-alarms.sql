CREATE TABLE apcs_alarms (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES apcs_projects(id),
  signal_id uuid NOT NULL REFERENCES apcs_signals(id),
  name text NOT NULL,
  priority text NOT NULL CHECK (priority IN ('low','medium','high')),
  definition jsonb NOT NULL,
  state jsonb NOT NULL DEFAULT '{"occurrence":0,"active":false,"acknowledged":true,"available":false,"suppressedUntil":null,"version":0}',
  last_evaluated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX apcs_alarms_project ON apcs_alarms(project_id,id);
CREATE TABLE apcs_alarm_events (
  id bigserial PRIMARY KEY,
  alarm_id uuid NOT NULL REFERENCES apcs_alarms(id),
  version bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('Available','Unavailable','Activated','Reactivated','Returned','Acknowledged','Suppressed','Unsuppressed')),
  occurrence bigint NOT NULL,
  actor_id uuid REFERENCES apcs_users(id),
  reason text,
  at timestamptz NOT NULL,
  UNIQUE (alarm_id,version)
);
CREATE INDEX apcs_alarm_events_history ON apcs_alarm_events(alarm_id,id DESC);
