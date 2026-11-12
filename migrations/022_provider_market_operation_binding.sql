-- An interrupted dispatch retains its original enrolled endpoint and card.
ALTER TABLE guild_market_operations ADD COLUMN IF NOT EXISTS provider_endpoint text;
ALTER TABLE guild_market_operations ADD COLUMN IF NOT EXISTS provider_card jsonb;
ALTER TABLE guild_market_operations ADD COLUMN IF NOT EXISTS provider_card_digest text
  CHECK (provider_card_digest IS NULL OR provider_card_digest ~ '^[a-f0-9]{64}$');

-- Capacity follows the retained worker, including continuations and results.
-- Reading task status never changes work, acceptance or payment records.
CREATE OR REPLACE FUNCTION guild_market_project_job_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    UPDATE guild_market_tasks
      SET state=CASE NEW.state
        WHEN 'running' THEN 'working'
        WHEN 'queued' THEN 'submitted'
        WHEN 'completed' THEN 'completed'
        WHEN 'failed' THEN 'failed'
        WHEN 'needs_review' THEN 'input_required'
        ELSE state END,
        revision=revision+1,updated_at=NEW.updated_at
      WHERE original_job_id=NEW.id AND tenant_id=NEW.tenant_id
        AND state NOT IN ('cancelled','rejected');
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS guild_market_job_state_projection ON guild_jobs;
CREATE TRIGGER guild_market_job_state_projection AFTER UPDATE OF state ON guild_jobs
  FOR EACH ROW EXECUTE FUNCTION guild_market_project_job_state();

INSERT INTO guild_schema_migrations(version) VALUES(22) ON CONFLICT DO NOTHING;
