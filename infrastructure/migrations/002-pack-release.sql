-- 套装发布表（与 apps/longhub-cloud-api/src/pg-store.ts 的 init() 保持一致）
CREATE TABLE IF NOT EXISTS pack_release (
  pack_id TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  pack JSONB NOT NULL,
  digest TEXT NOT NULL,
  signature_key_id TEXT NOT NULL,
  min_desktop_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (pack_id, version)
);
