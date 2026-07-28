-- 003：账号 / 管理员 / 计费（P0 商业化）
-- 与 PgStore.init() 的 DDL 保持一致；用于独立执行迁移的场景。

ALTER TABLE device ADD COLUMN IF NOT EXISTS user_id TEXT;

CREATE TABLE IF NOT EXISTS account_user (
  user_id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  balance_fen BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_session (
  token TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_account (
  admin_id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  audit_id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS product (
  product_id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_monthly_fen BIGINT NOT NULL,
  price_yearly_fen BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'listed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing_order (
  order_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES account_user(user_id),
  type TEXT NOT NULL,
  product_id TEXT,
  pack_id TEXT,
  period TEXT,
  amount_fen BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  pay_method TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_billing_order_user ON billing_order(user_id);

CREATE TABLE IF NOT EXISTS wallet_txn (
  txn_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES account_user(user_id),
  type TEXT NOT NULL,
  amount_fen BIGINT NOT NULL,
  balance_after_fen BIGINT NOT NULL,
  order_id TEXT,
  remark TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wallet_txn_user ON wallet_txn(user_id);
