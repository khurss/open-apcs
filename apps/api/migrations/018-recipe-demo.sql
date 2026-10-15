CREATE TABLE apcs_recipe_demo_installations (
 project_id uuid PRIMARY KEY REFERENCES apcs_projects(id),
 manifest jsonb NOT NULL
);
