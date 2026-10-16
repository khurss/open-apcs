CREATE TABLE apcs_universal_recipe_demo_installations (
 project_id uuid PRIMARY KEY REFERENCES apcs_projects(id) ON DELETE CASCADE,
 manifest jsonb NOT NULL
);
