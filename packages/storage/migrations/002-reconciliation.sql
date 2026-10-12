ALTER TABLE apcs_commands ADD COLUMN reconciliation jsonb;
ALTER TABLE apcs_commands ADD CONSTRAINT apcs_reconciliation_only_unknown
  CHECK (reconciliation IS NULL OR snapshot->>'state' = 'Unknown');
DROP INDEX apcs_one_unfinished_command_per_output;
CREATE UNIQUE INDEX apcs_one_unfinished_command_per_output ON apcs_commands (target_signal_id)
  WHERE snapshot->>'state' IN ('Accepted', 'Dispatched', 'DeviceAccepted', 'Unknown')
    AND reconciliation IS NULL;
