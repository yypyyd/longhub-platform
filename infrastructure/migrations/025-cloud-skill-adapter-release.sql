-- 025：原生 OpenClaw Cloud Skill 薄适配器不可变发布制品。
-- manifest 与恰好三个纯内容文件一起保存；文件只以 canonical Base64
-- 入库，下载前不从任意 URL/路径读取。
CREATE TABLE IF NOT EXISTS cloud_skill_adapter_release (
  skill_id TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  manifest_data JSONB NOT NULL,
  files_data JSONB NOT NULL,
  digest TEXT NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  signature_key_id TEXT NOT NULL,
  min_manager_version TEXT NOT NULL,
  openclaw_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (skill_id, version),
  CHECK ((status = 'active' AND revoked_at IS NULL) OR
         (status = 'revoked' AND revoked_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_cloud_skill_adapter_release_catalog
  ON cloud_skill_adapter_release(status, skill_id, created_at DESC);
