ALTER TABLE apcs_recipe_runs ADD COLUMN binding jsonb;
ALTER TABLE apcs_recipe_runs ADD COLUMN control jsonb;
COMMENT ON COLUMN apcs_recipe_runs.binding IS 'Frozen server-resolved virtual thermal device binding; NULL means isolated model';
