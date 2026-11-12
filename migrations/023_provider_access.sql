-- Explicit provider entry and agent credentials; no provider or policy is seeded.
-- Existing protocol credentials retain their original values and authority.
CREATE TABLE IF NOT EXISTS guild_provider_setup_operations (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('controlled_setup','revoke_invitation')),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  request jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guild_provider_invitations (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL REFERENCES guild_market_providers(id),
  owner_identity uuid NOT NULL,
  provider_binding_digest text NOT NULL CHECK (provider_binding_digest ~ '^[a-f0-9]{64}$'),
  issuer_identity text NOT NULL,
  browser_origin text NOT NULL,
  service_origin text NOT NULL,
  setup_operation_id uuid NOT NULL REFERENCES guild_provider_setup_operations(id),
  challenge_hash text NOT NULL UNIQUE CHECK (challenge_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  session_expires_at timestamptz NOT NULL,
  consumed_claim_id uuid,
  consumed_session_id uuid UNIQUE REFERENCES guild_sessions(id),
  consumed_at timestamptz,
  retained_result jsonb,
  revoked_at timestamptz,
  revoke_operation_id uuid REFERENCES guild_provider_setup_operations(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (session_expires_at >= expires_at),
  CHECK ((consumed_claim_id IS NULL AND consumed_session_id IS NULL AND consumed_at IS NULL AND retained_result IS NULL)
    OR (consumed_claim_id IS NOT NULL AND consumed_session_id IS NOT NULL AND consumed_at IS NOT NULL AND retained_result IS NOT NULL)),
  CHECK ((revoked_at IS NULL) = (revoke_operation_id IS NULL))
);
CREATE INDEX IF NOT EXISTS guild_provider_invitations_owner
  ON guild_provider_invitations(provider_id,owner_identity,created_at);

ALTER TABLE guild_market_protocol_clients ADD COLUMN IF NOT EXISTS access_kind text
  CHECK (access_kind IS NULL OR access_kind IN ('customer','provider'));
ALTER TABLE guild_market_protocol_clients ADD COLUMN IF NOT EXISTS label text
  CHECK (label IS NULL OR char_length(label) BETWEEN 1 AND 80);
ALTER TABLE guild_market_protocol_clients ADD COLUMN IF NOT EXISTS token_prefix text
  CHECK (token_prefix IS NULL OR char_length(token_prefix) BETWEEN 3 AND 16);
ALTER TABLE guild_market_protocol_clients ADD COLUMN IF NOT EXISTS owner_identity uuid;
ALTER TABLE guild_market_protocol_clients ADD COLUMN IF NOT EXISTS issued_command_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS guild_market_protocol_client_issue
  ON guild_market_protocol_clients(actor_id,issued_command_id) WHERE issued_command_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS guild_provider_access_commands (
  actor_id uuid NOT NULL REFERENCES guild_sessions(id),
  tenant_id uuid NOT NULL REFERENCES guild_tenants(id),
  command_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('customer','provider')),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  request jsonb NOT NULL,
  -- Issuance results contain safe summaries only. Raw bearer tokens are never saved.
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_id,command_id)
);

-- Attribution for a bounded provider-agent request; the underlying market
-- command still owns the negotiation/task decision and its original result.
CREATE TABLE IF NOT EXISTS guild_provider_agent_authorizations (
  actor_id uuid NOT NULL REFERENCES guild_sessions(id),
  tenant_id uuid NOT NULL REFERENCES guild_tenants(id),
  client_id uuid NOT NULL REFERENCES guild_market_protocol_clients(id),
  command_id uuid NOT NULL,
  provider_id text NOT NULL REFERENCES guild_market_providers(id),
  owner_identity uuid NOT NULL,
  permission text NOT NULL CHECK (permission IN ('provider:negotiate','provider:cancel')),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  decision_already_recorded boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(actor_id,client_id,command_id)
);

INSERT INTO guild_schema_migrations(version) VALUES(23) ON CONFLICT DO NOTHING;
