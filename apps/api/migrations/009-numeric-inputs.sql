-- Extend the catalog for typed input bindings. Actuator commands remain boolean.
ALTER TABLE apcs_signals DROP CONSTRAINT apcs_signals_data_type_check;
ALTER TABLE apcs_signals DROP CONSTRAINT apcs_signals_direction_check;
ALTER TABLE apcs_signals ADD CONSTRAINT apcs_signals_data_type_check CHECK (data_type IN ('boolean', 'float64'));
ALTER TABLE apcs_signals ADD CONSTRAINT apcs_signals_direction_check CHECK (direction IN ('input', 'output'));
ALTER TABLE apcs_signals ADD CONSTRAINT apcs_signals_output_type_check CHECK (direction <> 'output' OR data_type = 'boolean');
