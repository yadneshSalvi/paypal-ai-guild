-- Marketplace state is independent of payment approval and artifact acceptance.
CREATE TABLE IF NOT EXISTS guild_market_providers (
  id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{1,63}$'),
  profile jsonb NOT NULL, profile_revision integer NOT NULL DEFAULT 1 CHECK (profile_revision > 0),
  monogram text NOT NULL, color text NOT NULL, kinds jsonb NOT NULL,
  owner_identity uuid NOT NULL UNIQUE, provenance text NOT NULL CHECK (provenance IN ('guild_controlled_service','external_service')),
  synthetic_fixture boolean NOT NULL DEFAULT false,
  endpoint text NOT NULL UNIQUE, card_url text NOT NULL UNIQUE,
  enrollment_state text NOT NULL DEFAULT 'discovery_required' CHECK (enrollment_state IN ('profile_required','policy_required','discovery_required','ready','unavailable','revoked')),
  current_policy_revision integer NOT NULL DEFAULT 0 CHECK (current_policy_revision >= 0),
  observed_card jsonb, card_digest text CHECK (card_digest IS NULL OR card_digest ~ '^[a-f0-9]{64}$'),
  card_observed_at timestamptz, last_failure text, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS guild_market_provider_sessions (
  session_id uuid PRIMARY KEY REFERENCES guild_sessions(id),
  provider_id text NOT NULL REFERENCES guild_market_providers(id),
  owner_identity uuid NOT NULL, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS guild_market_policies (
  provider_id text NOT NULL REFERENCES guild_market_providers(id), revision integer NOT NULL CHECK (revision > 0),
  id uuid NOT NULL UNIQUE, digest text NOT NULL UNIQUE CHECK (digest ~ '^[a-f0-9]{64}$'),
  previous_digest text, policy jsonb NOT NULL, actor_id uuid NOT NULL REFERENCES guild_sessions(id),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(provider_id,revision)
);
CREATE TABLE IF NOT EXISTS guild_market_threads (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES guild_tenants(id),
  commission_id uuid NOT NULL REFERENCES guild_commissions(id), provider_id text NOT NULL REFERENCES guild_market_providers(id),
  package_id text NOT NULL, revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  state text NOT NULL CHECK (state IN ('requesting','open','selected','declined','withdrawn','expired','superseded','needs_review')),
  original_contract jsonb NOT NULL, latest_terms jsonb, latest_terms_digest text,
  selected_terms jsonb, selected_terms_digest text, prepared_contract jsonb, selected_at timestamptz,
  original_work_ceiling timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS guild_market_threads_owner ON guild_market_threads(tenant_id,commission_id,created_at);
CREATE INDEX IF NOT EXISTS guild_market_threads_provider ON guild_market_threads(provider_id,created_at);
CREATE TABLE IF NOT EXISTS guild_market_messages (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, thread_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0), command_id uuid NOT NULL,
  message jsonb NOT NULL, digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'), previous_digest text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,thread_id) REFERENCES guild_market_threads(tenant_id,id), UNIQUE(thread_id,revision)
);
CREATE TABLE IF NOT EXISTS guild_market_operations (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES guild_tenants(id), actor_id uuid NOT NULL REFERENCES guild_sessions(id),
  command_id uuid NOT NULL, provider_id text NOT NULL REFERENCES guild_market_providers(id),
  commission_id uuid REFERENCES guild_commissions(id), thread_id uuid REFERENCES guild_market_threads(id),
  kind text NOT NULL, state text NOT NULL CHECK (state IN ('prepared','dispatching','completed','needs_review','refused')),
  request_body jsonb NOT NULL, request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  original_message_id uuid NOT NULL UNIQUE, original_task_id uuid, response_body jsonb, response_digest text,
  failure_code text, dispatch_count integer NOT NULL DEFAULT 0 CHECK (dispatch_count >= 0),
  lease_until timestamptz, original_work_ceiling timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(actor_id,command_id)
);
CREATE TABLE IF NOT EXISTS guild_market_commands (
  actor_id uuid NOT NULL REFERENCES guild_sessions(id), command_id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES guild_tenants(id), payload_hash text NOT NULL,
  result jsonb, operation_id uuid REFERENCES guild_market_operations(id),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(actor_id,command_id)
);
CREATE TABLE IF NOT EXISTS guild_market_tasks (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES guild_tenants(id),
  commission_id uuid NOT NULL REFERENCES guild_commissions(id), provider_id text NOT NULL REFERENCES guild_market_providers(id),
  thread_id uuid NOT NULL REFERENCES guild_market_threads(id), actor_id uuid NOT NULL REFERENCES guild_sessions(id),
  package_id text NOT NULL, context_id uuid NOT NULL, revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  state text NOT NULL CHECK (state IN ('submitted','working','input_required','auth_required','completed','failed','cancelled','rejected')),
  binding jsonb NOT NULL, binding_digest text NOT NULL, original_job_id uuid REFERENCES guild_jobs(id),
  cancellation_note text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(thread_id), UNIQUE(original_job_id)
);
CREATE TABLE IF NOT EXISTS guild_market_protocol_receipts (
  provider_id text NOT NULL REFERENCES guild_market_providers(id), tenant_id uuid NOT NULL REFERENCES guild_tenants(id),
  actor_id uuid NOT NULL REFERENCES guild_sessions(id), message_id uuid NOT NULL, request_hash text NOT NULL,
  task_id uuid NOT NULL UNIQUE, task jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider_id,tenant_id,actor_id,message_id)
);
CREATE TABLE IF NOT EXISTS guild_market_protocol_clients (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES guild_tenants(id), actor_id uuid NOT NULL REFERENCES guild_sessions(id),
  token_hash text NOT NULL UNIQUE, scopes jsonb NOT NULL, provider_id text REFERENCES guild_market_providers(id),
  expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS guild_market_approval_links (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES guild_tenants(id), commission_id uuid NOT NULL REFERENCES guild_commissions(id),
  owner_session_id uuid NOT NULL REFERENCES guild_sessions(id), request_id uuid NOT NULL,
  expected_revision integer NOT NULL, approval_digest text NOT NULL, challenge_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_session_id,request_id)
);
INSERT INTO guild_schema_migrations(version) VALUES(21) ON CONFLICT DO NOTHING;
