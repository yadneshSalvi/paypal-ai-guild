CREATE TABLE IF NOT EXISTS guild_caption_corrections (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES guild_tenants(id),
 commission_id uuid NOT NULL REFERENCES guild_commissions(id), package_id text NOT NULL, contract_version integer NOT NULL,
 previous_job_id uuid NOT NULL REFERENCES guild_jobs(id), actor_id uuid NOT NULL REFERENCES guild_sessions(id),
 agreement_digest text NOT NULL CHECK(agreement_digest ~ '^[a-f0-9]{64}$'), agreement jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,commission_id,package_id,contract_version)
);
CREATE TABLE IF NOT EXISTS guild_alignment_runs (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES guild_tenants(id),
 commission_id uuid NOT NULL REFERENCES guild_commissions(id), package_id text NOT NULL, job_id uuid NOT NULL REFERENCES guild_jobs(id),
 media_id uuid NOT NULL REFERENCES guild_media_objects(id), capability_version text NOT NULL, operation_key text NOT NULL,
 input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'), request jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('prepared','dispatching','received','failed','indeterminate')),
 failure_code text, dispatched_at timestamptz, completed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,job_id,operation_key), UNIQUE(tenant_id,job_id,media_id,capability_version), UNIQUE(id,tenant_id)
);
CREATE TABLE IF NOT EXISTS guild_alignment_observations (
 run_id uuid PRIMARY KEY, tenant_id uuid NOT NULL, receipt_hash text NOT NULL CHECK(receipt_hash ~ '^[a-f0-9]{64}$'), receipt jsonb NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(run_id,tenant_id) REFERENCES guild_alignment_runs(id,tenant_id)
);
CREATE TABLE IF NOT EXISTS guild_caption_capability_holds (
 tenant_id uuid NOT NULL REFERENCES guild_tenants(id), capability_version text NOT NULL, run_id uuid NOT NULL,
 failure_code text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,capability_version), FOREIGN KEY(run_id,tenant_id) REFERENCES guild_alignment_runs(id,tenant_id)
);
INSERT INTO guild_schema_migrations(version) VALUES(16) ON CONFLICT DO NOTHING;
