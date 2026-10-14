ALTER TABLE apcs_signals ADD COLUMN unit text NOT NULL DEFAULT '' CHECK (char_length(unit)<=24 AND unit !~ '[[:cntrl:]]');
ALTER TABLE apcs_signals ADD COLUMN display_decimals integer NOT NULL DEFAULT 2 CHECK (display_decimals BETWEEN 0 AND 6);
ALTER TABLE apcs_signals ADD CONSTRAINT numeric_presentation_only CHECK (data_type='float64' OR (unit='' AND display_decimals=2));
