-- Cloud Skill execution admission and usage accounting.
--
-- A reservation row is both the idempotency record for a task and the durable
-- usage ledger entry.  `released_at` only ends the concurrency lease; rows are
-- intentionally retained so releasing a task can never refund included_calls
-- or the per-minute request count. Cycle usage is keyed by subscription+Skill;
-- rate and concurrency are keyed by subscription+tenant+user+device, so all
-- Agents on one device share the bucket. PgStore locks the owning subscription
-- row before counting/inserting, which makes the limits safe across API replicas.

CREATE TABLE IF NOT EXISTS cloud_skill_execution_reservation (
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
    REFERENCES cloud_skill_subscription(subscription_id, plan_id, tenant_id, user_id)
    ON DELETE CASCADE,
  FOREIGN KEY (plan_id, skill_id)
    REFERENCES cloud_skill_plan_skill(plan_id, skill_id)
);

CREATE INDEX IF NOT EXISTS idx_cloud_skill_execution_subscription_time
  ON cloud_skill_execution_reservation(subscription_id, reserved_at);
CREATE INDEX IF NOT EXISTS idx_cloud_skill_execution_skill_cycle
  ON cloud_skill_execution_reservation(subscription_id, skill_id, reserved_at);
CREATE INDEX IF NOT EXISTS idx_cloud_skill_execution_subscription_active
  ON cloud_skill_execution_reservation(subscription_id, released_at, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_cloud_skill_execution_owner_time
  ON cloud_skill_execution_reservation(subscription_id, tenant_id, user_id, device_id, reserved_at);
CREATE INDEX IF NOT EXISTS idx_cloud_skill_execution_owner_active
  ON cloud_skill_execution_reservation(subscription_id, tenant_id, user_id, device_id, released_at, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_cloud_skill_execution_owner
  ON cloud_skill_execution_reservation(tenant_id, user_id, device_id, agent_id, created_at DESC);
