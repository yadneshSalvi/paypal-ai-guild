ALTER TABLE guild_payment_tool_runs ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS guild_payment_reader_active ON guild_payment_tool_runs(tenant_id,commission_id,tool,resource_id) WHERE state='running';
ALTER TABLE guild_payout_operations ADD COLUMN IF NOT EXISTS cancel_lease_until timestamptz;
INSERT INTO guild_schema_migrations(version) VALUES(7) ON CONFLICT DO NOTHING;
