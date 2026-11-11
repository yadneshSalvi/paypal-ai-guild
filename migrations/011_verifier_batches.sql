CREATE TABLE IF NOT EXISTS guild_verifier_batches (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES guild_tenants(id), commission_id uuid NOT NULL REFERENCES guild_commissions(id),
 job_id uuid NOT NULL REFERENCES guild_jobs(id), package_id text NOT NULL, artifact_id uuid NOT NULL REFERENCES guild_artifacts(id),
 operation_key text NOT NULL, input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'), request jsonb NOT NULL,
 provider text NOT NULL CHECK(provider='google'), model text NOT NULL,
 state text NOT NULL CHECK(state IN ('dispatching','running','received','completed','failed','indeterminate','unavailable')),
 provider_batch_id text UNIQUE, provider_state text, response_body jsonb, body_hash text, output jsonb, output_hash text,
 failure_code text, poll_count integer NOT NULL DEFAULT 0, poll_after timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 UNIQUE(tenant_id,artifact_id,operation_key)
);
CREATE INDEX IF NOT EXISTS guild_verifier_batches_job ON guild_verifier_batches(tenant_id,job_id,created_at);
INSERT INTO guild_schema_migrations(version) VALUES(11) ON CONFLICT DO NOTHING;
