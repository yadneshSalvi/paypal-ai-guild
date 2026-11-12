-- Publication is separate from acceptance, production authority and settlement.
-- Editions and their events are retained; withdrawal never mutates original files.
CREATE TABLE IF NOT EXISTS guild_web_publication_heads (
 tenant_id uuid NOT NULL REFERENCES guild_tenants(id), commission_id uuid NOT NULL REFERENCES guild_commissions(id),
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0), last_version integer NOT NULL DEFAULT 0 CHECK(last_version>=0),
 current_edition_id uuid, event_sequence integer NOT NULL DEFAULT 0 CHECK(event_sequence>=0), event_hash text,
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,commission_id),
 CHECK(event_hash IS NULL OR event_hash ~ '^[a-f0-9]{64}$')
);
CREATE TABLE IF NOT EXISTS guild_web_publication_proposals (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, commission_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES guild_sessions(id), command_id uuid NOT NULL,
 expected_revision integer NOT NULL CHECK(expected_revision>=0), proposal_digest text NOT NULL CHECK(proposal_digest ~ '^[a-f0-9]{64}$'),
 proposal jsonb NOT NULL, signature text NOT NULL CHECK(signature ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 FOREIGN KEY(tenant_id,commission_id) REFERENCES guild_web_publication_heads(tenant_id,commission_id),
 UNIQUE(tenant_id,command_id), UNIQUE(id,tenant_id), CHECK(expires_at>created_at)
);
CREATE TABLE IF NOT EXISTS guild_web_publication_editions (
 id uuid PRIMARY KEY, public_id text NOT NULL UNIQUE CHECK(public_id ~ '^[a-f0-9]{48}$'),
 tenant_id uuid NOT NULL, commission_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
 revision integer NOT NULL CHECK(revision>0), proposal_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES guild_sessions(id),
 proposal_digest text NOT NULL CHECK(proposal_digest ~ '^[a-f0-9]{64}$'), proposal jsonb NOT NULL,
 manifest_bytes bytea NOT NULL CHECK(octet_length(manifest_bytes)>0),
 signature text NOT NULL CHECK(signature ~ '^[a-f0-9]{64}$'), created_at timestamptz NOT NULL,
 FOREIGN KEY(tenant_id,commission_id) REFERENCES guild_web_publication_heads(tenant_id,commission_id),
 FOREIGN KEY(proposal_id,tenant_id) REFERENCES guild_web_publication_proposals(id,tenant_id),
 UNIQUE(tenant_id,commission_id,version), UNIQUE(proposal_id), UNIQUE(id,tenant_id)
);
CREATE TABLE IF NOT EXISTS guild_web_publication_events (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, commission_id uuid NOT NULL,
 edition_id uuid NOT NULL, sequence integer NOT NULL CHECK(sequence>0), revision integer NOT NULL CHECK(revision>0),
 event_type text NOT NULL CHECK(event_type IN ('published','withdrawn')),
 actor_id uuid NOT NULL REFERENCES guild_sessions(id), command_id uuid NOT NULL,
 body jsonb NOT NULL, previous_hash text, event_hash text NOT NULL CHECK(event_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL,
 FOREIGN KEY(edition_id,tenant_id) REFERENCES guild_web_publication_editions(id,tenant_id),
 UNIQUE(tenant_id,commission_id,sequence), UNIQUE(edition_id,event_type),
 CHECK(previous_hash IS NULL OR previous_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX IF NOT EXISTS guild_web_publication_history ON guild_web_publication_events(tenant_id,commission_id,sequence);
CREATE TABLE IF NOT EXISTS guild_web_publication_commands (
 tenant_id uuid NOT NULL REFERENCES guild_tenants(id), command_id uuid NOT NULL, commission_id uuid NOT NULL REFERENCES guild_commissions(id),
 actor_id uuid NOT NULL REFERENCES guild_sessions(id), kind text NOT NULL CHECK(kind IN ('prepare','publish','withdraw')),
 payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'), result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,command_id)
);
CREATE TABLE IF NOT EXISTS guild_web_publication_downloads (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, edition_id uuid NOT NULL, path text NOT NULL,
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'), byte_length bigint NOT NULL CHECK(byte_length>0),
 disposition text NOT NULL CHECK(disposition IN ('complete_response','range_response','not_modified','head_response')),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(edition_id,tenant_id) REFERENCES guild_web_publication_editions(id,tenant_id)
);
-- Application credentials may append records but may not rewrite their history.
CREATE OR REPLACE FUNCTION guild_reject_publication_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Publication records are append-only' USING ERRCODE='23000'; END;
$$;
DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['guild_web_publication_proposals','guild_web_publication_editions','guild_web_publication_events','guild_web_publication_commands','guild_web_publication_downloads'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS guild_publication_immutable ON %I',table_name);
  EXECUTE format('CREATE TRIGGER guild_publication_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guild_reject_publication_rewrite()',table_name);
 END LOOP;
END $$;
INSERT INTO guild_schema_migrations(version) VALUES(18) ON CONFLICT DO NOTHING;
