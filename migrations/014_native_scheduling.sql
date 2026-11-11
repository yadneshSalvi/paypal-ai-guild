CREATE TABLE IF NOT EXISTS guild_schedule_revisions (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES guild_tenants(id),
 commission_id uuid NOT NULL REFERENCES guild_commissions(id), revision integer NOT NULL CHECK(revision>0),
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'), snapshot jsonb NOT NULL, evaluation jsonb NOT NULL,
 actor_id uuid NOT NULL REFERENCES guild_sessions(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(commission_id,revision)
);
CREATE TABLE IF NOT EXISTS guild_schedule_quotes (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES guild_tenants(id),
 commission_id uuid NOT NULL REFERENCES guild_commissions(id), package_id text NOT NULL, provider_id text NOT NULL,
 request_id uuid NOT NULL, terms jsonb NOT NULL, digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'offered' CHECK(state IN ('offered','accepted','withdrawn')),
 issued_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, prepared_at timestamptz,
 approval_id uuid REFERENCES guild_approval_receipts(id), approved_at timestamptz,
 UNIQUE(tenant_id,request_id,provider_id)
);
CREATE TABLE IF NOT EXISTS guild_schedule_proposals (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES guild_tenants(id),
 commission_id uuid NOT NULL REFERENCES guild_commissions(id), base_revision integer NOT NULL,
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'), proposal jsonb NOT NULL,
 state text NOT NULL DEFAULT 'proposed' CHECK(state IN ('proposed','prepared')),
 actor_id uuid NOT NULL REFERENCES guild_sessions(id), created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS guild_schedule_proposals_current ON guild_schedule_proposals(tenant_id,commission_id,created_at DESC);
CREATE INDEX IF NOT EXISTS guild_schedule_quotes_current ON guild_schedule_quotes(tenant_id,commission_id,expires_at);
CREATE TABLE IF NOT EXISTS guild_schedule_ai_runs (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES guild_tenants(id),
 commission_id uuid NOT NULL REFERENCES guild_commissions(id), actor_id uuid NOT NULL REFERENCES guild_sessions(id),
 request_id uuid NOT NULL, conversation_id uuid NOT NULL, request_hash text NOT NULL, request_body jsonb NOT NULL,
 commission_revision integer NOT NULL, schedule_revision integer NOT NULL, source_digest text NOT NULL,
 model text NOT NULL, reasoning text NOT NULL,
 state text NOT NULL CHECK(state IN ('dispatching','running','completed','failed','indeterminate','unavailable')),
 provider_response_id text, provider_status text, provider_output jsonb, result jsonb, failure_code text,
 poll_after timestamptz, poll_count integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,request_id)
);
CREATE INDEX IF NOT EXISTS guild_schedule_ai_pending ON guild_schedule_ai_runs(tenant_id,commission_id,state);
CREATE TABLE IF NOT EXISTS guild_schedule_ai_tool_results (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES guild_tenants(id),
 commission_id uuid NOT NULL REFERENCES guild_commissions(id), run_id uuid NOT NULL REFERENCES guild_schedule_ai_runs(id),
 call_id text NOT NULL, name text NOT NULL, args_hash text NOT NULL, result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 UNIQUE(run_id,call_id)
);
INSERT INTO guild_schema_migrations(version) VALUES(14) ON CONFLICT DO NOTHING;
