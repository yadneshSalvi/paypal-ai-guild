-- Append-only attributed drafts/listening attestations. These do not overwrite
-- source artifacts, raw observations, provider timing or acceptance decisions.
CREATE TABLE IF NOT EXISTS guild_caption_review_revisions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES guild_tenants(id),
  commission_id uuid NOT NULL REFERENCES guild_commissions(id),
  package_id text NOT NULL,
  artifact_id uuid NOT NULL REFERENCES guild_artifacts(id),
  artifact_hash text NOT NULL CHECK (artifact_hash ~ '^[a-f0-9]{64}$'),
  locale text NOT NULL CHECK (locale IN ('en','pt','es','fr','ja','ar')),
  track_key text NOT NULL,
  parent_revision_id uuid REFERENCES guild_caption_review_revisions(id),
  request_id uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  actor_id uuid NOT NULL REFERENCES guild_sessions(id),
  revision_digest text NOT NULL CHECK (revision_digest ~ '^[a-f0-9]{64}$'),
  revision jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS guild_caption_review_root ON guild_caption_review_revisions(tenant_id,artifact_id,locale,track_key) WHERE parent_revision_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS guild_caption_review_successor ON guild_caption_review_revisions(parent_revision_id) WHERE parent_revision_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS guild_caption_review_track ON guild_caption_review_revisions(tenant_id,artifact_id,locale,track_key,created_at);
CREATE TABLE IF NOT EXISTS guild_deepgram_caption_corrections (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES guild_tenants(id),
  commission_id uuid NOT NULL REFERENCES guild_commissions(id),
  package_id text NOT NULL,
  contract_version integer NOT NULL,
  base_artifact_id uuid NOT NULL REFERENCES guild_artifacts(id),
  actor_id uuid NOT NULL REFERENCES guild_sessions(id),
  agreement_digest text NOT NULL CHECK (agreement_digest ~ '^[a-f0-9]{64}$'),
  agreement jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,commission_id,package_id,contract_version)
);
CREATE OR REPLACE FUNCTION guild_reject_caption_review_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Caption review history is append-only';
END;
$$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='guild_caption_review_immutable' AND tgrelid='guild_caption_review_revisions'::regclass) THEN
    CREATE TRIGGER guild_caption_review_immutable BEFORE UPDATE OR DELETE ON guild_caption_review_revisions FOR EACH ROW EXECUTE FUNCTION guild_reject_caption_review_mutation();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='guild_deepgram_correction_immutable' AND tgrelid='guild_deepgram_caption_corrections'::regclass) THEN
    CREATE TRIGGER guild_deepgram_correction_immutable BEFORE UPDATE OR DELETE ON guild_deepgram_caption_corrections FOR EACH ROW EXECUTE FUNCTION guild_reject_caption_review_mutation();
  END IF;
END $$;
INSERT INTO guild_schema_migrations(version) VALUES(20) ON CONFLICT DO NOTHING;
