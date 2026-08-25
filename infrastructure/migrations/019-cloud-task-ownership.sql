-- Cloud Task ownership isolation (LH-SKILL-002 follow-up).
--
-- Existing rows cannot be safely attributed to a tenant/device/agent. They are
-- moved to a reserved owner and therefore fail closed at the API boundary;
-- operators may archive/delete them after an out-of-band audit, but must not
-- guess an owner from the input or idempotency key.
ALTER TABLE cloud_task ADD COLUMN IF NOT EXISTS tenant_id TEXT;
ALTER TABLE cloud_task ADD COLUMN IF NOT EXISTS device_id TEXT;
ALTER TABLE cloud_task ADD COLUMN IF NOT EXISTS agent_id TEXT;

UPDATE cloud_task
SET tenant_id = COALESCE(tenant_id, '__legacy__'),
    device_id = COALESCE(device_id, '__legacy__'),
    agent_id = COALESCE(agent_id, '__legacy__')
WHERE tenant_id IS NULL OR device_id IS NULL OR agent_id IS NULL;

ALTER TABLE cloud_task ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE cloud_task ALTER COLUMN device_id SET NOT NULL;
ALTER TABLE cloud_task ALTER COLUMN agent_id SET NOT NULL;

-- The initial schema declared idempotency_key globally unique. Remove only a
-- constraint whose definition is exactly that single-column uniqueness; do not
-- drop unrelated constraints or indexes.
DO $$
DECLARE ownership_constraint TEXT;
BEGIN
  FOR ownership_constraint IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'cloud_task'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (idempotency_key)'
  LOOP
    EXECUTE format('ALTER TABLE cloud_task DROP CONSTRAINT %I', ownership_constraint);
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_task_owner_idempotency
  ON cloud_task(tenant_id, device_id, agent_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_cloud_task_owner
  ON cloud_task(tenant_id, device_id, agent_id, created_at DESC);

COMMENT ON COLUMN cloud_task.tenant_id IS 'Immutable owner tenant; __legacy__ means historical ownership unknown and is fail-closed';
COMMENT ON COLUMN cloud_task.device_id IS 'Immutable creating device; __legacy__ means historical ownership unknown and is fail-closed';
COMMENT ON COLUMN cloud_task.agent_id IS 'Immutable OpenClaw agent binding; __legacy__ means historical ownership unknown and is fail-closed';

