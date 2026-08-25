CREATE TABLE IF NOT EXISTS skill_release (
  skill_id TEXT NOT NULL,
  version TEXT NOT NULL,
  publisher_namespace TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  package_data JSONB NOT NULL,
  digest TEXT NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  signature_key_id TEXT NOT NULL,
  min_desktop_version TEXT NOT NULL,
  openclaw_version TEXT NOT NULL,
  runtime_kind TEXT NOT NULL CHECK (runtime_kind IN ('builtin', 'declarative', 'cloudRef')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (skill_id, version)
);

CREATE INDEX IF NOT EXISTS idx_skill_release_catalog
  ON skill_release(status, skill_id, created_at DESC);
