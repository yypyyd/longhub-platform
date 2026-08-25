/**
 * 控制面存储端口：任务、设备（Identity）、授权（Entitlement）、套装发布（Release/Artifact）。
 * MemoryStore 用于测试与原型，PgStore 为 PostgreSQL 持久化实现。
 */

import type { PackFile, SkillPackage } from "@longhub/pack-schema";
import type { CloudSkillAdapterManifest } from "@longhub/cloud-skill-adapter";
import type { FeaturePolicyEntry } from "@longhub/feature-policy";
import {
  LEGACY_UNBOUND_TASK_REQUEST_FINGERPRINT,
  isCloudTaskRequestFingerprint,
  isLegacyUnboundTaskRequestFingerprint,
} from "./task-fingerprint.js";

export type CloudTaskStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";

export interface CloudTask {
  task_id: string;
  /** 任务创建时由已认证设备解析出的不可变所有权。 */
  tenant_id: string;
  device_id: string;
  agent_id: string;
  kind: string;
  status: CloudTaskStatus;
  input: unknown;
  output?: unknown;
  error?: { code: string; message: string; retryable: boolean };
  created_at: string;
  updated_at: string;
}

export interface CloudTaskEvent {
  event_id: string;
  task_id: string;
  type: string;
  ts: string;
  [key: string]: unknown;
}

export type EventListener = (event: CloudTaskEvent) => void;

export interface CloudTaskOwner {
  tenant_id: string;
  device_id: string;
  agent_id: string;
}

/**
 * Stable error used by every task store when an owner-scoped idempotency key
 * is presented with a different request binding.  Keeping this error in the
 * storage port makes the comparison atomic at the store boundary and avoids
 * leaking an internal fingerprint through the HTTP response.
 */
export class CloudTaskIdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_CONFLICT" as const;

  constructor() {
    super("IDEMPOTENCY_CONFLICT");
    this.name = "CloudTaskIdempotencyConflictError";
  }
}

/** Internal request shape for callers that need to document the binding. */
export interface CloudTaskCreateRequest {
  idempotency_key: string;
  kind: string;
  input: unknown;
  owner?: CloudTaskOwner;
  request_fingerprint?: string;
}

/**
 * Internal idempotency lookup result. `request_fingerprint` is storage-only
 * metadata and must never be merged into the public `CloudTask` response.
 */
export interface CloudTaskIdempotencyBinding {
  task: CloudTask;
  request_fingerprint: string;
}

/**
 * Normalize the optional fifth argument used by legacy in-process callers.
 * Historical rows are marked `legacy-unbound`; they are intentionally never
 * considered a successful replay by the stores (fail closed).  New HTTP
 * callers always provide a versioned fingerprint.
 */
export function normalizeCloudTaskRequestFingerprint(value?: string): string {
  if (value === undefined) return LEGACY_UNBOUND_TASK_REQUEST_FINGERPRINT;
  if (isLegacyUnboundTaskRequestFingerprint(value) || isCloudTaskRequestFingerprint(value)) return value;
  throw new CloudTaskIdempotencyConflictError();
}

export const CLOUD_TASK_ADMISSION_PLACEHOLDER_SCHEMA = "longhub/cloud-task-admission-placeholder/v1" as const;

/**
 * A newly-created billable task stores only this non-sensitive binding until
 * usage admission succeeds. The request fingerprint itself binds the complete
 * normalized request, including `input_digest`.
 */
export interface CloudTaskAdmissionPlaceholder {
  schema_version: typeof CLOUD_TASK_ADMISSION_PLACEHOLDER_SCHEMA;
  request_fingerprint: string;
  input_digest: string;
}

export function createCloudTaskAdmissionPlaceholder(
  requestFingerprint: string,
  inputDigest: string,
): CloudTaskAdmissionPlaceholder {
  if (!isCloudTaskRequestFingerprint(requestFingerprint) || !/^[a-f0-9]{64}$/u.test(inputDigest)) {
    throw new CloudTaskIdempotencyConflictError();
  }
  return {
    schema_version: CLOUD_TASK_ADMISSION_PLACEHOLDER_SCHEMA,
    request_fingerprint: requestFingerprint,
    input_digest: inputDigest,
  };
}

export function isCloudTaskAdmissionPlaceholder(
  value: unknown,
  expected?: CloudTaskAdmissionPlaceholder,
): value is CloudTaskAdmissionPlaceholder {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 3 ||
    record.schema_version !== CLOUD_TASK_ADMISSION_PLACEHOLDER_SCHEMA ||
    typeof record.request_fingerprint !== "string" || !isCloudTaskRequestFingerprint(record.request_fingerprint) ||
    typeof record.input_digest !== "string" || !/^[a-f0-9]{64}$/u.test(record.input_digest)) {
    return false;
  }
  return expected === undefined || (
    record.request_fingerprint === expected.request_fingerprint &&
    record.input_digest === expected.input_digest
  );
}

export interface DeviceRecord {
  device_id: string;
  tenant_id: string;
  status: "active" | "revoked";
  platform: string;
  app_version: string;
  device_fingerprint: string;
  display_name?: string;
  /** 设备凭据仅在注册/轮换响应中下发；普通读取不会带此字段。 */
  device_token?: string;
  /** 绑定的用户账号；未绑定为 undefined */
  user_id?: string;
  /** 首次核销成功后绑定的授权码；设备注册本身不代表获得产品使用权 */
  activation_code_id?: string;
  activated_at?: string;
  last_seen_at?: string;
  last_model_success_at?: string;
  last_error_code?: string;
  credential_rotated_at?: string;
  min_required_version?: string;
  rollout_group?: string;
  created_at: string;
}

/**
 * One-time proof generated by a registered Manager and redeemed by an
 * authenticated Portal account.  The clear code is never part of this
 * record; callers pass only a SHA-256 digest to the store.
 */
export interface DevicePairingChallengeRecord {
  challenge_id: string;
  device_id: string;
  tenant_id: string;
  code_hash: string;
  expires_at: string;
  consumed_at?: string;
  created_at: string;
}

export type DevicePairingConsumeResult =
  | { ok: true; device: DeviceRecord }
  | {
      ok: false;
      reason: "CODE_INVALID" | "CODE_EXPIRED" | "DEVICE_NOT_FOUND" | "DEVICE_ALREADY_BOUND" | "DEVICE_REVOKED";
    };

export interface ActivationCodeRecord {
  activation_code_id: string;
  tenant_id: string;
  /** 只保存规范化授权码的 SHA-256；明文仅在创建响应中返回一次 */
  code_hash: string;
  code_hint: string;
  label?: string;
  status: "active" | "revoked";
  max_uses: number;
  use_count: number;
  pack_ids: string[];
  expires_at: string;
  created_at: string;
}

export type ActivationRedemptionResult =
  | { ok: true; code: ActivationCodeRecord; device: DeviceRecord; alreadyActivated: boolean }
  | { ok: false; reason: "DEVICE_NOT_FOUND" | "CODE_UNAVAILABLE" };

// ===== 账号 / 管理员 / 计费（P0 商业化） =====

export interface UserRecord {
  user_id: string;
  email: string;
  password_hash: string;
  status: "active" | "disabled";
  /** 钱包余额，单位分 */
  balance_fen: number;
  created_at: string;
}

export interface SessionRecord {
  token: string;
  subject_type: "user" | "admin";
  subject_id: string;
  expires_at: string;
  created_at: string;
}

export type AdminRole = "super" | "ops" | "support";

export interface AdminRecord {
  admin_id: string;
  username: string;
  password_hash: string;
  role: AdminRole;
  status: "active" | "disabled";
  created_at: string;
}

export interface AuditLogRecord {
  audit_id: string;
  actor: string;
  action: string;
  detail?: unknown;
  created_at: string;
}

export interface ProductRecord {
  product_id: string;
  pack_id: string;
  name: string;
  description: string;
  price_monthly_fen: number;
  price_yearly_fen: number;
  status: "listed" | "unlisted";
  created_at: string;
}

export type OrderStatus = "pending" | "paid" | "cancelled" | "refunded";

export interface OrderRecord {
  order_id: string;
  user_id: string;
  /** `plan` is the legacy Agent Pack product. `cloud_skill_plan` is an
   * independent subscription and must never be interpreted through pack_id. */
  type: "plan" | "cloud_skill_plan" | "recharge";
  product_id?: string;
  pack_id?: string;
  plan_id?: string;
  /** Cloud Skill subscriptions are tenant-scoped; legacy Pack orders leave this unset. */
  tenant_id?: string;
  period?: "monthly" | "yearly";
  amount_fen: number;
  status: OrderStatus;
  pay_method?: "balance" | "mock" | "provider";
  created_at: string;
  paid_at?: string;
  /** Set only after a successful atomic refund settlement. */
  refunded_at?: string;
}

export interface WalletTransactionRecord {
  txn_id: string;
  user_id: string;
  type: "recharge" | "purchase" | "refund" | "adjust";
  /** 变动金额（分），正为入账、负为出账 */
  amount_fen: number;
  balance_after_fen: number;
  order_id?: string;
  /** Settlement ledger id; absent on legacy/manual rows. */
  settlement_id?: string;
  remark?: string;
  created_at: string;
}

export interface EntitlementRecord {
  entitlement_id: string;
  tenant_id: string;
  device_id: string;
  pack_id: string;
  scope: "tenant" | "user" | "device";
  status: "active" | "suspended" | "revoked";
  expires_at: string;
  source_activation_code_id?: string;
  /** Pack entitlement issued by a paid order; legacy/activation rows leave this unset. */
  source_order_id?: string;
  created_at: string;
}

export type BillingSettlementOperation = "payment" | "refund";

export type BillingSettlementReason =
  | "ORDER_NOT_FOUND"
  | "ORDER_NOT_PENDING"
  | "ORDER_NOT_PAID"
  | "INVALID_PAYMENT_METHOD"
  | "RECHARGE_BALANCE_FORBIDDEN"
  | "RECHARGE_REFUND_FORBIDDEN"
  | "INSUFFICIENT_BALANCE"
  | "IDEMPOTENCY_KEY_INVALID"
  | "IDEMPOTENCY_CONFLICT"
  | "REFUND_REQUIRES_RECONCILIATION"
  | "SETTLEMENT_UNAVAILABLE"
  | "FULFILLMENT_INVALID";

/** Stable storage error consumed by account/admin HTTP routes. */
export class BillingSettlementError extends Error {
  readonly code: BillingSettlementReason;
  readonly status: number;

  constructor(code: BillingSettlementReason, message: string = code, status?: number) {
    super(message);
    this.name = "BillingSettlementError";
    this.code = code;
    this.status = status ?? (code === "INSUFFICIENT_BALANCE" ? 402 :
      code === "ORDER_NOT_FOUND" ? 404 : code === "SETTLEMENT_UNAVAILABLE" ? 503 :
      code === "IDEMPOTENCY_KEY_INVALID" ? 400 : code === "IDEMPOTENCY_CONFLICT" ? 409 : 409);
  }
}

export interface BillingSettlementRecord {
  settlement_id: string;
  order_id: string;
  operation: BillingSettlementOperation;
  idempotency_key: string;
  request_hash: string;
  method?: "balance" | "mock" | "provider";
  /** Opaque provider transaction/refund id; never a credential or callback body. */
  provider_reference?: string;
  amount_fen: number;
  created_at: string;
}

export interface BillingOutboxRecord {
  outbox_id: string;
  event_type: "billing.payment.settled" | "billing.refund.settled";
  aggregate_id: string;
  settlement_id: string;
  payload: Record<string, unknown>;
  attempts: number;
  available_at: string;
  locked_until?: string;
  /** Opaque lease fencing token returned only to the outbox worker. */
  lock_token?: string;
  published_at?: string;
  dead_lettered_at?: string;
  last_error?: string;
  created_at: string;
}

export interface SettleOrderPaymentParams {
  order_id: string;
  user_id: string;
  method: "balance" | "mock" | "provider";
  provider_reference?: string;
  idempotency_key: string;
  request_hash: string;
  paid_at?: string;
}

export interface SettleOrderRefundParams {
  order_id: string;
  actor: string;
  idempotency_key: string;
  request_hash: string;
  provider_reference?: string;
  refunded_at?: string;
}

export interface BillingOutboxClaimParams {
  limit?: number;
  lease_ms?: number;
  now?: string;
}

export interface BillingOutboxFailureParams {
  outbox_id: string;
  lock_token: string;
  failed_at?: string;
  retry_at: string;
  error_code: string;
  dead_lettered_at?: string;
}

export interface BillingSettlementResult {
  replayed: boolean;
  settlement: BillingSettlementRecord;
  order: OrderRecord;
  wallet_transaction?: WalletTransactionRecord;
  subscription?: CloudSkillSubscriptionRecord;
  cloud_skill_entitlements?: CloudSkillEntitlementRecord[];
  entitlements?: EntitlementRecord[];
  outbox: BillingOutboxRecord;
}

// ===== Cloud Skill commercial line (kept separate from Pack billing) =====

export type CloudSkillPlanStatus = "listed" | "unlisted";

export type CloudSkillSubscriptionStatus =
  | "active"
  | "cancelled"
  | "expired"
  | "refunded"
  | "suspended";

export type CloudSkillEntitlementStatus = "active" | "suspended" | "revoked";

/** A billable cloud Skill plan. `skill_ids` is the allow-list for this plan. */
export interface CloudSkillPlanRecord {
  plan_id: string;
  name: string;
  description: string;
  skill_ids: string[];
  price_monthly_fen: number;
  price_yearly_fen: number;
  /** Included calls, rate and concurrency limits are enforced by the execution admission store. */
  included_calls: number;
  requests_per_minute: number;
  max_concurrency: number;
  status: CloudSkillPlanStatus;
  created_at: string;
}

export interface CloudSkillSubscriptionRecord {
  subscription_id: string;
  user_id: string;
  tenant_id: string;
  plan_id: string;
  status: CloudSkillSubscriptionStatus;
  period: "monthly" | "yearly";
  starts_at: string;
  expires_at: string;
  cancelled_at?: string;
  refunded_at?: string;
  source_order_id: string;
  created_at: string;
}

/** Access is deliberately keyed by skill_id + plan_id, never by Pack ID. */
export interface CloudSkillEntitlementRecord {
  entitlement_id: string;
  subscription_id: string;
  tenant_id: string;
  user_id: string;
  skill_id: string;
  plan_id: string;
  status: CloudSkillEntitlementStatus;
  expires_at: string;
  created_at: string;
}

export interface CloudSkillAccessGrant extends CloudSkillEntitlementRecord {
  subscription: CloudSkillSubscriptionRecord;
  plan: CloudSkillPlanRecord;
}

// ===== Cloud Agent-Skill binding (server-owned execution authorization) =====

export type CloudAgentSkillBindingStatus = "active" | "revoked";

/**
 * Server-owned registration of one native OpenClaw Agent's permission to call
 * one Cloud Skill from one authenticated device. Runtime context fields in a
 * task request are audit/idempotency metadata only; this record is the
 * authorization source used in addition to the subscription entitlement.
 */
export interface CloudAgentSkillBindingRecord {
  binding_id: string;
  tenant_id: string;
  device_id: string;
  /** Optional for a device-level seed; device-facing enrollment always sets it. */
  user_id?: string;
  agent_id: string;
  skill_id: string;
  status: CloudAgentSkillBindingStatus;
  created_at: string;
  revoked_at?: string;
}

export interface CloudAgentSkillBindingUpsertRequest {
  tenant_id: string;
  device_id: string;
  user_id?: string;
  agent_id: string;
  skill_id: string;
}

export interface CloudAgentSkillBindingResolveQuery {
  tenant_id: string;
  device_id: string;
  user_id?: string;
  agent_id: string;
  skill_id: string;
}

export interface CloudAgentSkillBindingListQuery {
  tenant_id?: string;
  device_id?: string;
  user_id?: string;
  agent_id?: string;
  skill_id?: string;
  status?: CloudAgentSkillBindingStatus;
}

/**
 * Stable reasons returned by the cloud Skill execution admission gate.  The
 * three quota reasons are deliberately independent so the HTTP layer can
 * choose the right retry semantics without exposing storage details.
 */
export type CloudSkillExecutionRejectionReason =
  | "QUOTA_EXCEEDED"
  | "RATE_LIMITED"
  | "CONCURRENCY_LIMIT"
  | "SUBSCRIPTION_INACTIVE"
  | "SKILL_NOT_ENTITLED"
  | "PLAN_MISMATCH"
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_REQUEST"
  | "STORAGE_UNAVAILABLE";

/** A short-lived admission lease for one cloud Skill task. */
export interface CloudSkillExecutionReservation {
  reservation_id: string;
  task_id: string;
  user_id: string;
  tenant_id: string;
  device_id: string;
  agent_id: string;
  skill_id: string;
  plan_id: string;
  subscription_id: string;
  /** Digest of the business input, when supplied by the caller. */
  input_digest?: string;
  /** Start of the subscription period against which this subscription+Skill included_calls is counted. */
  period_start: string;
  reserved_at: string;
  lease_expires_at: string;
  /** Set when the executor releases the lease or it expires. */
  released_at?: string;
}

/** Anonymous operator summary. Failed includes timed-out tasks; identity and payload dimensions are excluded. */
export interface CloudSkillOperationalMetric {
  plan_id: string;
  skill_id: string;
  calls: number;
  active_concurrency: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  active_subscriptions: number;
  included_calls_per_subscription: number;
}

export interface CloudSkillOperationalSummary {
  window_hours: 24;
  generated_at: string;
  skills: CloudSkillOperationalMetric[];
}

export interface CloudSkillExecutionReservationRequest {
  task_id: string;
  user_id: string;
  tenant_id: string;
  device_id: string;
  agent_id: string;
  skill_id: string;
  plan_id: string;
  /** Optional assertion; when present it must match the resolved entitlement. */
  subscription_id?: string;
  input_digest?: string;
  /** ISO timestamp used for deterministic tests and clock-skew control. */
  now?: string;
  /** Lease duration. Values are bounded by the store implementation. */
  lease_ttl_ms?: number;
}

export type CloudSkillExecutionReservationResult =
  | { ok: true; reservation: CloudSkillExecutionReservation }
  | {
      ok: false;
      reason: CloudSkillExecutionRejectionReason;
      retry_after_seconds?: number;
    };

export interface CloudSkillExecutionReleaseRequest {
  reservation_id?: string;
  task_id?: string;
  user_id?: string;
  tenant_id?: string;
  now?: string;
}

export interface CloudSkillExecutionReleaseResult {
  /** True only when this call changed an active lease to released. */
  released: boolean;
  reservation?: CloudSkillExecutionReservation;
}

/** Accept both the snake_case store convention and the camelCase bridge convention. */
export interface CloudSkillEntitlementQuery {
  user_id?: string;
  tenant_id?: string;
  skill_id?: string;
  plan_id?: string;
  userId?: string;
  tenantId?: string;
  skillId?: string;
  planId?: string;
}

export interface CloudSkillAccessQuery {
  user_id?: string;
  tenant_id?: string;
  skill_id?: string;
  allowed_plan_ids?: readonly string[];
  now?: string;
  userId?: string;
  tenantId?: string;
  skillId?: string;
  allowedPlanIds?: readonly string[];
}

/** 已签名的套装发布记录（Release + Artifact 合一，MVP 用 JSON 制品） */
export interface PackReleaseRecord {
  pack_id: string;
  version: string;
  status: "active" | "revoked";
  pack: PackFile;
  digest: string;
  signature_key_id: string;
  min_desktop_version: string;
  created_at: string;
}

/** 官方 Skill 的已签名引用；不包含任意本地代码制品。 */
export interface SkillReleaseRecord {
  skill_id: string;
  version: string;
  publisher_namespace: string;
  status: "active" | "revoked";
  package: SkillPackage;
  digest: string;
  signature_key_id: string;
  min_desktop_version: string;
  openclaw_version: string;
  runtime_kind: SkillPackage["runtime"]["kind"];
  created_at: string;
  revoked_at?: string;
}

/**
 * Immutable, server-owned release for the native OpenClaw thin adapter.
 * Files are canonical Base64 so MemoryStore and PostgreSQL share the exact
 * wire representation returned by the Manager distribution endpoint.
 */
export interface CloudSkillAdapterReleaseRecord {
  skill_id: string;
  version: string;
  status: "active" | "revoked";
  manifest: CloudSkillAdapterManifest;
  files: Record<string, string>;
  digest: string;
  signature_key_id: string;
  min_manager_version: string;
  openclaw_version: string;
  created_at: string;
  revoked_at?: string;
}

/** 服务端模型网关配置。上游 API Key 只以密文形式持久化。 */
export interface ModelGatewayConfigRecord {
  config_id: string;
  scope_type: "global" | "tenant" | "plan" | "device";
  scope_id: string;
  enabled: boolean;
  emergency_disabled: boolean;
  base_url: string;
  model_id: string;
  display_name: string;
  api_type: "openai-completions" | "openai-responses";
  context_window: number;
  max_tokens: number;
  input_capabilities: ("text" | "image")[];
  encrypted_api_key?: string;
  fallback_config_id?: string;
  request_timeout_ms: number;
  max_retries: number;
  circuit_breaker_threshold: number;
  circuit_breaker_cooldown_ms: number;
  min_manager_version: string;
  max_manager_version?: string;
  assistant_name: string;
  assistant_avatar_path: string;
  welcome_message: string;
  quick_tasks: string[];
  features: {
    agent_catalog: boolean;
    file_upload: boolean;
    tool_execution: boolean;
  };
  device_requests_per_minute: number;
  device_daily_tokens: number;
  tenant_monthly_tokens: number;
  max_device_concurrency: number;
  input_cost_microunits_per_million: number;
  output_cost_microunits_per_million: number;
  cache_cost_microunits_per_million: number;
  updated_at: string;
}

/** 管理端持久化的单条 Feature Policy；policy_id 在同一目标上稳定，revision 每次更新递增。 */
export interface FeaturePolicyRecord {
  policy_id: string;
  policy: FeaturePolicyEntry;
  revision: number;
  updated_at: string;
}

export class FeaturePolicyCapacityError extends Error {
  readonly code = "FEATURE_POLICY_CAPACITY";

  constructor() {
    super("Feature Policy 数量已达到契约上限");
    this.name = "FeaturePolicyCapacityError";
  }
}

export interface ModelUsageAggregateRecord {
  period_start: string;
  period: "day" | "month";
  tenant_id: string;
  device_id: string;
  config_id: string;
  request_count: number;
  success_count: number;
  error_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
  estimated_tokens: number;
  cost_microunits: number;
}

export interface KnowledgeDocumentRecord {
  document_id: string;
  tenant_id: string;
  title: string;
  source_label: string;
  content: string;
  created_at: string;
}

export interface PackReviewRecord {
  review_id: string;
  publisher: string;
  pack: PackFile;
  status: "submitted" | "rejected" | "approved" | "published";
  findings: string[];
  created_at: string;
  updated_at: string;
}

/**
 * 匿名客户端遥测的小时级聚合行。这里没有设备、用户、租户或会话字段，调用方也
 * 不能传任意维度；value 只来自共享遥测契约中的固定枚举。
 */
export interface ClientTelemetryAggregateRecord {
  bucket_start: string;
  event_type: "client_started" | "gateway_state" | "client_update_result" | "product_error" | "previous_exit";
  manager_version: string;
  openclaw_version: string;
  platform: "win32";
  architecture: "x64" | "arm64";
  value: string;
  agent_count_bucket: string;
  count: number;
}

export interface ModelRequestAggregateRecord {
  bucket_start: string;
  api_type: "openai-completions" | "openai-responses";
  outcome: "success" | "upstream_rejected" | "network_error" | "timeout";
  latency_bucket: "lt_1s" | "1_to_3s" | "3_to_10s" | "10_to_30s" | "gte_30s";
  count: number;
}

export type HttpRouteMetricRouteId =
  | "cloud_api"
  | "health_probe"
  | "client_feature_policy"
  | "client_runtime_config"
  | "skill_catalog"
  | "skill_download"
  | "skill_release_check";

export type HttpRouteLatencyBucket =
  | "lt_100ms"
  | "100_to_200ms"
  | "200_to_300ms"
  | "300_to_500ms"
  | "500_to_800ms"
  | "800ms_to_1s"
  | "1_to_3s"
  | "3_to_5s"
  | "gte_5s";

/** 固定 route ID 的小时聚合；不得保存原始 URL、身份、查询参数或请求内容。 */
export interface HttpRouteMetricRecord {
  bucket_start: string;
  route_id: HttpRouteMetricRouteId;
  status_class: "2xx" | "3xx" | "4xx" | "5xx";
  latency_bucket: HttpRouteLatencyBucket;
  count: number;
}

/** 每个紧急策略 revision 只记录第一次真实拒绝，不包含触发请求的设备或租户身份。 */
export interface FeaturePolicyEmergencyObservationRecord {
  policy_id: string;
  revision: number;
  feature_id: string;
  policy_updated_at: string;
  first_enforced_at: string;
  latency_ms: number;
}

export const TASK_EVENT_TYPE: Record<CloudTaskStatus, string> = {
  pending: "task.accepted",
  running: "task.started",
  succeeded: "task.succeeded",
  failed: "task.failed",
  cancelled: "task.cancelled",
  timed_out: "task.timed_out",
};

export interface CloudStore {
  // 任务模块
  /** Read an existing owner-scoped binding before mutable new-execution gates. */
  findTaskByIdempotency(
    idempotencyKey: string,
    owner: CloudTaskOwner,
  ): Promise<CloudTaskIdempotencyBinding | undefined>;
  /** Idempotency is scoped to the immutable owner, never globally to a token string. */
  createTask(
    idempotencyKey: string,
    kind: string,
    input: unknown,
    owner?: CloudTaskOwner,
    /** Versioned binding of all request semantics; omitted only by legacy in-process callers. */
    requestFingerprint?: string,
  ): Promise<{ task: CloudTask; existed: boolean }>;
  /**
   * Remove a task that failed admission before execution. The placeholder is
   * mandatory so a late rejection path cannot delete concurrently admitted input.
   */
  discardPendingTask(taskId: string, placeholder: CloudTaskAdmissionPlaceholder): Promise<boolean>;
  /** Replace the non-sensitive admission placeholder exactly once while pending. */
  admitPendingTaskInput(
    taskId: string,
    placeholder: CloudTaskAdmissionPlaceholder,
    input: unknown,
  ): Promise<CloudTask | undefined>;
  getTask(taskId: string): Promise<CloudTask | undefined>;
  /** Atomically claims a pending task for execution; cancelled/running tasks return undefined. */
  claimPendingTask(taskId: string): Promise<CloudTask | undefined>;
  /**
   * Atomically transitions a task only while its persisted status is one of
   * `expectedStatuses`. A lost race returns undefined and emits no event.
   */
  transitionIfStatus(
    taskId: string,
    expectedStatuses: readonly CloudTaskStatus[],
    status: CloudTaskStatus,
    patch?: Partial<CloudTask>,
  ): Promise<CloudTask | undefined>;
  transition(taskId: string, status: CloudTaskStatus, patch?: Partial<CloudTask>): Promise<CloudTask>;
  /** 返回 afterEventId 之后的历史事件（用于 SSE Last-Event-ID 重放） */
  eventsAfter(taskId: string, afterEventId?: string): Promise<CloudTaskEvent[]>;
  /** 实时事件订阅（单实例进程内；多实例部署换 Redis 发布订阅） */
  subscribe(taskId: string, listener: EventListener): () => void;

  // Identity：设备注册与凭据
  registerDevice(params: {
    tenant_id: string;
    platform: string;
    app_version: string;
    device_fingerprint: string;
    display_name?: string;
  }): Promise<{ device: DeviceRecord; existed: boolean }>;
  /** Create a short-lived one-time pairing proof for a device bearer. */
  createDevicePairingChallenge(params: {
    challenge_id: string;
    device_id: string;
    code_hash: string;
    expires_at: string;
    now?: string;
  }): Promise<DevicePairingChallengeRecord | undefined>;
  /** Atomically consume a proof and bind the device to the account. */
  consumeDevicePairingChallenge(params: {
    code_hash: string;
    user_id: string;
    now?: string;
  }): Promise<DevicePairingConsumeResult>;
  getDevice(deviceId: string): Promise<DeviceRecord | undefined>;
  findDeviceByToken(token: string): Promise<DeviceRecord | undefined>;
  listDevices(userId?: string): Promise<DeviceRecord[]>;
  bindDevice(deviceId: string, userId: string): Promise<DeviceRecord | undefined>;
  /** 仅由已认证设备同步自己的实际运行版本；不能由匿名注册或管理页面代报。 */
  updateDeviceVersion(deviceId: string, appVersion: string): Promise<DeviceRecord | undefined>;
  updateDeviceOperations(deviceId: string, patch: Partial<Pick<DeviceRecord, "status" | "last_seen_at" | "last_model_success_at" | "last_error_code" | "credential_rotated_at" | "min_required_version" | "rollout_group" | "device_token">>): Promise<DeviceRecord | undefined>;

  // Activation：授权码只保存摘要，核销必须原子消耗次数并绑定设备
  createActivationCode(params: {
    tenant_id: string;
    code_hash: string;
    code_hint: string;
    label?: string;
    max_uses: number;
    pack_ids: string[];
    expires_at: string;
  }): Promise<ActivationCodeRecord>;
  getActivationCode(activationCodeId: string): Promise<ActivationCodeRecord | undefined>;
  listActivationCodes(): Promise<ActivationCodeRecord[]>;
  revokeActivationCode(activationCodeId: string): Promise<ActivationCodeRecord | undefined>;
  redeemActivationCode(params: {
    device_id: string;
    code_hash: string;
    now: string;
  }): Promise<ActivationRedemptionResult>;

  // Account：用户账号与会话
  createUser(params: { email: string; password_hash: string }): Promise<{ user: UserRecord; existed: boolean }>;
  getUser(userId: string): Promise<UserRecord | undefined>;
  getUserByEmail(email: string): Promise<UserRecord | undefined>;
  listUsers(): Promise<UserRecord[]>;
  setUserStatus(userId: string, status: "active" | "disabled"): Promise<UserRecord | undefined>;
  createSession(params: { subject_type: "user" | "admin"; subject_id: string; token: string; expires_at: string }): Promise<SessionRecord>;
  getSession(token: string): Promise<SessionRecord | undefined>;
  deleteSession(token: string): Promise<void>;

  // Admin：管理员账号与审计
  createAdmin(params: { username: string; password_hash: string; role: AdminRole }): Promise<{ admin: AdminRecord; existed: boolean }>;
  getAdmin(adminId: string): Promise<AdminRecord | undefined>;
  getAdminByUsername(username: string): Promise<AdminRecord | undefined>;
  appendAudit(actor: string, action: string, detail?: unknown): Promise<AuditLogRecord>;
  listAudits(limit?: number): Promise<AuditLogRecord[]>;

  // Catalog：商品（套装定价）
  createProduct(params: {
    pack_id: string;
    name: string;
    description: string;
    price_monthly_fen: number;
    price_yearly_fen: number;
    status?: "listed" | "unlisted";
  }): Promise<ProductRecord>;
  updateProduct(
    productId: string,
    patch: Partial<Pick<ProductRecord, "name" | "description" | "price_monthly_fen" | "price_yearly_fen" | "status">>,
  ): Promise<ProductRecord | undefined>;
  getProduct(productId: string): Promise<ProductRecord | undefined>;
  listProducts(): Promise<ProductRecord[]>;

  // Billing：订单与钱包
  createOrder(params: {
    user_id: string;
    type: "plan" | "cloud_skill_plan" | "recharge";
    product_id?: string;
    pack_id?: string;
    plan_id?: string;
    tenant_id?: string;
    period?: "monthly" | "yearly";
    amount_fen: number;
  }): Promise<OrderRecord>;
  getOrder(orderId: string): Promise<OrderRecord | undefined>;
  updateOrder(orderId: string, patch: Partial<Pick<OrderRecord, "status" | "pay_method" | "paid_at" | "refunded_at">>): Promise<OrderRecord | undefined>;
  listOrders(userId?: string): Promise<OrderRecord[]>;
  /** Atomically records payment, wallet movement and product fulfillment. */
  settleOrderPayment(params: SettleOrderPaymentParams): Promise<BillingSettlementResult>;
  /** Atomically records a refundable order reversal and revokes order-owned access. */
  settleOrderRefund(params: SettleOrderRefundParams): Promise<BillingSettlementResult>;
  /** Internal/operator visibility for the durable billing outbox. */
  listBillingOutbox(): Promise<BillingOutboxRecord[]>;
  /** Lease available events with a fencing token; concurrent workers cannot claim the same row. */
  claimBillingOutbox(params?: BillingOutboxClaimParams): Promise<BillingOutboxRecord[]>;
  /** Publish acknowledgement succeeds only for the current, unexpired lease. */
  completeBillingOutbox(outboxId: string, lockToken: string, publishedAt?: string): Promise<boolean>;
  /** Release a failed lease for retry or move it to the durable dead-letter state. */
  failBillingOutbox(params: BillingOutboxFailureParams): Promise<boolean>;
  /** 记账并原子更新余额；余额不足时抛错 */
  addWalletTransaction(params: {
    user_id: string;
    type: "recharge" | "purchase" | "refund" | "adjust";
    amount_fen: number;
    order_id?: string;
    remark?: string;
  }): Promise<WalletTransactionRecord>;
  listTransactions(userId?: string): Promise<WalletTransactionRecord[]>;
  listAllEntitlements(): Promise<EntitlementRecord[]>;

  // Cloud Skill Billing：独立于 legacy Pack 的计划、订阅和 Skill entitlement
  createCloudSkillPlan(params: {
    plan_id: string;
    name: string;
    description?: string;
    skill_ids: readonly string[];
    price_monthly_fen: number;
    price_yearly_fen: number;
    included_calls?: number;
    requests_per_minute?: number;
    max_concurrency?: number;
    status?: CloudSkillPlanStatus;
  }): Promise<CloudSkillPlanRecord>;
  getCloudSkillPlan(planId: string): Promise<CloudSkillPlanRecord | undefined>;
  listCloudSkillPlans(status?: CloudSkillPlanStatus): Promise<CloudSkillPlanRecord[]>;
  updateCloudSkillPlan(
    planId: string,
    patch: Partial<Pick<CloudSkillPlanRecord,
      "name" | "description" | "skill_ids" | "price_monthly_fen" | "price_yearly_fen" |
      "included_calls" | "requests_per_minute" | "max_concurrency" | "status">>,
  ): Promise<CloudSkillPlanRecord | undefined>;

  createCloudSkillSubscription(params: {
    user_id: string;
    tenant_id: string;
    plan_id: string;
    period: "monthly" | "yearly";
    starts_at: string;
    expires_at: string;
    source_order_id: string;
    status?: CloudSkillSubscriptionStatus;
  }): Promise<{ subscription: CloudSkillSubscriptionRecord; existed: boolean }>;
  getCloudSkillSubscription(subscriptionId: string): Promise<CloudSkillSubscriptionRecord | undefined>;
  getCloudSkillSubscriptionByOrder(orderId: string): Promise<CloudSkillSubscriptionRecord | undefined>;
  listCloudSkillSubscriptions(userId?: string): Promise<CloudSkillSubscriptionRecord[]>;
  updateCloudSkillSubscriptionStatus(
    subscriptionId: string,
    status: CloudSkillSubscriptionStatus,
    changedAt?: string,
  ): Promise<CloudSkillSubscriptionRecord | undefined>;

  grantCloudSkillEntitlement(params: {
    subscription_id: string;
    tenant_id?: string;
    user_id?: string;
    skill_id: string;
    plan_id: string;
    expires_at?: string;
  }): Promise<{ entitlement: CloudSkillEntitlementRecord; existed: boolean }>;
  getCloudSkillEntitlement(entitlementId: string): Promise<CloudSkillEntitlementRecord | undefined>;
  listCloudSkillEntitlements(query?: CloudSkillEntitlementQuery): Promise<CloudSkillEntitlementRecord[]>;
  revokeCloudSkillEntitlement(entitlementId: string): Promise<CloudSkillEntitlementRecord | undefined>;
  /** Returns an active grant only when subscription and entitlement agree on skill + plan + tenant/user. */
  resolveCloudSkillAccess(query: CloudSkillAccessQuery): Promise<CloudSkillAccessGrant | undefined>;
  hasCloudSkillAccess(query: CloudSkillAccessQuery): Promise<boolean>;

  // Cloud Agent-Skill binding：与调用者提交的 runtime context 分离。相同
  // tenant/device/agent/skill 原子 upsert；撤销后新的执行必须 fail closed。
  upsertCloudAgentSkillBinding(
    params: CloudAgentSkillBindingUpsertRequest,
  ): Promise<{ binding: CloudAgentSkillBindingRecord; existed: boolean }>;
  resolveCloudAgentSkillBinding(
    query: CloudAgentSkillBindingResolveQuery,
  ): Promise<CloudAgentSkillBindingRecord | undefined>;
  revokeCloudAgentSkillBinding(bindingId: string): Promise<CloudAgentSkillBindingRecord | undefined>;
  listCloudAgentSkillBindings(
    query?: CloudAgentSkillBindingListQuery,
  ): Promise<CloudAgentSkillBindingRecord[]>;

  // Cloud Skill execution admission / usage.  Reservation creation counts one
  // included call immediately; release only frees concurrency and is never a
  // usage rollback.  Cycle usage is scoped by subscription+Skill; rate and
  // concurrency are scoped by subscription+tenant+user+device and deliberately
  // shared by all Agents on that device. task_id is globally idempotent.
  reserveCloudSkillExecution(
    params: CloudSkillExecutionReservationRequest,
  ): Promise<CloudSkillExecutionReservationResult>;
  releaseCloudSkillExecution(
    params: CloudSkillExecutionReleaseRequest,
  ): Promise<CloudSkillExecutionReleaseResult>;
  /** Fixed plan/Skill dimensions only; never returns tenant, user, device, Agent, task, or payload data. */
  getCloudSkillOperationalSummary(now?: string): Promise<CloudSkillOperationalSummary>;

  // Entitlement：授权与撤销
  grantEntitlement(params: {
    tenant_id: string;
    device_id: string;
    pack_id: string;
    scope?: "tenant" | "user" | "device";
    expires_at?: string;
    source_order_id?: string;
  }): Promise<EntitlementRecord>;
  revokeEntitlement(entitlementId: string): Promise<EntitlementRecord | undefined>;
  listEntitlements(deviceId: string): Promise<EntitlementRecord[]>;

  // Release/Artifact：套装发布、下载与吊销
  publishRelease(params: {
    pack: PackFile;
    digest: string;
    signature_key_id: string;
  }): Promise<{ release: PackReleaseRecord; existed: boolean }>;
  getRelease(packId: string, version: string): Promise<PackReleaseRecord | undefined>;
  listReleases(packId?: string): Promise<PackReleaseRecord[]>;
  revokeRelease(packId: string, version: string): Promise<PackReleaseRecord | undefined>;

  // Skill Release：严格签名引用、详情和撤回；不下发本地代码
  publishSkillRelease(params: {
    package: SkillPackage;
    digest: string;
    signature_key_id: string;
  }): Promise<{ release: SkillReleaseRecord; existed: boolean }>;
  getSkillRelease(skillId: string, version: string): Promise<SkillReleaseRecord | undefined>;
  listSkillReleases(skillId?: string): Promise<SkillReleaseRecord[]>;
  revokeSkillRelease(skillId: string, version: string): Promise<SkillReleaseRecord | undefined>;

  // Cloud Skill Adapter Release：与旧 SkillPackage 发布域分离；返回原生
  // Manager 可验签安装的 manifest + 三个纯内容文件。
  publishCloudSkillAdapterRelease(params: {
    manifest: CloudSkillAdapterManifest;
    files: Record<string, string>;
    digest: string;
    signature_key_id: string;
  }): Promise<{ release: CloudSkillAdapterReleaseRecord; existed: boolean }>;
  getCloudSkillAdapterRelease(skillId: string, version: string): Promise<CloudSkillAdapterReleaseRecord | undefined>;
  listCloudSkillAdapterReleases(skillId?: string): Promise<CloudSkillAdapterReleaseRecord[]>;
  revokeCloudSkillAdapterRelease(skillId: string, version: string): Promise<CloudSkillAdapterReleaseRecord | undefined>;

  // Model Gateway：global/tenant/plan/device 分层策略；设备优先级最高
  getModelGatewayConfig(configId?: string): Promise<ModelGatewayConfigRecord | undefined>;
  listModelGatewayConfigs(): Promise<ModelGatewayConfigRecord[]>;
  setModelGatewayConfig(config: ModelGatewayConfigRecord): Promise<ModelGatewayConfigRecord>;

  // Feature Policy V2：端云共用严格 entry，按 feature/audience/scope/target 原子 upsert
  listFeaturePolicies(): Promise<FeaturePolicyRecord[]>;
  upsertFeaturePolicy(policy: FeaturePolicyEntry): Promise<FeaturePolicyRecord>;

  // Telemetry：仅保存严格枚举的小时级匿名聚合，不保存逐设备原始事件
  incrementClientTelemetry(records: readonly ClientTelemetryAggregateRecord[]): Promise<void>;
  listClientTelemetry(): Promise<ClientTelemetryAggregateRecord[]>;
  incrementModelRequestMetrics(records: readonly ModelRequestAggregateRecord[]): Promise<void>;
  listModelRequestMetrics(): Promise<ModelRequestAggregateRecord[]>;
  incrementHttpRouteMetrics(records: readonly HttpRouteMetricRecord[]): Promise<void>;
  listHttpRouteMetrics(): Promise<HttpRouteMetricRecord[]>;
  recordFeaturePolicyEmergencyObservation(
    record: FeaturePolicyEmergencyObservationRecord,
  ): Promise<boolean>;
  listFeaturePolicyEmergencyObservations(): Promise<FeaturePolicyEmergencyObservationRecord[]>;
  incrementModelUsage(records: readonly ModelUsageAggregateRecord[]): Promise<void>;
  listModelUsage(): Promise<ModelUsageAggregateRecord[]>;
  createKnowledgeDocument(params: Omit<KnowledgeDocumentRecord, "document_id" | "created_at">): Promise<KnowledgeDocumentRecord>;
  listKnowledgeDocuments(tenantId: string): Promise<KnowledgeDocumentRecord[]>;
  deleteKnowledgeDocument(documentId: string): Promise<KnowledgeDocumentRecord | undefined>;
  createPackReview(params: { publisher: string; pack: PackFile; findings: string[] }): Promise<PackReviewRecord>;
  getPackReview(reviewId: string): Promise<PackReviewRecord | undefined>;
  listPackReviews(): Promise<PackReviewRecord[]>;
  updatePackReview(reviewId: string, patch: Pick<PackReviewRecord, "status" | "findings">): Promise<PackReviewRecord | undefined>;

  close(): Promise<void>;
}
