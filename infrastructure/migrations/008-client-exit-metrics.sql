-- LH-040-15：为已存在的 006 表扩展固定上一进程退出枚举。
ALTER TABLE client_telemetry_hourly
  DROP CONSTRAINT IF EXISTS client_telemetry_hourly_event_type_check,
  DROP CONSTRAINT IF EXISTS client_telemetry_hourly_check,
  DROP CONSTRAINT IF EXISTS client_telemetry_hourly_value_check;

ALTER TABLE client_telemetry_hourly
  ADD CONSTRAINT client_telemetry_hourly_event_type_check
    CHECK (event_type IN ('client_started', 'gateway_state', 'client_update_result', 'product_error', 'previous_exit')),
  ADD CONSTRAINT client_telemetry_hourly_value_check CHECK (
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
  );
