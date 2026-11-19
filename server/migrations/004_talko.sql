-- TALKO CRM as the system of record: the app becomes a mobile front end for TALKO finance.
ALTER TABLE integrations DROP CONSTRAINT integrations_kind_check;
ALTER TABLE integrations ADD CONSTRAINT integrations_kind_check CHECK (kind IN ('telegram', 'monobank', 'webhook', 'mcp', 'talko'));
ALTER TABLE settings ADD COLUMN data_source TEXT NOT NULL DEFAULT 'local' CHECK (data_source IN ('local', 'talko'));
