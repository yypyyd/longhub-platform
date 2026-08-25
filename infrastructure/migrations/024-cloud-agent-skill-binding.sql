-- 024：Cloud Skill 的服务端 Agent-Skill binding。
-- 请求体中的 agent_id 只用于审计/幂等；只有本表 active 行与设备/租户
-- 所有权共同满足时，Cloud API 才允许新建生产任务。

CREATE TABLE IF NOT EXISTS cloud_agent_skill_binding (
  binding_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES device(device_id) ON DELETE CASCADE,
  user_id TEXT REFERENCES account_user(user_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  UNIQUE (tenant_id, device_id, agent_id, skill_id),
  CHECK (
    (status = 'active' AND revoked_at IS NULL) OR
    (status = 'revoked' AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_cloud_agent_skill_binding_access
  ON cloud_agent_skill_binding(tenant_id, device_id, agent_id, skill_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_cloud_agent_skill_binding_user
  ON cloud_agent_skill_binding(user_id, status, created_at DESC)
  WHERE user_id IS NOT NULL;

COMMENT ON TABLE cloud_agent_skill_binding IS
  'Server-owned binding between an authenticated native OpenClaw Agent and a Cloud Skill';
COMMENT ON COLUMN cloud_agent_skill_binding.user_id IS
  'Optional device-level seed; device-facing enrollment always records the bound account';
