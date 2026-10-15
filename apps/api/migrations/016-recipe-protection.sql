CREATE FUNCTION apcs_immutable_recipe() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Published recipe versions are immutable';
END;
$$;
CREATE TRIGGER apcs_immutable_recipe BEFORE UPDATE OR DELETE ON apcs_recipes
  FOR EACH ROW EXECUTE FUNCTION apcs_immutable_recipe();
