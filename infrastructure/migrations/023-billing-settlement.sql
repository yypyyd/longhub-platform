-- 023：订单支付/退款结算账本与可靠 outbox。
-- 结算表以 (order, operation) 为业务幂等边界；历史订单/流水不回填，
-- 这样升级不会把无法确认来源的旧授权误判成可退款授权。

ALTER TABLE billing_order
  ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;

ALTER TABLE wallet_txn
  ADD COLUMN IF NOT EXISTS settlement_id TEXT;

ALTER TABLE entitlement
  ADD COLUMN IF NOT EXISTS source_order_id TEXT REFERENCES billing_order(order_id);

CREATE INDEX IF NOT EXISTS idx_entitlement_source_order
  ON entitlement(source_order_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entitlement_source_order_device_pack
  ON entitlement(source_order_id, device_id, pack_id)
  WHERE source_order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS billing_settlement (
  settlement_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES billing_order(order_id),
  operation TEXT NOT NULL CHECK (operation IN ('payment', 'refund')),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  method TEXT CHECK (method IS NULL OR method IN ('balance', 'mock')),
  amount_fen BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, operation),
  UNIQUE (operation, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_billing_settlement_order
  ON billing_settlement(order_id, operation);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'wallet_txn'::regclass
      AND conname = 'wallet_txn_settlement_fk'
  ) THEN
    ALTER TABLE wallet_txn
      ADD CONSTRAINT wallet_txn_settlement_fk
      FOREIGN KEY (settlement_id) REFERENCES billing_settlement(settlement_id);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_txn_settlement
  ON wallet_txn(settlement_id)
  WHERE settlement_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS billing_outbox (
  outbox_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  settlement_id TEXT NOT NULL REFERENCES billing_settlement(settlement_id),
  payload JSONB NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_until TIMESTAMPTZ,
  lock_token TEXT,
  published_at TIMESTAMPTZ,
  dead_lettered_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (settlement_id, event_type)
);

CREATE INDEX IF NOT EXISTS idx_billing_outbox_pending
  ON billing_outbox(available_at, created_at)
  WHERE published_at IS NULL AND dead_lettered_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_billing_outbox_dead_letter
  ON billing_outbox(dead_lettered_at, created_at)
  WHERE dead_lettered_at IS NOT NULL;

COMMENT ON TABLE billing_settlement IS
  'Atomic payment/refund ledger; one row per order and operation';
COMMENT ON TABLE billing_outbox IS
  'Durable settlement events written in the same transaction as the ledger';
