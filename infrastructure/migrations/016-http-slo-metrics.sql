-- LH-V2-048：固定 route ID 的匿名小时直方图，以及每个紧急策略 revision 的首次真实拒绝。
CREATE TABLE IF NOT EXISTS http_route_hourly (
  bucket_start TIMESTAMPTZ NOT NULL,
  route_id TEXT NOT NULL CHECK (route_id IN (
    'cloud_api', 'health_probe', 'client_feature_policy', 'client_runtime_config',
    'skill_catalog', 'skill_download', 'skill_release_check'
  )),
  status_class TEXT NOT NULL CHECK (status_class IN ('2xx', '3xx', '4xx', '5xx')),
  latency_bucket TEXT NOT NULL CHECK (latency_bucket IN (
    'lt_100ms', '100_to_200ms', '200_to_300ms', '300_to_500ms', '500_to_800ms',
    '800ms_to_1s', '1_to_3s', '3_to_5s', 'gte_5s'
  )),
  count BIGINT NOT NULL CHECK (count > 0),
  PRIMARY KEY (bucket_start, route_id, status_class, latency_bucket)
);

COMMENT ON TABLE http_route_hourly IS
  '固定路由的匿名小时聚合；禁止保存 URL/查询参数、设备、用户、租户、会话或请求正文';

CREATE TABLE IF NOT EXISTS feature_policy_emergency_observation (
  policy_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  feature_id TEXT NOT NULL,
  policy_updated_at TIMESTAMPTZ NOT NULL,
  first_enforced_at TIMESTAMPTZ NOT NULL,
  latency_ms BIGINT NOT NULL CHECK (latency_ms >= 0),
  PRIMARY KEY (policy_id, revision)
);

COMMENT ON TABLE feature_policy_emergency_observation IS
  '紧急策略 revision 第一次真实拒绝；不保存触发请求的设备、用户或租户身份';
