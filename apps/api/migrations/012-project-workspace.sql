ALTER TABLE apcs_devices ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0);
ALTER TABLE apcs_signals ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0);
CREATE TABLE apcs_demo_installations (
  owner_id uuid PRIMARY KEY REFERENCES apcs_users(id),
  project_id uuid NOT NULL UNIQUE REFERENCES apcs_projects(id),
  manifest jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
