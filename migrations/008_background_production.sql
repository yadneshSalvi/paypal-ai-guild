-- A provider response is a durable operation, separate from a worker invocation.
-- Historical foreground runs remain unchanged; an unresolved one is never replayed.
ALTER TABLE guild_jobs ADD COLUMN IF NOT EXISTS continuation_count integer NOT NULL DEFAULT 0;
ALTER TABLE guild_model_runs ADD COLUMN IF NOT EXISTS operation_key text;
ALTER TABLE guild_model_runs ADD COLUMN IF NOT EXISTS provider_status text;
ALTER TABLE guild_model_runs ADD COLUMN IF NOT EXISTS provider_output_text text;
ALTER TABLE guild_model_runs ADD COLUMN IF NOT EXISTS failure_code text;
ALTER TABLE guild_model_runs ADD COLUMN IF NOT EXISTS poll_after timestamptz;
ALTER TABLE guild_model_runs ADD COLUMN IF NOT EXISTS poll_count integer NOT NULL DEFAULT 0;
ALTER TABLE guild_model_runs ADD COLUMN IF NOT EXISTS provider_request_id text;
ALTER TABLE guild_model_runs ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS guild_model_operation_identity
 ON guild_model_runs(tenant_id,job_id,operation_key) WHERE operation_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS guild_model_pending_response
 ON guild_model_runs(tenant_id,job_id,poll_after) WHERE status='running' AND provider_response_id IS NOT NULL;
INSERT INTO guild_schema_migrations(version) VALUES(8) ON CONFLICT DO NOTHING;
