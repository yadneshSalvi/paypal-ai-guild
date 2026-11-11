CREATE TABLE IF NOT EXISTS guild_contract_amendments (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES guild_tenants(id),
 commission_id uuid NOT NULL REFERENCES guild_commissions(id), package_id text NOT NULL,
 from_version integer NOT NULL, to_version integer NOT NULL CHECK(to_version=from_version+1),
 previous_plan_digest text, proposed_plan_digest text NOT NULL,
 previous_contract jsonb NOT NULL, proposed_contract jsonb NOT NULL,
 actor_id uuid NOT NULL REFERENCES guild_sessions(id), reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,commission_id,package_id,to_version)
);
CREATE TABLE IF NOT EXISTS guild_artifact_reviews (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES guild_tenants(id),
 commission_id uuid NOT NULL REFERENCES guild_commissions(id), package_id text NOT NULL,
 contract_version integer NOT NULL, artifact_id uuid NOT NULL REFERENCES guild_artifacts(id),
 artifact_hash text NOT NULL, criteria_digest text NOT NULL,
 actor_id uuid NOT NULL REFERENCES guild_sessions(id), review_kind text NOT NULL CHECK(review_kind='automated'),
 findings text NOT NULL, disclosures jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS guild_artifact_review_binding ON guild_artifact_reviews(tenant_id,commission_id,artifact_id,created_at);
INSERT INTO guild_schema_migrations(version) VALUES(10) ON CONFLICT DO NOTHING;
