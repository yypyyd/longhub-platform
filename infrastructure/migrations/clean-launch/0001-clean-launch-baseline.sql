-- LongHub clean-launch 首发基线（空库）。
--
-- 这里只保留免费原生 Manager + Cloud Skill 云端服务所需的模型。
-- 严禁把 activation_code、Pack、旧 Skill、商品、钱包或知识库表加回本文件。

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE account_user (
  user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE auth_session (
  token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('user', 'admin')),
  subject_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE admin_account (
  admin_id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('super', 'ops', 'support')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  audit_id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE device (
  device_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  platform TEXT NOT NULL,
  app_version TEXT NOT NULL,
  device_fingerprint TEXT NOT NULL,
  display_name TEXT,
  device_token_hash TEXT NOT NULL UNIQUE CHECK (device_token_hash ~ '^[a-f0-9]{64}$'),
  user_id TEXT REFERENCES account_user(user_id) ON DELETE SET NULL,
  last_seen_at TIMESTAMPTZ,
  last_model_success_at TIMESTAMPTZ,
  last_error_code TEXT,
  credential_rotated_at TIMESTAMPTZ,
  min_required_version TEXT,
  rollout_group TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_device_active_fingerprint
  ON device(tenant_id, device_fingerprint) WHERE status = 'active';
CREATE INDEX idx_device_user ON device(user_id, created_at DESC);
CREATE INDEX idx_device_operations ON device(tenant_id, rollout_group, last_seen_at DESC);

-- A Manager creates a short-lived proof with its device bearer; an account
-- redeems it once in the Portal. Only the digest is persisted.
CREATE TABLE device_pairing_challenge (
  challenge_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES device(device_id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE CHECK (code_hash ~ '^v1:[a-f0-9]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);
CREATE UNIQUE INDEX idx_device_pairing_active_device
  ON device_pairing_challenge(device_id) WHERE consumed_at IS NULL;
CREATE INDEX idx_device_pairing_expiry
  ON device_pairing_challenge(expires_at) WHERE consumed_at IS NULL;

CREATE TABLE cloud_task (
  task_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out')),
  input JSONB,
  output JSONB,
  error JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (request_fingerprint ~ '^v1:[a-f0-9]{64}$')
);

CREATE UNIQUE INDEX idx_cloud_task_owner_idempotency
  ON cloud_task(tenant_id, device_id, agent_id, idempotency_key);
CREATE INDEX idx_cloud_task_owner
  ON cloud_task(tenant_id, device_id, agent_id, created_at DESC);

CREATE TABLE cloud_task_event (
  event_id BIGSERIAL PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES cloud_task(task_id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB
);
CREATE INDEX idx_cloud_task_event_task ON cloud_task_event(task_id, event_id);

CREATE TABLE cloud_skill_adapter_release (
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
CREATE INDEX idx_cloud_skill_adapter_release_catalog
  ON cloud_skill_adapter_release(status, skill_id, created_at DESC);

CREATE TABLE cloud_skill_plan (
  plan_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_monthly_fen BIGINT NOT NULL CHECK (price_monthly_fen >= 0),
  price_yearly_fen BIGINT NOT NULL CHECK (price_yearly_fen >= 0),
  included_calls BIGINT NOT NULL DEFAULT 1000 CHECK (included_calls >= 0),
  requests_per_minute INTEGER NOT NULL DEFAULT 60 CHECK (requests_per_minute > 0),
  max_concurrency INTEGER NOT NULL DEFAULT 2 CHECK (max_concurrency > 0),
  status TEXT NOT NULL DEFAULT 'listed' CHECK (status IN ('listed', 'unlisted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cloud_skill_plan_skill (
  plan_id TEXT NOT NULL REFERENCES cloud_skill_plan(plan_id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL,
  PRIMARY KEY (plan_id, skill_id)
);

CREATE TABLE billing_order (
  order_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES account_user(user_id),
  type TEXT NOT NULL DEFAULT 'cloud_skill_plan' CHECK (type = 'cloud_skill_plan'),
  plan_id TEXT NOT NULL REFERENCES cloud_skill_plan(plan_id),
  tenant_id TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('monthly', 'yearly')),
  amount_fen BIGINT NOT NULL CHECK (amount_fen >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'cancelled', 'refunded')),
  -- Store contract name retained for the clean provider-backed adapter; this
  -- is not a balance/mock method and is nullable until a real provider settles.
  pay_method TEXT CHECK (pay_method IS NULL OR pay_method = 'provider'),
  provider_payment_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ
);
CREATE INDEX idx_billing_order_user ON billing_order(user_id, created_at DESC);
CREATE INDEX idx_billing_order_tenant ON billing_order(tenant_id, created_at DESC);

CREATE TABLE cloud_skill_subscription (
  subscription_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES account_user(user_id),
  tenant_id TEXT NOT NULL,
  plan_id TEXT NOT NULL REFERENCES cloud_skill_plan(plan_id),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'cancelled', 'expired', 'refunded', 'suspended')),
  period TEXT NOT NULL CHECK (period IN ('monthly', 'yearly')),
  starts_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  cancelled_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  source_order_id TEXT NOT NULL UNIQUE REFERENCES billing_order(order_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > starts_at),
  UNIQUE (subscription_id, plan_id, tenant_id, user_id)
);
CREATE INDEX idx_cloud_skill_subscription_access
  ON cloud_skill_subscription(tenant_id, user_id, status, expires_at);

CREATE TABLE cloud_skill_entitlement (
  entitlement_id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, skill_id, plan_id),
  FOREIGN KEY (subscription_id, plan_id, tenant_id, user_id)
    REFERENCES cloud_skill_subscription(subscription_id, plan_id, tenant_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (plan_id, skill_id)
    REFERENCES cloud_skill_plan_skill(plan_id, skill_id)
);
CREATE INDEX idx_cloud_skill_entitlement_subject
  ON cloud_skill_entitlement(tenant_id, user_id, status, expires_at);
CREATE INDEX idx_cloud_skill_entitlement_access
  ON cloud_skill_entitlement(skill_id, plan_id, status, expires_at);

CREATE TABLE cloud_agent_skill_binding (
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
  CHECK ((status = 'active' AND revoked_at IS NULL) OR
         (status = 'revoked' AND revoked_at IS NOT NULL))
);
CREATE INDEX idx_cloud_agent_skill_binding_access
  ON cloud_agent_skill_binding(tenant_id, device_id, agent_id, skill_id)
  WHERE status = 'active';
CREATE INDEX idx_cloud_agent_skill_binding_user
  ON cloud_agent_skill_binding(user_id, status, created_at DESC)
  WHERE user_id IS NOT NULL;

CREATE TABLE cloud_skill_execution_reservation (
  reservation_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  input_digest TEXT,
  period_start TIMESTAMPTZ NOT NULL,
  reserved_at TIMESTAMPTZ NOT NULL,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (lease_expires_at > reserved_at),
  FOREIGN KEY (subscription_id, plan_id, tenant_id, user_id)
    REFERENCES cloud_skill_subscription(subscription_id, plan_id, tenant_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (plan_id, skill_id)
    REFERENCES cloud_skill_plan_skill(plan_id, skill_id)
);
CREATE INDEX idx_cloud_skill_execution_subscription_time
  ON cloud_skill_execution_reservation(subscription_id, reserved_at);
CREATE INDEX idx_cloud_skill_execution_skill_cycle
  ON cloud_skill_execution_reservation(subscription_id, skill_id, reserved_at);
CREATE INDEX idx_cloud_skill_execution_subscription_active
  ON cloud_skill_execution_reservation(subscription_id, released_at, lease_expires_at);
CREATE INDEX idx_cloud_skill_execution_owner_time
  ON cloud_skill_execution_reservation(subscription_id, tenant_id, user_id, device_id, reserved_at);
CREATE INDEX idx_cloud_skill_execution_owner_active
  ON cloud_skill_execution_reservation(subscription_id, tenant_id, user_id, device_id, released_at, lease_expires_at);
CREATE INDEX idx_cloud_skill_execution_owner
  ON cloud_skill_execution_reservation(tenant_id, user_id, device_id, agent_id, created_at DESC);

CREATE TABLE model_gateway_config (
  config_id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL DEFAULT 'global'
    CHECK (scope_type IN ('global', 'tenant', 'plan', 'device')),
  scope_id TEXT NOT NULL DEFAULT '-'
    CHECK (scope_id ~ '^[A-Za-z0-9._-]{1,128}$'),
  enabled BOOLEAN NOT NULL DEFAULT false,
  emergency_disabled BOOLEAN NOT NULL DEFAULT false,
  base_url TEXT NOT NULL,
  model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  api_type TEXT NOT NULL CHECK (api_type IN ('openai-completions', 'openai-responses')),
  context_window INTEGER NOT NULL CHECK (context_window > 0),
  max_tokens INTEGER NOT NULL CHECK (max_tokens > 0),
  input_capabilities JSONB NOT NULL DEFAULT '["text"]'::jsonb
    CHECK (input_capabilities IN ('["text"]'::jsonb, '["text", "image"]'::jsonb)),
  encrypted_api_key TEXT,
  fallback_config_id TEXT,
  request_timeout_ms INTEGER NOT NULL DEFAULT 300000,
  max_retries INTEGER NOT NULL DEFAULT 0,
  circuit_breaker_threshold INTEGER NOT NULL DEFAULT 5,
  circuit_breaker_cooldown_ms INTEGER NOT NULL DEFAULT 60000,
  min_manager_version TEXT NOT NULL DEFAULT '0.0.0',
  max_manager_version TEXT,
  device_requests_per_minute INTEGER NOT NULL DEFAULT 60,
  device_daily_tokens BIGINT NOT NULL DEFAULT 1000000,
  tenant_monthly_tokens BIGINT NOT NULL DEFAULT 100000000,
  max_device_concurrency INTEGER NOT NULL DEFAULT 2,
  input_cost_microunits_per_million BIGINT NOT NULL DEFAULT 0,
  output_cost_microunits_per_million BIGINT NOT NULL DEFAULT 0,
  cache_cost_microunits_per_million BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (request_timeout_ms BETWEEN 1000 AND 300000),
  CHECK (max_retries BETWEEN 0 AND 2),
  CHECK (circuit_breaker_threshold BETWEEN 1 AND 100),
  CHECK (circuit_breaker_cooldown_ms BETWEEN 1000 AND 3600000),
  CHECK (device_requests_per_minute > 0),
  CHECK (device_daily_tokens >= 0),
  CHECK (tenant_monthly_tokens >= 0),
  CHECK (max_device_concurrency > 0),
  CHECK (input_cost_microunits_per_million >= 0 AND output_cost_microunits_per_million >= 0 AND cache_cost_microunits_per_million >= 0)
);
CREATE INDEX idx_model_gateway_config_scope
  ON model_gateway_config(scope_type, scope_id, updated_at DESC);

CREATE SEQUENCE feature_policy_revision_seq;
CREATE TABLE feature_policy (
  policy_id TEXT PRIMARY KEY,
  feature_id TEXT NOT NULL,
  audience TEXT NOT NULL CHECK (audience IN ('user', 'tenant_admin', 'platform_admin')),
  scope TEXT NOT NULL CHECK (scope IN ('global', 'tenant', 'plan', 'device', 'agent')),
  scope_id TEXT NOT NULL,
  policy JSONB NOT NULL,
  revision BIGINT NOT NULL DEFAULT nextval('feature_policy_revision_seq'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (feature_id, audience, scope, scope_id),
  CHECK ((scope = 'global' AND scope_id = '-') OR
         (scope <> 'global' AND scope_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'))
);
CREATE INDEX idx_feature_policy_target ON feature_policy(scope, scope_id, feature_id);

CREATE TABLE client_telemetry_hourly (
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
    (event_type = 'client_started' AND value IN ('lt_2s', '2_to_5s', '5_to_15s', '15_to_60s', 'gte_60s') AND agent_count_bucket IN ('0', '1', '2_to_5', 'gte_6')) OR
    (event_type = 'gateway_state' AND value IN ('starting', 'running', 'restarting', 'config_error', 'failed', 'stopped') AND agent_count_bucket = '-') OR
    (event_type = 'client_update_result' AND value IN ('busy', 'none', 'declined', 'downloaded', 'withdrawn', 'install_launched', 'failed', 'healthy', 'rollback_launched', 'rollback_completed') AND agent_count_bucket = '-') OR
    (event_type = 'product_error' AND value IN ('LH-GW-001', 'LH-CL-001', 'LH-AU-001', 'LH-AU-002', 'LH-MD-001', 'LH-UP-001', 'LH-UP-002', 'LH-GW-002', 'LH-GW-003', 'LH-GW-004', 'LH-ST-001', 'LH-ST-002', 'LH-UI-001') AND agent_count_bucket = '-') OR
    (event_type = 'previous_exit' AND value IN ('clean', 'unclean') AND agent_count_bucket = '-')
  ),
  PRIMARY KEY (bucket_start, event_type, manager_version, openclaw_version, platform, architecture, value, agent_count_bucket)
);

CREATE TABLE model_request_hourly (
  bucket_start TIMESTAMPTZ NOT NULL,
  api_type TEXT NOT NULL CHECK (api_type IN ('openai-completions', 'openai-responses')),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'upstream_rejected', 'network_error', 'timeout')),
  latency_bucket TEXT NOT NULL CHECK (latency_bucket IN ('lt_1s', '1_to_3s', '3_to_10s', '10_to_30s', 'gte_30s')),
  count BIGINT NOT NULL CHECK (count > 0),
  PRIMARY KEY (bucket_start, api_type, outcome, latency_bucket)
);

CREATE TABLE http_route_hourly (
  bucket_start TIMESTAMPTZ NOT NULL,
  route_id TEXT NOT NULL CHECK (route_id IN ('cloud_api', 'health_probe', 'client_feature_policy', 'client_runtime_config', 'skill_catalog', 'skill_download', 'skill_release_check')),
  status_class TEXT NOT NULL CHECK (status_class IN ('2xx', '3xx', '4xx', '5xx')),
  latency_bucket TEXT NOT NULL CHECK (latency_bucket IN ('lt_100ms', '100_to_200ms', '200_to_300ms', '300_to_500ms', '500_to_800ms', '800ms_to_1s', '1_to_3s', '3_to_5s', 'gte_5s')),
  count BIGINT NOT NULL CHECK (count > 0),
  PRIMARY KEY (bucket_start, route_id, status_class, latency_bucket)
);

CREATE TABLE feature_policy_emergency_observation (
  policy_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  feature_id TEXT NOT NULL,
  policy_updated_at TIMESTAMPTZ NOT NULL,
  first_enforced_at TIMESTAMPTZ NOT NULL,
  latency_ms BIGINT NOT NULL CHECK (latency_ms >= 0),
  PRIMARY KEY (policy_id, revision)
);

CREATE TABLE model_usage_aggregate (
  period_start DATE NOT NULL,
  period TEXT NOT NULL CHECK (period IN ('day', 'month')),
  tenant_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  config_id TEXT NOT NULL,
  request_count BIGINT NOT NULL CHECK (request_count >= 0),
  success_count BIGINT NOT NULL CHECK (success_count >= 0),
  error_count BIGINT NOT NULL CHECK (error_count >= 0),
  input_tokens BIGINT NOT NULL CHECK (input_tokens >= 0),
  output_tokens BIGINT NOT NULL CHECK (output_tokens >= 0),
  cache_tokens BIGINT NOT NULL CHECK (cache_tokens >= 0),
  estimated_tokens BIGINT NOT NULL CHECK (estimated_tokens >= 0),
  cost_microunits BIGINT NOT NULL CHECK (cost_microunits >= 0),
  PRIMARY KEY (period_start, period, tenant_id, device_id, config_id)
);

-- Manager 更新元数据；实际安装包仍位于受控 artifact 存储，不能把二进制放入 JSONB。
CREATE TABLE manager_release (
  release_id TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('stable', 'beta')),
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  version TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform = 'win32'),
  arch TEXT NOT NULL CHECK (arch = 'x64'),
  filename TEXT NOT NULL,
  url_path TEXT NOT NULL,
  size BIGINT NOT NULL CHECK (size > 0),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  manifest JSONB NOT NULL,
  signature_key_id TEXT NOT NULL,
  signature TEXT NOT NULL,
  rollout_status TEXT NOT NULL DEFAULT 'paused' CHECK (rollout_status IN ('active', 'paused')),
  rollout_basis_points INTEGER NOT NULL DEFAULT 0 CHECK (rollout_basis_points BETWEEN 0 AND 10000),
  uploaded_by TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rollout_updated_by TEXT NOT NULL,
  rollout_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel, version),
  UNIQUE (sequence)
);
CREATE INDEX idx_manager_release_latest ON manager_release(channel, sequence DESC);

-- Provider-backed payment facts. There is intentionally no wallet/余额 ledger.
CREATE TABLE billing_settlement (
  settlement_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES billing_order(order_id),
  operation TEXT NOT NULL CHECK (operation IN ('payment', 'refund')),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  -- Keep the existing Store field name while allowing only a real provider.
  method TEXT NOT NULL CHECK (method = 'provider'),
  provider_reference TEXT,
  amount_fen BIGINT NOT NULL CHECK (amount_fen >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, operation),
  UNIQUE (operation, idempotency_key)
);
CREATE INDEX idx_billing_settlement_order ON billing_settlement(order_id, operation);

CREATE TABLE billing_outbox (
  outbox_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (event_type IN ('billing.payment.settled', 'billing.refund.settled')),
  aggregate_id TEXT NOT NULL,
  settlement_id TEXT NOT NULL REFERENCES billing_settlement(settlement_id),
  payload JSONB NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until TIMESTAMPTZ,
  lock_token TEXT,
  published_at TIMESTAMPTZ,
  dead_lettered_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (settlement_id, event_type),
  CHECK ((locked_until IS NULL AND lock_token IS NULL) OR
         (locked_until IS NOT NULL AND lock_token ~ '^bol-[0-9a-f-]{36}$')),
  CHECK (published_at IS NULL OR dead_lettered_at IS NULL)
);
CREATE INDEX idx_billing_outbox_pending ON billing_outbox(available_at, created_at) WHERE published_at IS NULL;
CREATE INDEX idx_billing_outbox_dead_letter ON billing_outbox(dead_lettered_at, created_at)
  WHERE dead_lettered_at IS NOT NULL;
