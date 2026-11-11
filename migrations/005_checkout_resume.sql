ALTER TABLE guild_checkout_challenges ADD COLUMN IF NOT EXISTS resumed_at timestamptz;
ALTER TABLE guild_checkout_challenges ADD COLUMN IF NOT EXISTS resumed_by uuid REFERENCES guild_sessions(id);
INSERT INTO guild_schema_migrations(version) VALUES(5) ON CONFLICT DO NOTHING;
