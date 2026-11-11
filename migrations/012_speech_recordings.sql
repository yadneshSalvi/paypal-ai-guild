CREATE TABLE IF NOT EXISTS guild_speech_runs (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES guild_tenants(id),
 commission_id uuid NOT NULL REFERENCES guild_commissions(id), job_id uuid NOT NULL REFERENCES guild_jobs(id),
 package_id text NOT NULL, operation_key text NOT NULL, input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'), request jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('connecting','dispatching','streaming','completed','failed','indeterminate')),
 provider_session_id text, provider_response_id text, resolved_model text,
 dispatched_at timestamptz, receipt jsonb, receipt_hash text, pcm_hash text, byte_length bigint, chunk_count integer,
 failure_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 UNIQUE(tenant_id,job_id,operation_key), UNIQUE(id,tenant_id),
 CHECK(byte_length IS NULL OR (byte_length>0 AND byte_length<=8388608)),
 CHECK(chunk_count IS NULL OR (chunk_count>0 AND chunk_count<=4096))
);
CREATE UNIQUE INDEX IF NOT EXISTS guild_speech_provider_response ON guild_speech_runs(provider_response_id) WHERE provider_response_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS guild_speech_chunks (
 run_id uuid NOT NULL, tenant_id uuid NOT NULL, sequence integer NOT NULL CHECK(sequence>=0 AND sequence<4096), event_id text NOT NULL,
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'), byte_length integer NOT NULL CHECK(byte_length>0 AND byte_length<=524288), bytes bytea NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(run_id,sequence), UNIQUE(run_id,event_id), FOREIGN KEY(run_id,tenant_id) REFERENCES guild_speech_runs(id,tenant_id),
 CHECK(octet_length(bytes)=byte_length AND byte_length%2=0)
);
CREATE TABLE IF NOT EXISTS guild_transcription_runs (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES guild_tenants(id),
 commission_id uuid NOT NULL REFERENCES guild_commissions(id), job_id uuid NOT NULL REFERENCES guild_jobs(id), package_id text NOT NULL,
 artifact_id uuid NOT NULL REFERENCES guild_artifacts(id), media_id uuid NOT NULL REFERENCES guild_media_objects(id),
 operation_key text NOT NULL, input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'), request jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('dispatching','completed','failed','indeterminate')),
 output jsonb, output_hash text, response_body text, response_body_hash text, failure_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 UNIQUE(tenant_id,artifact_id,media_id,operation_key)
);
INSERT INTO guild_schema_migrations(version) VALUES(12) ON CONFLICT DO NOTHING;
