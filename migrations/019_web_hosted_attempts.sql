ALTER TABLE guild_web_audit_cases ADD COLUMN IF NOT EXISTS original_failure_code text;
ALTER TABLE guild_web_audit_cases ADD COLUMN IF NOT EXISTS recovered_at timestamptz;
CREATE TABLE IF NOT EXISTS guild_web_hosted_attempts (
 case_id uuid PRIMARY KEY, tenant_id uuid NOT NULL, job_id uuid NOT NULL REFERENCES guild_jobs(id),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 configuration_digest text NOT NULL CHECK(configuration_digest ~ '^[a-f0-9]{64}$'), snapshot_id text NOT NULL,
 remote_name text NOT NULL CHECK(remote_name ~ '^guild-web-[a-f0-9]{40}$'),
 original_dispatched_at timestamptz NOT NULL, original_worker_id uuid NOT NULL,
 original_session_id text, original_command_id text,
 phase text NOT NULL CHECK(phase IN ('create_intent','session_bound','verify_intent','runtime_verified','upload_intent','uploads_verified','browser_intent','browser_started','browser_finished','evidence_retained','cleanup_intent','cleaned')),
 revision integer NOT NULL CHECK(revision>=0), record jsonb NOT NULL,
 record_hash text NOT NULL CHECK(record_hash ~ '^[a-f0-9]{64}$'), signature text NOT NULL CHECK(signature ~ '^[a-f0-9]{64}$'),
 first_unknown_at timestamptz, last_unknown_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,remote_name), UNIQUE(case_id,tenant_id),
 FOREIGN KEY(case_id,tenant_id) REFERENCES guild_web_audit_cases(id,tenant_id),
 CHECK(record->'binding'->>'caseId'=case_id::text AND record->'binding'->>'tenantId'=tenant_id::text
   AND record->'binding'->>'jobId'=job_id::text AND record->'binding'->>'requestHash'=request_hash
   AND record->'binding'->>'configurationDigest'=configuration_digest AND record->'binding'->>'snapshotId'=snapshot_id
   AND record->'binding'->>'remoteName'=remote_name AND record->>'phase'=phase AND (record->>'revision')::integer=revision)
);
CREATE INDEX IF NOT EXISTS guild_web_hosted_unknown ON guild_web_hosted_attempts(tenant_id,updated_at) WHERE first_unknown_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS guild_web_hosted_events (
 case_id uuid NOT NULL, tenant_id uuid NOT NULL, revision integer NOT NULL CHECK(revision>=0), event_type text NOT NULL,
 record jsonb NOT NULL, record_hash text NOT NULL CHECK(record_hash ~ '^[a-f0-9]{64}$'), signature text NOT NULL CHECK(signature ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(case_id,revision),
 FOREIGN KEY(case_id,tenant_id) REFERENCES guild_web_hosted_attempts(case_id,tenant_id)
);
CREATE TABLE IF NOT EXISTS guild_web_hosted_files (
 case_id uuid NOT NULL, tenant_id uuid NOT NULL, path text NOT NULL CHECK(path ~ '^[a-z][a-z0-9-]{0,150}\.json$'),
 byte_length integer NOT NULL CHECK(byte_length>0 AND byte_length<=16777216), content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 bytes bytea NOT NULL CHECK(octet_length(bytes)=byte_length), signature text NOT NULL CHECK(signature ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(case_id,path),
 FOREIGN KEY(case_id,tenant_id) REFERENCES guild_web_hosted_attempts(case_id,tenant_id)
);
CREATE OR REPLACE FUNCTION guild_web_hosted_preserve_original() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.case_id,NEW.tenant_id,NEW.job_id,NEW.request_hash,NEW.configuration_digest,NEW.snapshot_id,NEW.remote_name,NEW.original_dispatched_at,NEW.original_worker_id)
    IS DISTINCT FROM (OLD.case_id,OLD.tenant_id,OLD.job_id,OLD.request_hash,OLD.configuration_digest,OLD.snapshot_id,OLD.remote_name,OLD.original_dispatched_at,OLD.original_worker_id)
    OR (OLD.original_session_id IS NOT NULL AND NEW.original_session_id IS DISTINCT FROM OLD.original_session_id)
    OR (OLD.original_command_id IS NOT NULL AND NEW.original_command_id IS DISTINCT FROM OLD.original_command_id)
    OR (OLD.first_unknown_at IS NOT NULL AND NEW.first_unknown_at IS DISTINCT FROM OLD.first_unknown_at)
 THEN RAISE EXCEPTION 'The original hosted attempt identity is immutable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guild_web_hosted_preserve_original ON guild_web_hosted_attempts;
CREATE TRIGGER guild_web_hosted_preserve_original BEFORE UPDATE ON guild_web_hosted_attempts FOR EACH ROW EXECUTE FUNCTION guild_web_hosted_preserve_original();
INSERT INTO guild_schema_migrations(version) VALUES(19) ON CONFLICT DO NOTHING;
