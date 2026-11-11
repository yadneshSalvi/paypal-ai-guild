CREATE TABLE IF NOT EXISTS guild_payout_operations (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES guild_tenants(id),
 commission_id uuid NOT NULL REFERENCES guild_commissions(id),
 package_id text NOT NULL, contract_version integer NOT NULL, provider_id text NOT NULL,
 acceptance_id uuid NOT NULL REFERENCES guild_acceptance_decisions(id),
 capture_operation_id uuid NOT NULL REFERENCES guild_payment_intents(id),
 approval_id uuid NOT NULL REFERENCES guild_approval_receipts(id),
 amount_minor bigint NOT NULL CHECK(amount_minor>0), currency text NOT NULL CHECK(currency='USD'),
 receiver_hash text NOT NULL, request_hash text NOT NULL, document text NOT NULL,
 state text NOT NULL DEFAULT 'claimed' CHECK(state IN ('claimed','dispatching','pending_reconciliation','succeeded','refused','not_sent')),
 provider_status text, batch_id text, item_id text, fee_minor bigint, error_code text,
 cancel_state text CHECK(cancel_state IN ('dispatching','pending_reconciliation','succeeded','refused','not_sent')),
 lease_owner uuid, lease_until timestamptz, version integer NOT NULL DEFAULT 1, attempts integer NOT NULL DEFAULT 0,
 observed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,commission_id,package_id,contract_version), UNIQUE(batch_id), UNIQUE(item_id)
);
CREATE INDEX IF NOT EXISTS guild_payouts_owner ON guild_payout_operations(tenant_id,commission_id,created_at);
CREATE TABLE IF NOT EXISTS guild_payout_attempts (
 id uuid PRIMARY KEY, payout_id uuid NOT NULL REFERENCES guild_payout_operations(id),
 operation text NOT NULL, outcome text NOT NULL, safe_code text, observed_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO guild_schema_migrations(version) VALUES(4) ON CONFLICT DO NOTHING;
