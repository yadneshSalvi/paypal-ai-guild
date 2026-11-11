CREATE TABLE IF NOT EXISTS guild_webhook_reconciliation (
 merchant_fingerprint text NOT NULL, event_id text NOT NULL, body_hash text NOT NULL,
 event_type text NOT NULL, resource_id text NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','awaiting_ownership','processed','dead_letter')),
 tenant_id uuid REFERENCES guild_tenants(id), commission_id uuid REFERENCES guild_commissions(id),
 attempts integer NOT NULL DEFAULT 0, next_check_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz, error_code text, created_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
 PRIMARY KEY(merchant_fingerprint,event_id)
);
CREATE INDEX IF NOT EXISTS guild_webhook_recovery_due ON guild_webhook_reconciliation(state,next_check_at);
INSERT INTO guild_schema_migrations(version) VALUES(6) ON CONFLICT DO NOTHING;
