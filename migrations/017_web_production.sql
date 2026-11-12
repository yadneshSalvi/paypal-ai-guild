CREATE TABLE IF NOT EXISTS guild_web_corrections (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES guild_tenants(id),
 commission_id uuid NOT NULL REFERENCES guild_commissions(id), package_id text NOT NULL, contract_version integer NOT NULL,
 previous_job_id uuid NOT NULL REFERENCES guild_jobs(id), actor_id uuid NOT NULL REFERENCES guild_sessions(id),
 agreement_digest text NOT NULL CHECK(agreement_digest ~ '^[a-f0-9]{64}$'), agreement jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,commission_id,package_id,contract_version)
);
CREATE TABLE IF NOT EXISTS guild_web_audit_cases (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES guild_tenants(id),
 commission_id uuid NOT NULL REFERENCES guild_commissions(id), package_id text NOT NULL, contract_version integer NOT NULL,
 job_id uuid NOT NULL REFERENCES guild_jobs(id), case_key text NOT NULL, mode text NOT NULL CHECK(mode IN ('producer','independent')),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'), request jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('prepared','dispatching','received','failed','indeterminate')),
 failure_code text, dispatched_at timestamptz, completed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,job_id,case_key), UNIQUE(id,tenant_id)
);
CREATE TABLE IF NOT EXISTS guild_web_audit_observations (
 case_id uuid PRIMARY KEY, tenant_id uuid NOT NULL, result_hash text NOT NULL CHECK(result_hash ~ '^[a-f0-9]{64}$'), result jsonb NOT NULL,
 evidence_manifest jsonb NOT NULL, signature text NOT NULL CHECK(signature ~ '^[a-f0-9]{64}$'),
 observed_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(case_id,tenant_id) REFERENCES guild_web_audit_cases(id,tenant_id)
);
CREATE TABLE IF NOT EXISTS guild_web_audit_files (
 case_id uuid NOT NULL, tenant_id uuid NOT NULL, path text NOT NULL CHECK(path ~ '^[a-z][a-z0-9-]{0,150}\.json$'),
 byte_length integer NOT NULL CHECK(byte_length>0 AND byte_length<=16777216), content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 bytes bytea NOT NULL CHECK(octet_length(bytes)=byte_length), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(case_id,path), FOREIGN KEY(case_id,tenant_id) REFERENCES guild_web_audit_cases(id,tenant_id)
);
CREATE TABLE IF NOT EXISTS guild_web_bundles (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES guild_tenants(id), commission_id uuid NOT NULL REFERENCES guild_commissions(id),
 job_id uuid NOT NULL REFERENCES guild_jobs(id), package_id text NOT NULL, contract_version integer NOT NULL, ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 3),
 manifest_hash text NOT NULL CHECK(manifest_hash ~ '^[a-f0-9]{64}$'), manifest jsonb NOT NULL,
 signature text NOT NULL CHECK(signature ~ '^[a-f0-9]{64}$'), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,job_id,ordinal), UNIQUE(id,tenant_id)
);
CREATE TABLE IF NOT EXISTS guild_web_bundle_files (
 bundle_id uuid NOT NULL, tenant_id uuid NOT NULL, path text NOT NULL,
 byte_length integer NOT NULL CHECK(byte_length>0 AND byte_length<=16777216), content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 bytes bytea NOT NULL CHECK(octet_length(bytes)=byte_length), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(bundle_id,path), FOREIGN KEY(bundle_id,tenant_id) REFERENCES guild_web_bundles(id,tenant_id)
);
INSERT INTO guild_schema_migrations(version) VALUES(17) ON CONFLICT DO NOTHING;
