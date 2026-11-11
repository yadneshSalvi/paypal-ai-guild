-- Old requests stay immutable. Only new requests carry canonical server history.
ALTER TABLE guild_schedule_ai_runs ADD COLUMN IF NOT EXISTS request_intent jsonb;
ALTER TABLE guild_schedule_ai_runs ADD COLUMN IF NOT EXISTS canonical_input_hash text
  CHECK(canonical_input_hash IS NULL OR canonical_input_hash ~ '^[a-f0-9]{64}$');
INSERT INTO guild_schema_migrations(version) VALUES(15) ON CONFLICT DO NOTHING;
