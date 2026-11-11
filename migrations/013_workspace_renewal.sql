CREATE TABLE IF NOT EXISTS guild_session_renewals (
  session_id uuid NOT NULL REFERENCES guild_sessions(id),
  request_id uuid NOT NULL,
  previous_expires_at timestamptz NOT NULL,
  renewed_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, request_id),
  CHECK (renewed_expires_at > previous_expires_at)
);
INSERT INTO guild_schema_migrations(version) VALUES(13) ON CONFLICT DO NOTHING;
