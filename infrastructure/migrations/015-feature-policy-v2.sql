-- LH-V2-002：Feature Policy V2 持久化。
-- policy JSONB 仍必须由 @longhub/feature-policy 严格解析；数据库约束只提供第二道目标边界。

CREATE SEQUENCE IF NOT EXISTS feature_policy_revision_seq;

CREATE TABLE IF NOT EXISTS feature_policy (
  policy_id TEXT PRIMARY KEY,
  feature_id TEXT NOT NULL,
  audience TEXT NOT NULL CHECK (audience IN ('user', 'tenant_admin', 'platform_admin')),
  scope TEXT NOT NULL CHECK (scope IN ('global', 'tenant', 'plan', 'device', 'agent')),
  scope_id TEXT NOT NULL,
  policy JSONB NOT NULL,
  revision BIGINT NOT NULL DEFAULT nextval('feature_policy_revision_seq'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (feature_id, audience, scope, scope_id),
  CHECK (
    (scope = 'global' AND scope_id = '-') OR
    (scope <> 'global' AND scope_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
  )
);

CREATE INDEX IF NOT EXISTS idx_feature_policy_target
  ON feature_policy(scope, scope_id, feature_id);
