CREATE TABLE IF NOT EXISTS guild_media_objects (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES guild_tenants(id),
 commission_id uuid NOT NULL REFERENCES guild_commissions(id), job_id uuid NOT NULL REFERENCES guild_jobs(id),
 package_id text NOT NULL, operation_key text NOT NULL, media_type text NOT NULL,
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 byte_length bigint NOT NULL CHECK(byte_length>0 AND byte_length<=33554432),
 blob_pathname text NOT NULL UNIQUE, metadata jsonb NOT NULL,
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','storing','checking','ready','needs_review')),
 etag text, error_code text, verified_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,job_id,operation_key)
);
CREATE INDEX IF NOT EXISTS guild_media_owner ON guild_media_objects(tenant_id,commission_id,created_at);
CREATE TABLE IF NOT EXISTS guild_production_parts (
 tenant_id uuid NOT NULL REFERENCES guild_tenants(id), job_id uuid NOT NULL REFERENCES guild_jobs(id),
 part_key text NOT NULL, input_hash text NOT NULL, output_hash text NOT NULL, output jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,job_id,part_key)
);
INSERT INTO guild_schema_migrations(version) VALUES(9) ON CONFLICT DO NOTHING;
