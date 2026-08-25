-- Cloud Skill commercial semantics (independent from legacy Pack billing).
-- No existing entitlement rows are rewritten and no `pack_id` value is interpreted
-- as a Skill subscription. Access is keyed by skill_id + plan_id + user/tenant.

ALTER TABLE billing_order ADD COLUMN IF NOT EXISTS plan_id TEXT;
ALTER TABLE billing_order ADD COLUMN IF NOT EXISTS tenant_id TEXT;

CREATE TABLE IF NOT EXISTS cloud_skill_plan (
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

CREATE TABLE IF NOT EXISTS cloud_skill_plan_skill (
  plan_id TEXT NOT NULL REFERENCES cloud_skill_plan(plan_id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL,
  PRIMARY KEY (plan_id, skill_id)
);

CREATE TABLE IF NOT EXISTS cloud_skill_subscription (
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

CREATE INDEX IF NOT EXISTS idx_cloud_skill_subscription_access
  ON cloud_skill_subscription(tenant_id, user_id, status, expires_at);

CREATE TABLE IF NOT EXISTS cloud_skill_entitlement (
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

CREATE INDEX IF NOT EXISTS idx_cloud_skill_entitlement_subject
  ON cloud_skill_entitlement(tenant_id, user_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_cloud_skill_entitlement_access
  ON cloud_skill_entitlement(skill_id, plan_id, status, expires_at);

-- Keep order resource semantics explicit for new and upgraded deployments.
ALTER TABLE billing_order DROP CONSTRAINT IF EXISTS billing_order_cloud_skill_resource_check;
ALTER TABLE billing_order ADD CONSTRAINT billing_order_cloud_skill_resource_check CHECK (
  (type = 'plan' AND product_id IS NOT NULL AND pack_id IS NOT NULL AND plan_id IS NULL)
  OR (type = 'cloud_skill_plan' AND plan_id IS NOT NULL AND product_id IS NULL AND pack_id IS NULL)
  OR (type = 'recharge' AND product_id IS NULL AND pack_id IS NULL AND plan_id IS NULL)
);
