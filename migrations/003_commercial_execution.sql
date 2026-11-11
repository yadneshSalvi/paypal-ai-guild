CREATE TABLE IF NOT EXISTS guild_payment_intents (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES guild_tenants(id),
 commission_id uuid NOT NULL REFERENCES guild_commissions(id), business_key text NOT NULL,
 kind text NOT NULL, package_id text, contract_version integer,
 approval_id uuid NOT NULL REFERENCES guild_approval_receipts(id),
 acceptance_id uuid REFERENCES guild_acceptance_decisions(id),
 command jsonb NOT NULL, binding jsonb NOT NULL,
 admission_state text NOT NULL DEFAULT 'ready' CHECK(admission_state IN ('ready','cancelled')),
 blocked_reason text,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,business_key)
);
ALTER TABLE guild_payment_intents ADD COLUMN IF NOT EXISTS blocked_reason text;
CREATE INDEX IF NOT EXISTS guild_payment_intents_commission ON guild_payment_intents(tenant_id,commission_id,created_at);
CREATE TABLE IF NOT EXISTS guild_checkout_challenges (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES guild_tenants(id),
 commission_id uuid NOT NULL REFERENCES guild_commissions(id),
 payment_intent_id uuid NOT NULL REFERENCES guild_payment_intents(id),
 actor_id uuid NOT NULL REFERENCES guild_sessions(id), token_hash text NOT NULL,
 expires_at timestamptz NOT NULL, completed_at timestamptz, cancelled_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(payment_intent_id)
);
CREATE TABLE IF NOT EXISTS guild_payment_resources (
 kind text NOT NULL, resource_id text NOT NULL, tenant_id uuid NOT NULL REFERENCES guild_tenants(id),
 commission_id uuid NOT NULL REFERENCES guild_commissions(id), operation_id uuid NOT NULL REFERENCES guild_payment_intents(id),
 resource jsonb NOT NULL, observed_at timestamptz NOT NULL, PRIMARY KEY(kind,resource_id)
);
CREATE INDEX IF NOT EXISTS guild_payment_resources_owner ON guild_payment_resources(tenant_id,commission_id);
CREATE TABLE IF NOT EXISTS guild_payment_capabilities (
 merchant_fingerprint text NOT NULL, feature text NOT NULL, passed boolean NOT NULL,
 evidence jsonb NOT NULL, checked_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(merchant_fingerprint,feature)
);
CREATE TABLE IF NOT EXISTS guild_payment_tool_runs (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES guild_tenants(id),
 commission_id uuid NOT NULL REFERENCES guild_commissions(id), tool text NOT NULL,
 resource_id text NOT NULL, evidence jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE guild_payment_tool_runs ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'completed';
ALTER TABLE guild_payment_tool_runs ADD COLUMN IF NOT EXISTS model_response_id text;
ALTER TABLE guild_payment_tool_runs ADD COLUMN IF NOT EXISTS input_hash text;
ALTER TABLE guild_payment_tool_runs ADD COLUMN IF NOT EXISTS failure_code text;
CREATE TABLE IF NOT EXISTS guild_payment_recovery (
 tenant_id uuid NOT NULL REFERENCES guild_tenants(id), commission_id uuid NOT NULL REFERENCES guild_commissions(id),
 next_check_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, last_check_at timestamptz,
 PRIMARY KEY(tenant_id,commission_id)
);
CREATE TABLE IF NOT EXISTS guild_recourse_holds (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES guild_tenants(id),
 commission_id uuid NOT NULL REFERENCES guild_commissions(id), package_id text NOT NULL,
 state text NOT NULL CHECK(state IN ('open','resolved')), created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO guild_schema_migrations(version) VALUES(3) ON CONFLICT DO NOTHING;
