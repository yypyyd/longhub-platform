-- LH-040-14：只保存严格枚举、小时级、无身份字段的客户端匿名聚合。
CREATE TABLE IF NOT EXISTS client_telemetry_hourly (
  bucket_start TIMESTAMPTZ NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('client_started', 'gateway_state', 'client_update_result', 'product_error', 'previous_exit')),
  manager_version TEXT NOT NULL,
  openclaw_version TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform = 'win32'),
  architecture TEXT NOT NULL CHECK (architecture IN ('x64', 'arm64')),
  value TEXT NOT NULL,
  agent_count_bucket TEXT NOT NULL,
  count BIGINT NOT NULL CHECK (count > 0),
  CHECK (
    (event_type = 'client_started' AND value IN ('lt_2s', '2_to_5s', '5_to_15s', '15_to_60s', 'gte_60s')
      AND agent_count_bucket IN ('0', '1', '2_to_5', 'gte_6')) OR
    (event_type = 'gateway_state' AND value IN ('starting', 'running', 'restarting', 'config_error', 'failed', 'stopped')
      AND agent_count_bucket = '-') OR
    (event_type = 'client_update_result' AND value IN ('busy', 'none', 'declined', 'downloaded', 'withdrawn', 'install_launched', 'failed', 'healthy', 'rollback_launched', 'rollback_completed')
      AND agent_count_bucket = '-') OR
    (event_type = 'product_error' AND value IN ('LH-GW-001', 'LH-CL-001', 'LH-AU-001', 'LH-AU-002', 'LH-MD-001', 'LH-UP-001', 'LH-UP-002', 'LH-GW-002', 'LH-GW-003', 'LH-GW-004', 'LH-ST-001', 'LH-ST-002', 'LH-UI-001')
      AND agent_count_bucket = '-') OR
    (event_type = 'previous_exit' AND value IN ('clean', 'unclean')
      AND agent_count_bucket = '-')
  ),
  PRIMARY KEY (
    bucket_start, event_type, manager_version, openclaw_version,
    platform, architecture, value, agent_count_bucket
  )
);

COMMENT ON TABLE client_telemetry_hourly IS
  '匿名客户端小时聚合；禁止新增 device/user/tenant/session 标识或原始事件载荷';
