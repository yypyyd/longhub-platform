/**
 * PostgreSQL 持久化实现（建表脚本见 infrastructure/migrations/001-longhub-cloud.sql）。
 * 事件 event_id 由 BIGSERIAL 保证单调递增；实时订阅为进程内广播，
 * 多实例部署时需换 Redis 发布订阅。
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { PackFile } from "@longhub/pack-schema";
import { redactLogValue } from "@longhub/observability";
import {
  TASK_EVENT_TYPE,
  type ActivationCodeRecord,
  type ActivationRedemptionResult,
  type AdminRecord,
  type AdminRole,
  type AuditLogRecord,
  type CloudStore,
  type ClientTelemetryAggregateRecord,
  type CloudTask,
  type CloudTaskEvent,
  type CloudTaskStatus,
  type DeviceRecord,
  type EntitlementRecord,
  type EventListener,
  type ModelGatewayConfigRecord,
  type ModelRequestAggregateRecord,
  type ModelUsageAggregateRecord,
  type KnowledgeDocumentRecord,
  type PackReviewRecord,
  type OrderRecord,
  type PackReleaseRecord,
  type ProductRecord,
  type SessionRecord,
  type UserRecord,
  type WalletTransactionRecord,
} from "./store.js";

const FAR_FUTURE = "2099-12-31T00:00:00.000Z";

interface TaskRow {
  task_id: string;
  kind: string;
  status: CloudTaskStatus;
  input: unknown;
  output: unknown;
  error: { code: string; message: string; retryable: boolean } | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  event_id: string;
  task_id: string;
  type: string;
  ts: string;
  payload: Record<string, unknown> | null;
}

interface DeviceRow {
  device_id: string;
  tenant_id: string;
  status: "active" | "revoked";
  platform: string;
  app_version: string;
  device_fingerprint: string;
  display_name: string | null;
  device_token: string;
  user_id: string | null;
  activation_code_id: string | null;
  activated_at: string | null;
  last_seen_at: string | null;
  last_model_success_at: string | null;
  last_error_code: string | null;
  credential_rotated_at: string | null;
  min_required_version: string | null;
  rollout_group: string | null;
  created_at: string;
}

interface ActivationCodeRow {
  activation_code_id: string;
  tenant_id: string;
  code_hash: string;
  code_hint: string;
  label: string | null;
  status: "active" | "revoked";
  max_uses: number;
  use_count: number;
  pack_ids: string[];
  expires_at: string;
  created_at: string;
}

interface UserRow {
  user_id: string;
  email: string;
  password_hash: string;
  status: "active" | "disabled";
  balance_fen: string | number;
  created_at: string;
}

interface SessionRow {
  token: string;
  subject_type: "user" | "admin";
  subject_id: string;
  expires_at: string;
  created_at: string;
}

interface AdminRow {
  admin_id: string;
  username: string;
  password_hash: string;
  role: AdminRole;
  status: "active" | "disabled";
  created_at: string;
}

interface AuditRow {
  audit_id: string;
  actor: string;
  action: string;
  detail: unknown;
  created_at: string;
}

interface ProductRow {
  product_id: string;
  pack_id: string;
  name: string;
  description: string;
  price_monthly_fen: string | number;
  price_yearly_fen: string | number;
  status: "listed" | "unlisted";
  created_at: string;
}

interface OrderRow {
  order_id: string;
  user_id: string;
  type: "plan" | "recharge";
  product_id: string | null;
  pack_id: string | null;
  period: "monthly" | "yearly" | null;
  amount_fen: string | number;
  status: "pending" | "paid" | "cancelled" | "refunded";
  pay_method: "balance" | "mock" | null;
  created_at: string;
  paid_at: string | null;
}

interface TxnRow {
  txn_id: string;
  user_id: string;
  type: "recharge" | "purchase" | "refund" | "adjust";
  amount_fen: string | number;
  balance_after_fen: string | number;
  order_id: string | null;
  remark: string | null;
  created_at: string;
}

interface EntitlementRow {
  entitlement_id: string;
  tenant_id: string;
  device_id: string;
  pack_id: string;
  scope: "tenant" | "user" | "device";
  status: "active" | "suspended" | "revoked";
  expires_at: string;
  source_activation_code_id: string | null;
  created_at: string;
}

interface ReleaseRow {
  pack_id: string;
  version: string;
  status: "active" | "revoked";
  pack: PackFile;
  digest: string;
  signature_key_id: string;
  min_desktop_version: string;
  created_at: string;
}

function toRelease(row: ReleaseRow): PackReleaseRecord {
  return {
    pack_id: row.pack_id,
    version: row.version,
    status: row.status,
    pack: row.pack,
    digest: row.digest,
    signature_key_id: row.signature_key_id,
    min_desktop_version: row.min_desktop_version,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function toTask(row: TaskRow): CloudTask {
  return {
    task_id: row.task_id,
    kind: row.kind,
    status: row.status,
    input: row.input,
    output: row.output ?? undefined,
    error: row.error ?? undefined,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

function toEvent(row: EventRow): CloudTaskEvent {
  return {
    event_id: String(row.event_id),
    task_id: row.task_id,
    type: row.type,
    ts: new Date(row.ts).toISOString(),
    ...(row.payload ?? {}),
  };
}

function toDevice(row: DeviceRow): DeviceRecord {
  return {
    device_id: row.device_id,
    tenant_id: row.tenant_id,
    status: row.status,
    platform: row.platform,
    app_version: row.app_version,
    device_fingerprint: row.device_fingerprint,
    display_name: row.display_name ?? undefined,
    device_token: row.device_token,
    user_id: row.user_id ?? undefined,
    activation_code_id: row.activation_code_id ?? undefined,
    activated_at: row.activated_at ? new Date(row.activated_at).toISOString() : undefined,
    last_seen_at: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : undefined,
    last_model_success_at: row.last_model_success_at ? new Date(row.last_model_success_at).toISOString() : undefined,
    last_error_code: row.last_error_code ?? undefined,
    credential_rotated_at: row.credential_rotated_at ? new Date(row.credential_rotated_at).toISOString() : undefined,
    min_required_version: row.min_required_version ?? undefined,
    rollout_group: row.rollout_group ?? undefined,
    created_at: new Date(row.created_at).toISOString(),
  };
}

type ModelConfigRow = Omit<ModelGatewayConfigRecord,
  "updated_at" | "fallback_config_id" | "max_desktop_version" |
  "device_daily_tokens" | "tenant_monthly_tokens" |
  "input_cost_microunits_per_million" | "output_cost_microunits_per_million" |
  "cache_cost_microunits_per_million"
> & {
  updated_at: string | Date;
  fallback_config_id: string | null;
  max_desktop_version: string | null;
  device_daily_tokens: string | number;
  tenant_monthly_tokens: string | number;
  input_cost_microunits_per_million: string | number;
  output_cost_microunits_per_million: string | number;
  cache_cost_microunits_per_million: string | number;
};

function toModelConfig(row: ModelConfigRow): ModelGatewayConfigRecord {
  return {
    ...row,
    fallback_config_id: row.fallback_config_id ?? undefined,
    max_desktop_version: row.max_desktop_version ?? undefined,
    device_daily_tokens: Number(row.device_daily_tokens),
    tenant_monthly_tokens: Number(row.tenant_monthly_tokens),
    input_cost_microunits_per_million: Number(row.input_cost_microunits_per_million),
    output_cost_microunits_per_million: Number(row.output_cost_microunits_per_million),
    cache_cost_microunits_per_million: Number(row.cache_cost_microunits_per_million),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

function toActivationCode(row: ActivationCodeRow): ActivationCodeRecord {
  return {
    activation_code_id: row.activation_code_id,
    tenant_id: row.tenant_id,
    code_hash: row.code_hash,
    code_hint: row.code_hint,
    label: row.label ?? undefined,
    status: row.status,
    max_uses: Number(row.max_uses),
    use_count: Number(row.use_count),
    pack_ids: [...row.pack_ids],
    expires_at: new Date(row.expires_at).toISOString(),
    created_at: new Date(row.created_at).toISOString(),
  };
}

function toUser(row: UserRow): UserRecord {
  return {
    user_id: row.user_id,
    email: row.email,
    password_hash: row.password_hash,
    status: row.status,
    balance_fen: Number(row.balance_fen),
    created_at: new Date(row.created_at).toISOString(),
  };
}

function toSession(row: SessionRow): SessionRecord {
  return {
    token: row.token,
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    expires_at: new Date(row.expires_at).toISOString(),
    created_at: new Date(row.created_at).toISOString(),
  };
}

function toAdmin(row: AdminRow): AdminRecord {
  return {
    admin_id: row.admin_id,
    username: row.username,
    password_hash: row.password_hash,
    role: row.role,
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function toAudit(row: AuditRow): AuditLogRecord {
  return {
    audit_id: row.audit_id,
    actor: row.actor,
    action: row.action,
    detail: row.detail ?? undefined,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function toProduct(row: ProductRow): ProductRecord {
  return {
    product_id: row.product_id,
    pack_id: row.pack_id,
    name: row.name,
    description: row.description,
    price_monthly_fen: Number(row.price_monthly_fen),
    price_yearly_fen: Number(row.price_yearly_fen),
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function toOrder(row: OrderRow): OrderRecord {
  return {
    order_id: row.order_id,
    user_id: row.user_id,
    type: row.type,
    product_id: row.product_id ?? undefined,
    pack_id: row.pack_id ?? undefined,
    period: row.period ?? undefined,
    amount_fen: Number(row.amount_fen),
    status: row.status,
    pay_method: row.pay_method ?? undefined,
    created_at: new Date(row.created_at).toISOString(),
    paid_at: row.paid_at ? new Date(row.paid_at).toISOString() : undefined,
  };
}

function toTxn(row: TxnRow): WalletTransactionRecord {
  return {
    txn_id: row.txn_id,
    user_id: row.user_id,
    type: row.type,
    amount_fen: Number(row.amount_fen),
    balance_after_fen: Number(row.balance_after_fen),
    order_id: row.order_id ?? undefined,
    remark: row.remark ?? undefined,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function toEntitlement(row: EntitlementRow): EntitlementRecord {
  return {
    entitlement_id: row.entitlement_id,
    tenant_id: row.tenant_id,
    device_id: row.device_id,
    pack_id: row.pack_id,
    scope: row.scope,
    status: row.status,
    expires_at: new Date(row.expires_at).toISOString(),
    source_activation_code_id: row.source_activation_code_id ?? undefined,
    created_at: new Date(row.created_at).toISOString(),
  };
}

export class PgStore implements CloudStore {
  private readonly pool: pg.Pool;
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  /** 建表（幂等）；正式环境由迁移流水线执行 */
  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS cloud_task (
        task_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        input JSONB,
        output JSONB,
        error JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS cloud_task_event (
        event_id BIGSERIAL PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES cloud_task(task_id),
        type TEXT NOT NULL,
        ts TIMESTAMPTZ NOT NULL DEFAULT now(),
        payload JSONB
      );
      CREATE INDEX IF NOT EXISTS idx_cloud_task_event_task ON cloud_task_event(task_id, event_id);
      CREATE TABLE IF NOT EXISTS device (
        device_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        platform TEXT NOT NULL,
        app_version TEXT NOT NULL,
        device_fingerprint TEXT NOT NULL,
        display_name TEXT,
        device_token TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_device_active_fingerprint
        ON device(tenant_id, device_fingerprint) WHERE status = 'active';
      CREATE TABLE IF NOT EXISTS activation_code (
        activation_code_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        code_hash TEXT NOT NULL UNIQUE,
        code_hint TEXT NOT NULL,
        label TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        max_uses INTEGER NOT NULL,
        use_count INTEGER NOT NULL DEFAULT 0,
        pack_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (max_uses > 0),
        CHECK (use_count >= 0 AND use_count <= max_uses)
      );
      ALTER TABLE device ADD COLUMN IF NOT EXISTS activation_code_id TEXT REFERENCES activation_code(activation_code_id);
      ALTER TABLE device ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;
      ALTER TABLE device ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
      ALTER TABLE device ADD COLUMN IF NOT EXISTS last_model_success_at TIMESTAMPTZ;
      ALTER TABLE device ADD COLUMN IF NOT EXISTS last_error_code TEXT;
      ALTER TABLE device ADD COLUMN IF NOT EXISTS credential_rotated_at TIMESTAMPTZ;
      ALTER TABLE device ADD COLUMN IF NOT EXISTS min_required_version TEXT;
      ALTER TABLE device ADD COLUMN IF NOT EXISTS rollout_group TEXT;
      CREATE INDEX IF NOT EXISTS idx_device_activation_code ON device(activation_code_id);
      ALTER TABLE entitlement ADD COLUMN IF NOT EXISTS source_activation_code_id TEXT REFERENCES activation_code(activation_code_id);
      CREATE INDEX IF NOT EXISTS idx_entitlement_activation_code ON entitlement(source_activation_code_id);
      CREATE TABLE IF NOT EXISTS entitlement (
        entitlement_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        device_id TEXT NOT NULL REFERENCES device(device_id),
        pack_id TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'device',
        status TEXT NOT NULL DEFAULT 'active',
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_entitlement_device ON entitlement(device_id);
      CREATE TABLE IF NOT EXISTS pack_release (
        pack_id TEXT NOT NULL,
        version TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        pack JSONB NOT NULL,
        digest TEXT NOT NULL,
        signature_key_id TEXT NOT NULL,
        min_desktop_version TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (pack_id, version)
      );
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
      CREATE TABLE IF NOT EXISTS model_gateway_config (
        config_id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL DEFAULT 'global',
        scope_id TEXT NOT NULL DEFAULT '-',
        enabled BOOLEAN NOT NULL DEFAULT false,
        emergency_disabled BOOLEAN NOT NULL DEFAULT false,
        base_url TEXT NOT NULL,
        model_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        api_type TEXT NOT NULL,
        context_window INTEGER NOT NULL,
        max_tokens INTEGER NOT NULL,
        encrypted_api_key TEXT,
        fallback_config_id TEXT,
        request_timeout_ms INTEGER NOT NULL DEFAULT 300000,
        max_retries INTEGER NOT NULL DEFAULT 0,
        circuit_breaker_threshold INTEGER NOT NULL DEFAULT 5,
        circuit_breaker_cooldown_ms INTEGER NOT NULL DEFAULT 60000,
        min_desktop_version TEXT NOT NULL DEFAULT '0.0.0',
        max_desktop_version TEXT,
        assistant_name TEXT NOT NULL DEFAULT '龙枢助手',
        assistant_avatar_path TEXT NOT NULL DEFAULT '/assets/longhub-avatar.png',
        welcome_message TEXT NOT NULL DEFAULT '你好，我是龙枢助手。',
        quick_tasks JSONB NOT NULL DEFAULT '[]'::jsonb,
        features JSONB NOT NULL DEFAULT '{"agent_catalog":true,"file_upload":true,"tool_execution":true}'::jsonb,
        device_requests_per_minute INTEGER NOT NULL DEFAULT 60,
        device_daily_tokens BIGINT NOT NULL DEFAULT 1000000,
        tenant_monthly_tokens BIGINT NOT NULL DEFAULT 100000000,
        max_device_concurrency INTEGER NOT NULL DEFAULT 2,
        input_cost_microunits_per_million BIGINT NOT NULL DEFAULT 0,
        output_cost_microunits_per_million BIGINT NOT NULL DEFAULT 0,
        cache_cost_microunits_per_million BIGINT NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      -- CREATE TABLE IF NOT EXISTS 不会升级旧部署的既有表；启动时必须幂等补齐
      -- 运行策略与额度字段，否则 Admin 会显示默认值而设备解析实际得到 undefined。
      ALTER TABLE model_gateway_config
        ADD COLUMN IF NOT EXISTS scope_type TEXT NOT NULL DEFAULT 'global',
        ADD COLUMN IF NOT EXISTS scope_id TEXT NOT NULL DEFAULT '-',
        ADD COLUMN IF NOT EXISTS emergency_disabled BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS fallback_config_id TEXT,
        ADD COLUMN IF NOT EXISTS request_timeout_ms INTEGER NOT NULL DEFAULT 300000,
        ADD COLUMN IF NOT EXISTS max_retries INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS circuit_breaker_threshold INTEGER NOT NULL DEFAULT 5,
        ADD COLUMN IF NOT EXISTS circuit_breaker_cooldown_ms INTEGER NOT NULL DEFAULT 60000,
        ADD COLUMN IF NOT EXISTS min_desktop_version TEXT NOT NULL DEFAULT '0.0.0',
        ADD COLUMN IF NOT EXISTS max_desktop_version TEXT,
        ADD COLUMN IF NOT EXISTS assistant_name TEXT NOT NULL DEFAULT '龙枢助手',
        ADD COLUMN IF NOT EXISTS assistant_avatar_path TEXT NOT NULL DEFAULT '/assets/longhub-avatar.png',
        ADD COLUMN IF NOT EXISTS welcome_message TEXT NOT NULL DEFAULT '你好，我是龙枢助手。',
        ADD COLUMN IF NOT EXISTS quick_tasks JSONB NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS features JSONB NOT NULL DEFAULT '{"agent_catalog":true,"file_upload":true,"tool_execution":true}'::jsonb,
        ADD COLUMN IF NOT EXISTS device_requests_per_minute INTEGER NOT NULL DEFAULT 60,
        ADD COLUMN IF NOT EXISTS device_daily_tokens BIGINT NOT NULL DEFAULT 1000000,
        ADD COLUMN IF NOT EXISTS tenant_monthly_tokens BIGINT NOT NULL DEFAULT 100000000,
        ADD COLUMN IF NOT EXISTS max_device_concurrency INTEGER NOT NULL DEFAULT 2,
        ADD COLUMN IF NOT EXISTS input_cost_microunits_per_million BIGINT NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS output_cost_microunits_per_million BIGINT NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS cache_cost_microunits_per_million BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE model_gateway_config
        DROP CONSTRAINT IF EXISTS model_gateway_config_scope_type_check,
        ADD CONSTRAINT model_gateway_config_scope_type_check CHECK (scope_type IN ('global', 'tenant', 'plan', 'device')),
        DROP CONSTRAINT IF EXISTS model_gateway_config_scope_id_check,
        ADD CONSTRAINT model_gateway_config_scope_id_check CHECK (scope_id ~ '^[A-Za-z0-9._-]{1,128}$'),
        DROP CONSTRAINT IF EXISTS model_gateway_config_retry_check,
        ADD CONSTRAINT model_gateway_config_retry_check CHECK (
          request_timeout_ms BETWEEN 1000 AND 300000 AND max_retries BETWEEN 0 AND 2 AND
          circuit_breaker_threshold BETWEEN 1 AND 100 AND circuit_breaker_cooldown_ms BETWEEN 1000 AND 3600000
        );
      CREATE INDEX IF NOT EXISTS idx_model_gateway_config_scope
        ON model_gateway_config(scope_type, scope_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS client_telemetry_hourly (
        bucket_start TIMESTAMPTZ NOT NULL,
        event_type TEXT NOT NULL,
        desktop_version TEXT NOT NULL,
        openclaw_version TEXT NOT NULL,
        platform TEXT NOT NULL,
        architecture TEXT NOT NULL,
        value TEXT NOT NULL,
        agent_count_bucket TEXT NOT NULL,
        count BIGINT NOT NULL CHECK (count > 0),
        CHECK (
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
        ),
        PRIMARY KEY (
          bucket_start, event_type, desktop_version, openclaw_version,
          platform, architecture, value, agent_count_bucket
        )
      );
      CREATE TABLE IF NOT EXISTS model_request_hourly (
        bucket_start TIMESTAMPTZ NOT NULL,
        api_type TEXT NOT NULL CHECK (api_type IN ('openai-completions', 'openai-responses')),
        outcome TEXT NOT NULL CHECK (outcome IN ('success', 'upstream_rejected', 'network_error', 'timeout')),
        latency_bucket TEXT NOT NULL CHECK (latency_bucket IN ('lt_1s', '1_to_3s', '3_to_10s', '10_to_30s', 'gte_30s')),
        count BIGINT NOT NULL CHECK (count > 0),
        PRIMARY KEY (bucket_start, api_type, outcome, latency_bucket)
      );
      CREATE TABLE IF NOT EXISTS model_usage_aggregate (
        period_start DATE NOT NULL,
        period TEXT NOT NULL CHECK (period IN ('day', 'month')),
        tenant_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        config_id TEXT NOT NULL,
        request_count BIGINT NOT NULL,
        success_count BIGINT NOT NULL,
        error_count BIGINT NOT NULL,
        input_tokens BIGINT NOT NULL,
        output_tokens BIGINT NOT NULL,
        cache_tokens BIGINT NOT NULL,
        estimated_tokens BIGINT NOT NULL,
        cost_microunits BIGINT NOT NULL,
        PRIMARY KEY (period_start, period, tenant_id, device_id, config_id)
      );
      CREATE TABLE IF NOT EXISTS knowledge_document (
        document_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        title TEXT NOT NULL,
        source_label TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT knowledge_document_content_encrypted CHECK (left(content, 14) = 'longhub-kb-v1:')
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_document_tenant ON knowledge_document(tenant_id, created_at DESC);
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'knowledge_document_content_encrypted'
            AND conrelid = 'knowledge_document'::regclass
        ) THEN
          ALTER TABLE knowledge_document
            ADD CONSTRAINT knowledge_document_content_encrypted
            CHECK (left(content, 14) = 'longhub-kb-v1:') NOT VALID;
        END IF;
      END $$;
      ALTER TABLE knowledge_document VALIDATE CONSTRAINT knowledge_document_content_encrypted;
      CREATE TABLE IF NOT EXISTS pack_review (review_id TEXT PRIMARY KEY, publisher TEXT NOT NULL, pack JSONB NOT NULL,
        status TEXT NOT NULL, findings JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL);
    `);
  }

  async createTask(idempotencyKey: string, kind: string, input: unknown): Promise<{ task: CloudTask; existed: boolean }> {
    const taskId = `ct-${randomUUID()}`;
    const inserted = await this.pool.query<TaskRow>(
      `INSERT INTO cloud_task (task_id, idempotency_key, kind, status, input)
       VALUES ($1, $2, $3, 'pending', $4)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [taskId, idempotencyKey, kind, JSON.stringify(input)],
    );
    if (inserted.rowCount === 0) {
      const existing = await this.pool.query<TaskRow>(
        `SELECT * FROM cloud_task WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      return { task: toTask(existing.rows[0]!), existed: true };
    }
    await this.appendEvent(taskId, "task.accepted");
    return { task: toTask(inserted.rows[0]!), existed: false };
  }

  async getTask(taskId: string): Promise<CloudTask | undefined> {
    const res = await this.pool.query<TaskRow>(`SELECT * FROM cloud_task WHERE task_id = $1`, [taskId]);
    return res.rows[0] ? toTask(res.rows[0]) : undefined;
  }

  async transition(taskId: string, status: CloudTaskStatus, patch?: Partial<CloudTask>): Promise<CloudTask> {
    const res = await this.pool.query<TaskRow>(
      `UPDATE cloud_task
       SET status = $2,
           output = COALESCE($3, output),
           error = COALESCE($4, error),
           updated_at = now()
       WHERE task_id = $1
       RETURNING *`,
      [
        taskId,
        status,
        patch?.output !== undefined ? JSON.stringify(patch.output) : null,
        patch?.error !== undefined ? JSON.stringify(patch.error) : null,
      ],
    );
    if (res.rowCount === 0) throw new Error(`Unknown task: ${taskId}`);
    const task = toTask(res.rows[0]!);
    await this.appendEvent(taskId, TASK_EVENT_TYPE[status], task.error ? { error: task.error } : undefined);
    return task;
  }

  async eventsAfter(taskId: string, afterEventId?: string): Promise<CloudTaskEvent[]> {
    const res = await this.pool.query<EventRow>(
      `SELECT * FROM cloud_task_event
       WHERE task_id = $1 AND event_id > $2
       ORDER BY event_id`,
      [taskId, afterEventId === undefined ? 0 : Number(afterEventId)],
    );
    return res.rows.map(toEvent);
  }

  subscribe(taskId: string, listener: EventListener): () => void {
    let set = this.listeners.get(taskId);
    if (!set) {
      set = new Set();
      this.listeners.set(taskId, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  async registerDevice(params: {
    tenant_id: string;
    platform: string;
    app_version: string;
    device_fingerprint: string;
    display_name?: string;
  }): Promise<{ device: DeviceRecord; existed: boolean }> {
    const existing = await this.pool.query<DeviceRow>(
      `SELECT * FROM device WHERE tenant_id = $1 AND device_fingerprint = $2 AND status = 'active'`,
      [params.tenant_id, params.device_fingerprint],
    );
    if (existing.rows[0]) return { device: toDevice(existing.rows[0]), existed: true };
    const res = await this.pool.query<DeviceRow>(
      `INSERT INTO device (device_id, tenant_id, platform, app_version, device_fingerprint, display_name, device_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        `dev-${randomUUID()}`,
        params.tenant_id,
        params.platform,
        params.app_version,
        params.device_fingerprint,
        params.display_name ?? null,
        `dt-${randomUUID()}${randomUUID()}`,
      ],
    );
    return { device: toDevice(res.rows[0]!), existed: false };
  }

  async getDevice(deviceId: string): Promise<DeviceRecord | undefined> {
    const res = await this.pool.query<DeviceRow>(`SELECT * FROM device WHERE device_id = $1`, [deviceId]);
    return res.rows[0] ? toDevice(res.rows[0]) : undefined;
  }

  async findDeviceByToken(token: string): Promise<DeviceRecord | undefined> {
    const res = await this.pool.query<DeviceRow>(`SELECT * FROM device WHERE device_token = $1`, [token]);
    return res.rows[0] ? toDevice(res.rows[0]) : undefined;
  }

  async listDevices(userId?: string): Promise<DeviceRecord[]> {
    const res = userId
      ? await this.pool.query<DeviceRow>(`SELECT * FROM device WHERE user_id = $1 ORDER BY created_at`, [userId])
      : await this.pool.query<DeviceRow>(`SELECT * FROM device ORDER BY created_at`);
    return res.rows.map(toDevice);
  }

  async bindDevice(deviceId: string, userId: string): Promise<DeviceRecord | undefined> {
    const res = await this.pool.query<DeviceRow>(
      `UPDATE device SET user_id = $2 WHERE device_id = $1 RETURNING *`,
      [deviceId, userId],
    );
    return res.rows[0] ? toDevice(res.rows[0]) : undefined;
  }

  async updateDeviceOperations(deviceId: string, patch: Partial<Pick<DeviceRecord, "status" | "last_seen_at" | "last_model_success_at" | "last_error_code" | "credential_rotated_at" | "min_required_version" | "rollout_group" | "device_token">>): Promise<DeviceRecord | undefined> {
    const current = await this.getDevice(deviceId);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    const result = await this.pool.query<DeviceRow>(
      `UPDATE device SET status=$2, last_seen_at=$3, last_model_success_at=$4, last_error_code=$5,
       credential_rotated_at=$6, min_required_version=$7, rollout_group=$8, device_token=$9
       WHERE device_id=$1 RETURNING *`,
      [deviceId, next.status, next.last_seen_at ?? null, next.last_model_success_at ?? null, next.last_error_code ?? null,
        next.credential_rotated_at ?? null, next.min_required_version ?? null, next.rollout_group ?? null, next.device_token],
    );
    return result.rows[0] ? toDevice(result.rows[0]) : undefined;
  }

  async createActivationCode(params: {
    tenant_id: string;
    code_hash: string;
    code_hint: string;
    label?: string;
    max_uses: number;
    pack_ids: string[];
    expires_at: string;
  }): Promise<ActivationCodeRecord> {
    const res = await this.pool.query<ActivationCodeRow>(
      `INSERT INTO activation_code
         (activation_code_id, tenant_id, code_hash, code_hint, label, max_uses, pack_ids, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        `act-${randomUUID()}`,
        params.tenant_id,
        params.code_hash,
        params.code_hint,
        params.label ?? null,
        params.max_uses,
        JSON.stringify(params.pack_ids),
        params.expires_at,
      ],
    );
    return toActivationCode(res.rows[0]!);
  }

  async getActivationCode(activationCodeId: string): Promise<ActivationCodeRecord | undefined> {
    const res = await this.pool.query<ActivationCodeRow>(
      `SELECT * FROM activation_code WHERE activation_code_id = $1`,
      [activationCodeId],
    );
    return res.rows[0] ? toActivationCode(res.rows[0]) : undefined;
  }

  async listActivationCodes(): Promise<ActivationCodeRecord[]> {
    const res = await this.pool.query<ActivationCodeRow>(`SELECT * FROM activation_code ORDER BY created_at DESC`);
    return res.rows.map(toActivationCode);
  }

  async revokeActivationCode(activationCodeId: string): Promise<ActivationCodeRecord | undefined> {
    const res = await this.pool.query<ActivationCodeRow>(
      `UPDATE activation_code SET status = 'revoked' WHERE activation_code_id = $1 RETURNING *`,
      [activationCodeId],
    );
    return res.rows[0] ? toActivationCode(res.rows[0]) : undefined;
  }

  async redeemActivationCode(params: {
    device_id: string;
    code_hash: string;
    now: string;
  }): Promise<ActivationRedemptionResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const deviceResult = await client.query<DeviceRow>(
        `SELECT * FROM device WHERE device_id = $1 FOR UPDATE`,
        [params.device_id],
      );
      const deviceRow = deviceResult.rows[0];
      if (!deviceRow) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "DEVICE_NOT_FOUND" };
      }
      const codeResult = await client.query<ActivationCodeRow>(
        `SELECT * FROM activation_code WHERE code_hash = $1 FOR UPDATE`,
        [params.code_hash],
      );
      const codeRow = codeResult.rows[0];
      if (
        !codeRow || codeRow.tenant_id !== deviceRow.tenant_id || codeRow.status !== "active" ||
        new Date(codeRow.expires_at).toISOString() <= params.now
      ) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "CODE_UNAVAILABLE" };
      }
      if (deviceRow.activation_code_id === codeRow.activation_code_id) {
        await client.query("COMMIT");
        return { ok: true, code: toActivationCode(codeRow), device: toDevice(deviceRow), alreadyActivated: true };
      }
      if (Number(codeRow.use_count) >= Number(codeRow.max_uses)) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "CODE_UNAVAILABLE" };
      }
      const updatedCode = await client.query<ActivationCodeRow>(
        `UPDATE activation_code SET use_count = use_count + 1 WHERE activation_code_id = $1 RETURNING *`,
        [codeRow.activation_code_id],
      );
      const updatedDevice = await client.query<DeviceRow>(
        `UPDATE device SET activation_code_id = $2, activated_at = $3 WHERE device_id = $1 RETURNING *`,
        [deviceRow.device_id, codeRow.activation_code_id, params.now],
      );
      if (deviceRow.activation_code_id) {
        await client.query(
          `UPDATE entitlement SET status = 'revoked'
           WHERE device_id = $1 AND source_activation_code_id = $2 AND status = 'active'`,
          [deviceRow.device_id, deviceRow.activation_code_id],
        );
      }
      for (const packId of codeRow.pack_ids) {
        await client.query(
          `INSERT INTO entitlement
             (entitlement_id, tenant_id, device_id, pack_id, scope, expires_at, source_activation_code_id)
           SELECT $1, $2, $3, $4, 'device', $5, $7
           WHERE NOT EXISTS (
             SELECT 1 FROM entitlement
             WHERE device_id = $3 AND pack_id = $4 AND status = 'active' AND expires_at > $6
           )`,
          [`ent-${randomUUID()}`, deviceRow.tenant_id, deviceRow.device_id, packId, codeRow.expires_at, params.now, codeRow.activation_code_id],
        );
      }
      await client.query("COMMIT");
      return {
        ok: true,
        code: toActivationCode(updatedCode.rows[0]!),
        device: toDevice(updatedDevice.rows[0]!),
        alreadyActivated: false,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async createUser(params: { email: string; password_hash: string }): Promise<{ user: UserRecord; existed: boolean }> {
    const inserted = await this.pool.query<UserRow>(
      `INSERT INTO account_user (user_id, email, password_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING
       RETURNING *`,
      [`usr-${randomUUID()}`, params.email, params.password_hash],
    );
    if (inserted.rowCount === 0) {
      const existing = await this.pool.query<UserRow>(`SELECT * FROM account_user WHERE email = $1`, [params.email]);
      return { user: toUser(existing.rows[0]!), existed: true };
    }
    return { user: toUser(inserted.rows[0]!), existed: false };
  }

  async getUser(userId: string): Promise<UserRecord | undefined> {
    const res = await this.pool.query<UserRow>(`SELECT * FROM account_user WHERE user_id = $1`, [userId]);
    return res.rows[0] ? toUser(res.rows[0]) : undefined;
  }

  async getUserByEmail(email: string): Promise<UserRecord | undefined> {
    const res = await this.pool.query<UserRow>(`SELECT * FROM account_user WHERE email = $1`, [email]);
    return res.rows[0] ? toUser(res.rows[0]) : undefined;
  }

  async listUsers(): Promise<UserRecord[]> {
    const res = await this.pool.query<UserRow>(`SELECT * FROM account_user ORDER BY created_at`);
    return res.rows.map(toUser);
  }

  async setUserStatus(userId: string, status: "active" | "disabled"): Promise<UserRecord | undefined> {
    const res = await this.pool.query<UserRow>(
      `UPDATE account_user SET status = $2 WHERE user_id = $1 RETURNING *`,
      [userId, status],
    );
    return res.rows[0] ? toUser(res.rows[0]) : undefined;
  }

  async createSession(params: {
    subject_type: "user" | "admin";
    subject_id: string;
    token: string;
    expires_at: string;
  }): Promise<SessionRecord> {
    const res = await this.pool.query<SessionRow>(
      `INSERT INTO auth_session (token, subject_type, subject_id, expires_at)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [params.token, params.subject_type, params.subject_id, params.expires_at],
    );
    return toSession(res.rows[0]!);
  }

  async getSession(token: string): Promise<SessionRecord | undefined> {
    const res = await this.pool.query<SessionRow>(
      `SELECT * FROM auth_session WHERE token = $1 AND expires_at > now()`,
      [token],
    );
    return res.rows[0] ? toSession(res.rows[0]) : undefined;
  }

  async deleteSession(token: string): Promise<void> {
    await this.pool.query(`DELETE FROM auth_session WHERE token = $1`, [token]);
  }

  async createAdmin(params: {
    username: string;
    password_hash: string;
    role: AdminRole;
  }): Promise<{ admin: AdminRecord; existed: boolean }> {
    const inserted = await this.pool.query<AdminRow>(
      `INSERT INTO admin_account (admin_id, username, password_hash, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (username) DO NOTHING
       RETURNING *`,
      [`adm-${randomUUID()}`, params.username, params.password_hash, params.role],
    );
    if (inserted.rowCount === 0) {
      const existing = await this.pool.query<AdminRow>(`SELECT * FROM admin_account WHERE username = $1`, [
        params.username,
      ]);
      return { admin: toAdmin(existing.rows[0]!), existed: true };
    }
    return { admin: toAdmin(inserted.rows[0]!), existed: false };
  }

  async getAdmin(adminId: string): Promise<AdminRecord | undefined> {
    const res = await this.pool.query<AdminRow>(`SELECT * FROM admin_account WHERE admin_id = $1`, [adminId]);
    return res.rows[0] ? toAdmin(res.rows[0]) : undefined;
  }

  async getAdminByUsername(username: string): Promise<AdminRecord | undefined> {
    const res = await this.pool.query<AdminRow>(`SELECT * FROM admin_account WHERE username = $1`, [username]);
    return res.rows[0] ? toAdmin(res.rows[0]) : undefined;
  }

  async appendAudit(actor: string, action: string, detail?: unknown): Promise<AuditLogRecord> {
    const res = await this.pool.query<AuditRow>(
      `INSERT INTO audit_log (audit_id, actor, action, detail) VALUES ($1, $2, $3, $4) RETURNING *`,
      [`aud-${randomUUID()}`, actor, action, detail === undefined ? null : JSON.stringify(redactLogValue(detail))],
    );
    return toAudit(res.rows[0]!);
  }

  async listAudits(limit = 200): Promise<AuditLogRecord[]> {
    const res = await this.pool.query<AuditRow>(`SELECT * FROM audit_log ORDER BY created_at DESC LIMIT $1`, [limit]);
    return res.rows.map(toAudit);
  }

  async createProduct(params: {
    pack_id: string;
    name: string;
    description: string;
    price_monthly_fen: number;
    price_yearly_fen: number;
    status?: "listed" | "unlisted";
  }): Promise<ProductRecord> {
    const res = await this.pool.query<ProductRow>(
      `INSERT INTO product (product_id, pack_id, name, description, price_monthly_fen, price_yearly_fen, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        `prd-${randomUUID()}`,
        params.pack_id,
        params.name,
        params.description,
        params.price_monthly_fen,
        params.price_yearly_fen,
        params.status ?? "listed",
      ],
    );
    return toProduct(res.rows[0]!);
  }

  async updateProduct(
    productId: string,
    patch: Partial<Pick<ProductRecord, "name" | "description" | "price_monthly_fen" | "price_yearly_fen" | "status">>,
  ): Promise<ProductRecord | undefined> {
    const res = await this.pool.query<ProductRow>(
      `UPDATE product SET
         name = COALESCE($2, name),
         description = COALESCE($3, description),
         price_monthly_fen = COALESCE($4, price_monthly_fen),
         price_yearly_fen = COALESCE($5, price_yearly_fen),
         status = COALESCE($6, status)
       WHERE product_id = $1 RETURNING *`,
      [
        productId,
        patch.name ?? null,
        patch.description ?? null,
        patch.price_monthly_fen ?? null,
        patch.price_yearly_fen ?? null,
        patch.status ?? null,
      ],
    );
    return res.rows[0] ? toProduct(res.rows[0]) : undefined;
  }

  async getProduct(productId: string): Promise<ProductRecord | undefined> {
    const res = await this.pool.query<ProductRow>(`SELECT * FROM product WHERE product_id = $1`, [productId]);
    return res.rows[0] ? toProduct(res.rows[0]) : undefined;
  }

  async listProducts(): Promise<ProductRecord[]> {
    const res = await this.pool.query<ProductRow>(`SELECT * FROM product ORDER BY created_at`);
    return res.rows.map(toProduct);
  }

  async createOrder(params: {
    user_id: string;
    type: "plan" | "recharge";
    product_id?: string;
    pack_id?: string;
    period?: "monthly" | "yearly";
    amount_fen: number;
  }): Promise<OrderRecord> {
    const res = await this.pool.query<OrderRow>(
      `INSERT INTO billing_order (order_id, user_id, type, product_id, pack_id, period, amount_fen)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        `ord-${randomUUID()}`,
        params.user_id,
        params.type,
        params.product_id ?? null,
        params.pack_id ?? null,
        params.period ?? null,
        params.amount_fen,
      ],
    );
    return toOrder(res.rows[0]!);
  }

  async getOrder(orderId: string): Promise<OrderRecord | undefined> {
    const res = await this.pool.query<OrderRow>(`SELECT * FROM billing_order WHERE order_id = $1`, [orderId]);
    return res.rows[0] ? toOrder(res.rows[0]) : undefined;
  }

  async updateOrder(
    orderId: string,
    patch: Partial<Pick<OrderRecord, "status" | "pay_method" | "paid_at">>,
  ): Promise<OrderRecord | undefined> {
    const res = await this.pool.query<OrderRow>(
      `UPDATE billing_order SET
         status = COALESCE($2, status),
         pay_method = COALESCE($3, pay_method),
         paid_at = COALESCE($4, paid_at)
       WHERE order_id = $1 RETURNING *`,
      [orderId, patch.status ?? null, patch.pay_method ?? null, patch.paid_at ?? null],
    );
    return res.rows[0] ? toOrder(res.rows[0]) : undefined;
  }

  async listOrders(userId?: string): Promise<OrderRecord[]> {
    const res = userId
      ? await this.pool.query<OrderRow>(`SELECT * FROM billing_order WHERE user_id = $1 ORDER BY created_at DESC`, [
          userId,
        ])
      : await this.pool.query<OrderRow>(`SELECT * FROM billing_order ORDER BY created_at DESC`);
    return res.rows.map(toOrder);
  }

  async addWalletTransaction(params: {
    user_id: string;
    type: "recharge" | "purchase" | "refund" | "adjust";
    amount_fen: number;
    order_id?: string;
    remark?: string;
  }): Promise<WalletTransactionRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query<UserRow>(
        `UPDATE account_user SET balance_fen = balance_fen + $2
         WHERE user_id = $1 AND balance_fen + $2 >= 0
         RETURNING *`,
        [params.user_id, params.amount_fen],
      );
      if (updated.rowCount === 0) {
        await client.query("ROLLBACK");
        const exists = await this.pool.query(`SELECT 1 FROM account_user WHERE user_id = $1`, [params.user_id]);
        throw new Error(exists.rowCount === 0 ? `Unknown user: ${params.user_id}` : "INSUFFICIENT_BALANCE");
      }
      const txn = await client.query<TxnRow>(
        `INSERT INTO wallet_txn (txn_id, user_id, type, amount_fen, balance_after_fen, order_id, remark)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [
          `txn-${randomUUID()}`,
          params.user_id,
          params.type,
          params.amount_fen,
          Number(updated.rows[0]!.balance_fen),
          params.order_id ?? null,
          params.remark ?? null,
        ],
      );
      await client.query("COMMIT");
      return toTxn(txn.rows[0]!);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async listTransactions(userId?: string): Promise<WalletTransactionRecord[]> {
    const res = userId
      ? await this.pool.query<TxnRow>(`SELECT * FROM wallet_txn WHERE user_id = $1 ORDER BY created_at DESC`, [userId])
      : await this.pool.query<TxnRow>(`SELECT * FROM wallet_txn ORDER BY created_at DESC`);
    return res.rows.map(toTxn);
  }

  async listAllEntitlements(): Promise<EntitlementRecord[]> {
    const res = await this.pool.query<EntitlementRow>(`SELECT * FROM entitlement ORDER BY created_at`);
    return res.rows.map(toEntitlement);
  }

  async grantEntitlement(params: {
    tenant_id: string;
    device_id: string;
    pack_id: string;
    scope?: "tenant" | "user" | "device";
    expires_at?: string;
  }): Promise<EntitlementRecord> {
    const res = await this.pool.query<EntitlementRow>(
      `INSERT INTO entitlement (entitlement_id, tenant_id, device_id, pack_id, scope, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        `ent-${randomUUID()}`,
        params.tenant_id,
        params.device_id,
        params.pack_id,
        params.scope ?? "device",
        params.expires_at ?? FAR_FUTURE,
      ],
    );
    return toEntitlement(res.rows[0]!);
  }

  async revokeEntitlement(entitlementId: string): Promise<EntitlementRecord | undefined> {
    const res = await this.pool.query<EntitlementRow>(
      `UPDATE entitlement SET status = 'revoked' WHERE entitlement_id = $1 RETURNING *`,
      [entitlementId],
    );
    return res.rows[0] ? toEntitlement(res.rows[0]) : undefined;
  }

  async listEntitlements(deviceId: string): Promise<EntitlementRecord[]> {
    const res = await this.pool.query<EntitlementRow>(
      `SELECT * FROM entitlement WHERE device_id = $1 ORDER BY created_at`,
      [deviceId],
    );
    return res.rows.map(toEntitlement);
  }

  async publishRelease(params: {
    pack: PackFile;
    digest: string;
    signature_key_id: string;
  }): Promise<{ release: PackReleaseRecord; existed: boolean }> {
    const { id, version, minDesktopVersion } = params.pack.manifest.pack;
    const inserted = await this.pool.query<ReleaseRow>(
      `INSERT INTO pack_release (pack_id, version, pack, digest, signature_key_id, min_desktop_version)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (pack_id, version) DO NOTHING
       RETURNING *`,
      [id, version, JSON.stringify(params.pack), params.digest, params.signature_key_id, minDesktopVersion],
    );
    if (inserted.rowCount === 0) {
      const existing = await this.pool.query<ReleaseRow>(
        `SELECT * FROM pack_release WHERE pack_id = $1 AND version = $2`,
        [id, version],
      );
      return { release: toRelease(existing.rows[0]!), existed: true };
    }
    return { release: toRelease(inserted.rows[0]!), existed: false };
  }

  async getRelease(packId: string, version: string): Promise<PackReleaseRecord | undefined> {
    const res = await this.pool.query<ReleaseRow>(
      `SELECT * FROM pack_release WHERE pack_id = $1 AND version = $2`,
      [packId, version],
    );
    return res.rows[0] ? toRelease(res.rows[0]) : undefined;
  }

  async listReleases(packId?: string): Promise<PackReleaseRecord[]> {
    const res = packId
      ? await this.pool.query<ReleaseRow>(`SELECT * FROM pack_release WHERE pack_id = $1 ORDER BY created_at`, [packId])
      : await this.pool.query<ReleaseRow>(`SELECT * FROM pack_release ORDER BY created_at`);
    return res.rows.map(toRelease);
  }

  async revokeRelease(packId: string, version: string): Promise<PackReleaseRecord | undefined> {
    const res = await this.pool.query<ReleaseRow>(
      `UPDATE pack_release SET status = 'revoked' WHERE pack_id = $1 AND version = $2 RETURNING *`,
      [packId, version],
    );
    return res.rows[0] ? toRelease(res.rows[0]) : undefined;
  }

  async getModelGatewayConfig(configId = "default"): Promise<ModelGatewayConfigRecord | undefined> {
    const res = await this.pool.query<ModelConfigRow>(
      `SELECT * FROM model_gateway_config WHERE config_id = $1`,
      [configId],
    );
    return res.rows[0] ? toModelConfig(res.rows[0]) : undefined;
  }

  async listModelGatewayConfigs(): Promise<ModelGatewayConfigRecord[]> {
    const res = await this.pool.query<ModelConfigRow>(`SELECT * FROM model_gateway_config ORDER BY config_id`);
    return res.rows.map(toModelConfig);
  }

  async setModelGatewayConfig(config: ModelGatewayConfigRecord): Promise<ModelGatewayConfigRecord> {
    const res = await this.pool.query<ModelConfigRow>(
      `INSERT INTO model_gateway_config
         (config_id, scope_type, scope_id, enabled, emergency_disabled, base_url, model_id, display_name, api_type,
          context_window, max_tokens, encrypted_api_key, fallback_config_id, request_timeout_ms, max_retries,
          circuit_breaker_threshold, circuit_breaker_cooldown_ms, min_desktop_version, max_desktop_version,
          assistant_name, assistant_avatar_path, welcome_message, quick_tasks, features,
          device_requests_per_minute, device_daily_tokens, tenant_monthly_tokens, max_device_concurrency,
          input_cost_microunits_per_million, output_cost_microunits_per_million, cache_cost_microunits_per_million,
          updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
               $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32)
       ON CONFLICT (config_id) DO UPDATE SET
         scope_type = EXCLUDED.scope_type,
         scope_id = EXCLUDED.scope_id,
         enabled = EXCLUDED.enabled,
         emergency_disabled = EXCLUDED.emergency_disabled,
         base_url = EXCLUDED.base_url,
         model_id = EXCLUDED.model_id,
         display_name = EXCLUDED.display_name,
         api_type = EXCLUDED.api_type,
         context_window = EXCLUDED.context_window,
         max_tokens = EXCLUDED.max_tokens,
         encrypted_api_key = EXCLUDED.encrypted_api_key,
         fallback_config_id = EXCLUDED.fallback_config_id,
         request_timeout_ms = EXCLUDED.request_timeout_ms,
         max_retries = EXCLUDED.max_retries,
         circuit_breaker_threshold = EXCLUDED.circuit_breaker_threshold,
         circuit_breaker_cooldown_ms = EXCLUDED.circuit_breaker_cooldown_ms,
         min_desktop_version = EXCLUDED.min_desktop_version,
         max_desktop_version = EXCLUDED.max_desktop_version,
         assistant_name = EXCLUDED.assistant_name,
         assistant_avatar_path = EXCLUDED.assistant_avatar_path,
         welcome_message = EXCLUDED.welcome_message,
         quick_tasks = EXCLUDED.quick_tasks,
         features = EXCLUDED.features,
         device_requests_per_minute = EXCLUDED.device_requests_per_minute,
         device_daily_tokens = EXCLUDED.device_daily_tokens,
         tenant_monthly_tokens = EXCLUDED.tenant_monthly_tokens,
         max_device_concurrency = EXCLUDED.max_device_concurrency,
         input_cost_microunits_per_million = EXCLUDED.input_cost_microunits_per_million,
         output_cost_microunits_per_million = EXCLUDED.output_cost_microunits_per_million,
         cache_cost_microunits_per_million = EXCLUDED.cache_cost_microunits_per_million,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [
        config.config_id,
        config.scope_type,
        config.scope_id,
        config.enabled,
        config.emergency_disabled,
        config.base_url,
        config.model_id,
        config.display_name,
        config.api_type,
        config.context_window,
        config.max_tokens,
        config.encrypted_api_key ?? null,
        config.fallback_config_id ?? null,
        config.request_timeout_ms,
        config.max_retries,
        config.circuit_breaker_threshold,
        config.circuit_breaker_cooldown_ms,
        config.min_desktop_version,
        config.max_desktop_version ?? null,
        config.assistant_name,
        config.assistant_avatar_path,
        config.welcome_message,
        JSON.stringify(config.quick_tasks),
        JSON.stringify(config.features),
        config.device_requests_per_minute,
        config.device_daily_tokens,
        config.tenant_monthly_tokens,
        config.max_device_concurrency,
        config.input_cost_microunits_per_million,
        config.output_cost_microunits_per_million,
        config.cache_cost_microunits_per_million,
        config.updated_at,
      ],
    );
    return toModelConfig(res.rows[0]!);
  }

  async incrementClientTelemetry(records: readonly ClientTelemetryAggregateRecord[]): Promise<void> {
    if (records.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const record of records) {
        await client.query(
          `INSERT INTO client_telemetry_hourly
             (bucket_start, event_type, desktop_version, openclaw_version, platform,
              architecture, value, agent_count_bucket, count)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (bucket_start, event_type, desktop_version, openclaw_version,
                        platform, architecture, value, agent_count_bucket)
           DO UPDATE SET count = client_telemetry_hourly.count + EXCLUDED.count`,
          [
            record.bucket_start, record.event_type, record.desktop_version, record.openclaw_version,
            record.platform, record.architecture, record.value, record.agent_count_bucket, record.count,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listClientTelemetry(): Promise<ClientTelemetryAggregateRecord[]> {
    const result = await this.pool.query<{
      bucket_start: string;
      event_type: ClientTelemetryAggregateRecord["event_type"];
      desktop_version: string;
      openclaw_version: string;
      platform: ClientTelemetryAggregateRecord["platform"];
      architecture: ClientTelemetryAggregateRecord["architecture"];
      value: string;
      agent_count_bucket: string;
      count: string | number;
    }>(`SELECT * FROM client_telemetry_hourly ORDER BY bucket_start, event_type`);
    return result.rows.map((row) => ({
      ...row,
      bucket_start: new Date(row.bucket_start).toISOString(),
      count: Number(row.count),
    }));
  }

  async incrementModelRequestMetrics(records: readonly ModelRequestAggregateRecord[]): Promise<void> {
    if (records.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const record of records) {
        await client.query(
          `INSERT INTO model_request_hourly (bucket_start, api_type, outcome, latency_bucket, count)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (bucket_start, api_type, outcome, latency_bucket)
           DO UPDATE SET count = model_request_hourly.count + EXCLUDED.count`,
          [record.bucket_start, record.api_type, record.outcome, record.latency_bucket, record.count],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listModelRequestMetrics(): Promise<ModelRequestAggregateRecord[]> {
    const result = await this.pool.query<{
      bucket_start: string;
      api_type: ModelRequestAggregateRecord["api_type"];
      outcome: ModelRequestAggregateRecord["outcome"];
      latency_bucket: ModelRequestAggregateRecord["latency_bucket"];
      count: string | number;
    }>(`SELECT * FROM model_request_hourly ORDER BY bucket_start, api_type`);
    return result.rows.map((row) => ({
      ...row,
      bucket_start: new Date(row.bucket_start).toISOString(),
      count: Number(row.count),
    }));
  }

  async incrementModelUsage(records: readonly ModelUsageAggregateRecord[]): Promise<void> {
    for (const record of records) {
      await this.pool.query(
        `INSERT INTO model_usage_aggregate
           (period_start, period, tenant_id, device_id, config_id, request_count, success_count, error_count,
            input_tokens, output_tokens, cache_tokens, estimated_tokens, cost_microunits)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (period_start, period, tenant_id, device_id, config_id) DO UPDATE SET
           request_count=model_usage_aggregate.request_count+EXCLUDED.request_count,
           success_count=model_usage_aggregate.success_count+EXCLUDED.success_count,
           error_count=model_usage_aggregate.error_count+EXCLUDED.error_count,
           input_tokens=model_usage_aggregate.input_tokens+EXCLUDED.input_tokens,
           output_tokens=model_usage_aggregate.output_tokens+EXCLUDED.output_tokens,
           cache_tokens=model_usage_aggregate.cache_tokens+EXCLUDED.cache_tokens,
           estimated_tokens=model_usage_aggregate.estimated_tokens+EXCLUDED.estimated_tokens,
           cost_microunits=model_usage_aggregate.cost_microunits+EXCLUDED.cost_microunits`,
        [record.period_start, record.period, record.tenant_id, record.device_id, record.config_id, record.request_count,
          record.success_count, record.error_count, record.input_tokens, record.output_tokens, record.cache_tokens,
          record.estimated_tokens, record.cost_microunits],
      );
    }
  }

  async listModelUsage(): Promise<ModelUsageAggregateRecord[]> {
    const result = await this.pool.query<ModelUsageAggregateRecord & Record<string, string | number>>(
      `SELECT * FROM model_usage_aggregate ORDER BY period_start DESC, tenant_id, device_id, config_id`,
    );
    return result.rows.map((row) => ({
      ...row,
      period_start: new Date(row.period_start).toISOString().slice(0, 10),
      request_count: Number(row.request_count), success_count: Number(row.success_count), error_count: Number(row.error_count),
      input_tokens: Number(row.input_tokens), output_tokens: Number(row.output_tokens), cache_tokens: Number(row.cache_tokens),
      estimated_tokens: Number(row.estimated_tokens), cost_microunits: Number(row.cost_microunits),
    }));
  }

  async createKnowledgeDocument(params: Omit<KnowledgeDocumentRecord, "document_id" | "created_at">): Promise<KnowledgeDocumentRecord> {
    const result = await this.pool.query<KnowledgeDocumentRecord>(
      `INSERT INTO knowledge_document(document_id,tenant_id,title,source_label,content) VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [`doc-${randomUUID()}`, params.tenant_id, params.title, params.source_label, params.content],
    );
    return { ...result.rows[0]!, created_at: new Date(result.rows[0]!.created_at).toISOString() };
  }

  async listKnowledgeDocuments(tenantId: string): Promise<KnowledgeDocumentRecord[]> {
    const result = await this.pool.query<KnowledgeDocumentRecord>(`SELECT * FROM knowledge_document WHERE tenant_id=$1 ORDER BY created_at DESC`, [tenantId]);
    return result.rows.map((row) => ({ ...row, created_at: new Date(row.created_at).toISOString() }));
  }

  async deleteKnowledgeDocument(documentId: string): Promise<KnowledgeDocumentRecord | undefined> {
    const result = await this.pool.query<KnowledgeDocumentRecord>(`DELETE FROM knowledge_document WHERE document_id=$1 RETURNING *`, [documentId]);
    return result.rows[0] ? { ...result.rows[0], created_at: new Date(result.rows[0].created_at).toISOString() } : undefined;
  }

  async createPackReview(params: { publisher: string; pack: PackFile; findings: string[] }): Promise<PackReviewRecord> {
    const now = new Date().toISOString(); const id = `review-${randomUUID()}`;
    const result = await this.pool.query<PackReviewRecord>(`INSERT INTO pack_review(review_id,publisher,pack,status,findings,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING *`, [id, params.publisher, JSON.stringify(params.pack), params.findings.length ? "rejected" : "submitted", JSON.stringify(params.findings), now]);
    return result.rows[0]!;
  }
  async getPackReview(reviewId: string): Promise<PackReviewRecord | undefined> { return (await this.pool.query<PackReviewRecord>(`SELECT * FROM pack_review WHERE review_id=$1`, [reviewId])).rows[0]; }
  async listPackReviews(): Promise<PackReviewRecord[]> { return (await this.pool.query<PackReviewRecord>(`SELECT * FROM pack_review ORDER BY created_at DESC`)).rows; }
  async updatePackReview(reviewId: string, patch: Pick<PackReviewRecord, "status" | "findings">): Promise<PackReviewRecord | undefined> { return (await this.pool.query<PackReviewRecord>(`UPDATE pack_review SET status=$2,findings=$3,updated_at=now() WHERE review_id=$1 RETURNING *`, [reviewId, patch.status, JSON.stringify(patch.findings)])).rows[0]; }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async appendEvent(taskId: string, type: string, payload?: Record<string, unknown>): Promise<void> {
    const res = await this.pool.query<EventRow>(
      `INSERT INTO cloud_task_event (task_id, type, payload) VALUES ($1, $2, $3) RETURNING *`,
      [taskId, type, payload ? JSON.stringify(payload) : null],
    );
    const event = toEvent(res.rows[0]!);
    this.listeners.get(taskId)?.forEach((l) => l(event));
  }
}
