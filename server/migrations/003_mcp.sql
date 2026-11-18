-- Claude connector (MCP) access token
ALTER TABLE integrations DROP CONSTRAINT integrations_kind_check;
ALTER TABLE integrations ADD CONSTRAINT integrations_kind_check CHECK (kind IN ('telegram', 'monobank', 'webhook', 'mcp'));
ALTER TABLE transactions DROP CONSTRAINT transactions_source_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_source_check
  CHECK (source IN ('manual', 'voice', 'sms', 'duplicate', 'telegram', 'webhook', 'monobank', 'claude'));
