CREATE TABLE apcs_recipes (
 id uuid NOT NULL,
 project_id uuid NOT NULL REFERENCES apcs_projects(id),
 revision integer NOT NULL CHECK (revision > 0),
 name text NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
 parameters jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(id, revision), UNIQUE(project_id, id, revision)
);
CREATE INDEX apcs_recipes_project ON apcs_recipes(project_id,id,revision DESC);
CREATE TABLE apcs_recipe_runs (
 id uuid PRIMARY KEY,
 project_id uuid NOT NULL REFERENCES apcs_projects(id),
 recipe_id uuid NOT NULL,
 revision integer NOT NULL,
 actor_id uuid NOT NULL REFERENCES apcs_users(id),
 snapshot jsonb NOT NULL,
 events jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(project_id,recipe_id,revision) REFERENCES apcs_recipes(project_id,id,revision)
);
CREATE UNIQUE INDEX apcs_recipe_one_running ON apcs_recipe_runs(project_id) WHERE snapshot->>'status'='Running';
CREATE INDEX apcs_recipe_run_history ON apcs_recipe_runs(project_id,created_at DESC,id DESC);
