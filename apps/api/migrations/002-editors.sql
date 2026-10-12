CREATE TABLE apcs_documents (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES apcs_projects(id),
  kind text NOT NULL CHECK (kind IN ('graph', 'screen')),
  name text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  document jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX apcs_documents_by_project ON apcs_documents(project_id, kind, id);
CREATE TABLE apcs_document_revisions (
  document_id uuid NOT NULL REFERENCES apcs_documents(id),
  revision integer NOT NULL CHECK (revision > 0),
  name text NOT NULL,
  document jsonb NOT NULL,
  checksum text NOT NULL CHECK (length(checksum) = 64),
  actor_id uuid NOT NULL REFERENCES apcs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (document_id, revision)
);
CREATE FUNCTION apcs_immutable_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Prepared document revisions are immutable';
END;
$$;
CREATE TRIGGER apcs_immutable_revision BEFORE UPDATE OR DELETE ON apcs_document_revisions
  FOR EACH ROW EXECUTE FUNCTION apcs_immutable_revision();
