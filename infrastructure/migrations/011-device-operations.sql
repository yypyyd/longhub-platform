ALTER TABLE device
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_model_success_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error_code TEXT,
  ADD COLUMN IF NOT EXISTS credential_rotated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS min_required_version TEXT,
  ADD COLUMN IF NOT EXISTS rollout_group TEXT;

CREATE INDEX IF NOT EXISTS idx_device_operations ON device(tenant_id, rollout_group, last_seen_at DESC);
