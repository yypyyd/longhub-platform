-- LH-040-15：模型代理自身产生的匿名小时级运行指标，不保存请求内容或身份。
CREATE TABLE IF NOT EXISTS model_request_hourly (
  bucket_start TIMESTAMPTZ NOT NULL,
  api_type TEXT NOT NULL CHECK (api_type IN ('openai-completions', 'openai-responses')),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'upstream_rejected', 'network_error', 'timeout')),
  latency_bucket TEXT NOT NULL CHECK (latency_bucket IN ('lt_1s', '1_to_3s', '3_to_10s', '10_to_30s', 'gte_30s')),
  count BIGINT NOT NULL CHECK (count > 0),
  PRIMARY KEY (bucket_start, api_type, outcome, latency_bucket)
);

COMMENT ON TABLE model_request_hourly IS
  '模型代理匿名小时聚合；禁止保存请求/响应、设备/用户/租户标识或原始延迟';
