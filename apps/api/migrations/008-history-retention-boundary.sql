CREATE TABLE apcs_history_retention_boundary (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  closed_before timestamptz NOT NULL DEFAULT '-infinity'
);
INSERT INTO apcs_history_retention_boundary(singleton) VALUES(true);
