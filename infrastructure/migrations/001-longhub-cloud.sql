-- 云台控制面初始表结构（与 apps/longhub-cloud-api/src/pg-store.ts 的 init() 保持一致）
CREATE TABLE IF NOT EXISTS cloud_task (
  task_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  input JSONB,
  output JSONB,
  error JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cloud_task_event (
  event_id BIGSERIAL PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES cloud_task(task_id),
  type TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB
);

CREATE INDEX IF NOT EXISTS idx_cloud_task_event_task ON cloud_task_event(task_id, event_id);

CREATE TABLE IF NOT EXISTS device (
  device_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  platform TEXT NOT NULL,
  app_version TEXT NOT NULL,
  device_fingerprint TEXT NOT NULL,
  display_name TEXT,
  device_token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_device_active_fingerprint
  ON device(tenant_id, device_fingerprint) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS entitlement (
  entitlement_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES device(device_id),
  pack_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'device',
  status TEXT NOT NULL DEFAULT 'active',
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entitlement_device ON entitlement(device_id);
