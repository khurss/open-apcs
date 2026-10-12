CREATE TABLE apcs_notification_service (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  heartbeat_at timestamptz NOT NULL,
  state text NOT NULL CHECK(state IN ('running','stopped','faulted'))
);
