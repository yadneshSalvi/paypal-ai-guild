ALTER TABLE guild_jobs ADD COLUMN IF NOT EXISTS lease_token uuid;
ALTER TABLE guild_model_runs ADD COLUMN IF NOT EXISTS provider_response_id text;
CREATE TABLE IF NOT EXISTS guild_verifications (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES guild_tenants(id), commission_id uuid NOT NULL REFERENCES guild_commissions(id),
 package_id text NOT NULL, contract_version integer NOT NULL, artifact_id uuid NOT NULL REFERENCES guild_artifacts(id), artifact_hash text NOT NULL,
 criteria_digest text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS guild_verifications_binding ON guild_verifications(tenant_id,commission_id,package_id,contract_version,artifact_id,created_at DESC);
CREATE TABLE IF NOT EXISTS guild_approval_receipts (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES guild_tenants(id), commission_id uuid NOT NULL REFERENCES guild_commissions(id),
 actor_id uuid NOT NULL, plan_digest text NOT NULL, payload jsonb NOT NULL, signature text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO guild_schema_migrations(version) VALUES(2) ON CONFLICT DO NOTHING;
