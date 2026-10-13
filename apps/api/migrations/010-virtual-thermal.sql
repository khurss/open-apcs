ALTER TABLE apcs_devices DROP CONSTRAINT apcs_devices_kind_check;
ALTER TABLE apcs_devices ADD CONSTRAINT apcs_devices_kind_check CHECK (kind IN ('virtual-led', 'esp32-led', 'virtual-thermal'));
