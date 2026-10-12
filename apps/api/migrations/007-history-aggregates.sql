CREATE TABLE apcs_history_aggregates (
  signal_id uuid NOT NULL REFERENCES apcs_signals(id),
  resolution integer NOT NULL CHECK(resolution IN (60,3600)),
  bucket_start timestamptz NOT NULL,
  aggregate jsonb NOT NULL,
  calculated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(signal_id,resolution,bucket_start)
);
CREATE INDEX apcs_history_aggregate_retention ON apcs_history_aggregates(bucket_start);
CREATE TABLE apcs_history_aggregate_jobs (
  signal_id uuid NOT NULL REFERENCES apcs_signals(id),
  resolution integer NOT NULL CHECK(resolution IN (60,3600)),
  bucket_start timestamptz NOT NULL,
  retry_at timestamptz NOT NULL DEFAULT '-infinity',
  last_error text,
  PRIMARY KEY(signal_id,resolution,bucket_start)
);
CREATE INDEX apcs_history_aggregate_due ON apcs_history_aggregate_jobs(bucket_start,retry_at);
CREATE FUNCTION apcs_queue_history_aggregates(ids uuid[], times timestamptz[]) RETURNS void LANGUAGE sql AS $$
  INSERT INTO apcs_history_aggregate_jobs(signal_id,resolution,bucket_start)
  SELECT DISTINCT sample.signal_id,period.seconds,bucket.start
  FROM unnest(ids,times) AS sample(signal_id,observed_at)
  CROSS JOIN (VALUES(60),(3600)) AS period(seconds)
  CROSS JOIN LATERAL generate_series(
    date_bin(make_interval(secs=>period.seconds),sample.observed_at-interval '120 seconds',timestamptz '1970-01-01 00:00:00+00'),
    date_bin(make_interval(secs=>period.seconds),sample.observed_at+interval '120 seconds',timestamptz '1970-01-01 00:00:00+00'),
    make_interval(secs=>period.seconds)) AS bucket(start)
  ORDER BY sample.signal_id,period.seconds,bucket.start
  ON CONFLICT(signal_id,resolution,bucket_start) DO UPDATE SET retry_at='-infinity',last_error=NULL;
$$;
CREATE FUNCTION apcs_history_aggregate_inserted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM apcs_queue_history_aggregates(array_agg(signal_id),array_agg(observed_at)) FROM inserted_samples;
  RETURN NULL;
END;
$$;
CREATE TRIGGER apcs_history_aggregate_inserted AFTER INSERT ON apcs_signal_history
  REFERENCING NEW TABLE AS inserted_samples FOR EACH STATEMENT EXECUTE FUNCTION apcs_history_aggregate_inserted();
CREATE TABLE apcs_history_aggregate_backfill (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  cursor_ordinal bigint NOT NULL DEFAULT 0,
  through_ordinal bigint NOT NULL,
  done boolean NOT NULL DEFAULT false
);
INSERT INTO apcs_history_aggregate_backfill(singleton,through_ordinal)
  SELECT true,COALESCE(max(ordinal),0) FROM apcs_signal_history;
CREATE TABLE apcs_history_aggregate_service (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  heartbeat_at timestamptz NOT NULL,
  state text NOT NULL CHECK(state IN ('running','stopped','faulted')),
  last_error text
);
