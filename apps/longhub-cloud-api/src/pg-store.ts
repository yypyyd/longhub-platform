/**
 * PostgreSQL 持久化实现（建表脚本见 infrastructure/migrations/001-longhub-cloud.sql、
 * 020-cloud-skill-billing.sql 与 021-cloud-skill-usage.sql）。
 * 事件 event_id 由 BIGSERIAL 保证单调递增；实时订阅为进程内广播，
 * 多实例部署时需换 Redis 发布订阅。
 */
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import type { PackFile, SkillPackage } from "@longhub/pack-schema";
import type { CloudSkillAdapterManifest } from "@longhub/cloud-skill-adapter";
import {
  FEATURE_POLICY_MAX_FEATURES,
  parseFeaturePolicyEntry,
  type FeaturePolicyEntry,
} from "@longhub/feature-policy";
import { redactLogValue } from "@longhub/observability";
import { hashSessionToken } from "./auth.js";
import {
  TASK_EVENT_TYPE,
  BillingSettlementError,
  CloudTaskIdempotencyConflictError,
  FeaturePolicyCapacityError,
  isCloudTaskAdmissionPlaceholder,
  type ActivationCodeRecord,
  type ActivationRedemptionResult,
  type AdminRecord,
  type AdminRole,
  type AuditLogRecord,
  type BillingOutboxRecord,
  type BillingOutboxClaimParams,
  type BillingOutboxFailureParams,
  type BillingSettlementRecord,
  type BillingSettlementResult,
  type CloudAgentSkillBindingListQuery,
  type CloudAgentSkillBindingRecord,
  type CloudAgentSkillBindingResolveQuery,
  type CloudAgentSkillBindingUpsertRequest,
  type CloudStore,
  type ClientTelemetryAggregateRecord,
  type CloudTask,
  type CloudTaskAdmissionPlaceholder,
  type CloudTaskEvent,
  type CloudTaskIdempotencyBinding,
  type CloudTaskStatus,
  type CloudTaskOwner,
  type CloudSkillAccessGrant,
  type CloudSkillAdapterReleaseRecord,
  type CloudSkillAccessQuery,
  type CloudSkillEntitlementQuery,
  type CloudSkillEntitlementRecord,
  type CloudSkillExecutionReservation,
  type CloudSkillExecutionReservationRequest,
  type CloudSkillExecutionReservationResult,
  type CloudSkillExecutionReleaseRequest,
  type CloudSkillExecutionReleaseResult,
  type CloudSkillOperationalSummary,
  type CloudSkillPlanRecord,
  type CloudSkillPlanStatus,
  type CloudSkillSubscriptionRecord,
  type CloudSkillSubscriptionStatus,
  type DeviceRecord,
  type DevicePairingChallengeRecord,
  type DevicePairingConsumeResult,
  type EntitlementRecord,
  type EventListener,
  type FeaturePolicyRecord,
  type FeaturePolicyEmergencyObservationRecord,
  type HttpRouteMetricRecord,
  type ModelGatewayConfigRecord,
  type ModelRequestAggregateRecord,
  type ModelUsageAggregateRecord,
  type KnowledgeDocumentRecord,
  type PackReviewRecord,
  type OrderRecord,
  type PackReleaseRecord,
  type ProductRecord,
  type SessionRecord,
  type SettleOrderPaymentParams,
  type SettleOrderRefundParams,
  type SkillReleaseRecord,
  type UserRecord,
  type WalletTransactionRecord,
} from "./store.js";
import {
  normalizeCloudTaskRequestFingerprint,
} from "./store.js";
import { LEGACY_UNBOUND_TASK_REQUEST_FINGERPRINT } from "./task-fingerprint.js";

const DEFAULT_CLOUD_SKILL_LEASE_TTL_MS = 5 * 60_000;
const MAX_CLOUD_SKILL_LEASE_TTL_MS = 15 * 60_000;
const MIN_CLOUD_SKILL_LEASE_TTL_MS = 1_000;
const DEFAULT_BILLING_OUTBOX_LEASE_MS = 30_000;
const MAX_BILLING_OUTBOX_LEASE_MS = 5 * 60_000;
export const PG_STORE_POOL_LIMITS = Object.freeze({
  connectionTimeoutMillis: 5_000,
  statement_timeout: 5_000,
  // The server must cancel the statement before node-postgres rejects locally.
  query_timeout: 6_000,
  lock_timeout: 30_000,
});

/**
 * The first release is deliberately migration-owned.  PgStore must never
 * bootstrap a partial/legacy schema: doing so can make a deployment appear
 * healthy while silently leaving old Pack, wallet, activation, or knowledge
 * tables available.  Keep this list in code so a service startup can fail
 * closed before it issues any business query.
 */
const CLEAN_LAUNCH_MIGRATION = Object.freeze({
  version: "0001",
  name: "clean-launch-baseline",
  checksum: "98bbcc61604444e7c6635ebbb2a9b8ebfd0b85e81f9faf76989ac3144d00be7f",
});

const CLEAN_LAUNCH_TABLES = Object.freeze([
  "schema_migrations",
  "account_user",
  "auth_session",
  "admin_account",
  "audit_log",
  "device",
  "device_pairing_challenge",
  "cloud_task",
  "cloud_task_event",
  "cloud_skill_adapter_release",
  "cloud_skill_plan",
  "cloud_skill_plan_skill",
  "billing_order",
  "cloud_skill_subscription",
  "cloud_skill_entitlement",
  "cloud_agent_skill_binding",
  "cloud_skill_execution_reservation",
  "model_gateway_config",
  "feature_policy",
  "client_telemetry_hourly",
  "model_request_hourly",
  "http_route_hourly",
  "feature_policy_emergency_observation",
  "model_usage_aggregate",
  "manager_release",
  "billing_settlement",
  "billing_outbox",
] as const);

/** Required columns are intentionally exhaustive, not just the columns used
 * by today's routes.  A partial baseline must fail at startup rather than
 * fail later on an infrequently used admin or outbox path. */
const CLEAN_LAUNCH_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  schema_migrations: ["version", "name", "checksum", "applied_at"],
  account_user: ["user_id", "email", "password_hash", "status", "created_at"],
  auth_session: ["token_hash", "subject_type", "subject_id", "expires_at", "created_at"],
  admin_account: ["admin_id", "username", "password_hash", "role", "status", "created_at"],
  audit_log: ["audit_id", "actor", "action", "detail", "created_at"],
  device: [
    "device_id", "tenant_id", "status", "platform", "app_version", "device_fingerprint",
    "display_name", "device_token_hash", "user_id", "last_seen_at", "last_model_success_at",
    "last_error_code", "credential_rotated_at", "min_required_version", "rollout_group", "created_at",
  ],
  device_pairing_challenge: [
    "challenge_id", "device_id", "tenant_id", "code_hash", "expires_at", "consumed_at", "created_at",
  ],
  cloud_task: [
    "task_id", "tenant_id", "device_id", "agent_id", "idempotency_key", "kind",
    "request_fingerprint", "status", "input", "output", "error", "created_at", "updated_at",
  ],
  cloud_task_event: ["event_id", "task_id", "type", "ts", "payload"],
  cloud_skill_adapter_release: [
    "skill_id", "version", "status", "manifest_data", "files_data", "digest", "signature_key_id",
    "min_manager_version", "openclaw_version", "created_at", "revoked_at",
  ],
  cloud_skill_plan: [
    "plan_id", "name", "description", "price_monthly_fen", "price_yearly_fen", "included_calls",
    "requests_per_minute", "max_concurrency", "status", "created_at",
  ],
  cloud_skill_plan_skill: ["plan_id", "skill_id"],
  billing_order: [
    "order_id", "user_id", "type", "plan_id", "tenant_id", "period", "amount_fen", "status",
    "pay_method", "provider_payment_id", "created_at", "paid_at", "refunded_at",
  ],
  cloud_skill_subscription: [
    "subscription_id", "user_id", "tenant_id", "plan_id", "status", "period", "starts_at",
    "expires_at", "cancelled_at", "refunded_at", "source_order_id", "created_at",
  ],
  cloud_skill_entitlement: [
    "entitlement_id", "subscription_id", "tenant_id", "user_id", "skill_id", "plan_id", "status",
    "expires_at", "created_at",
  ],
  cloud_agent_skill_binding: [
    "binding_id", "tenant_id", "device_id", "user_id", "agent_id", "skill_id", "status",
    "created_at", "revoked_at",
  ],
  cloud_skill_execution_reservation: [
    "reservation_id", "task_id", "user_id", "tenant_id", "device_id", "agent_id", "skill_id",
    "plan_id", "subscription_id", "input_digest", "period_start", "reserved_at", "lease_expires_at",
    "released_at", "created_at",
  ],
  model_gateway_config: [
    "config_id", "scope_type", "scope_id", "enabled", "emergency_disabled", "base_url", "model_id",
    "display_name", "api_type", "context_window", "max_tokens", "input_capabilities", "encrypted_api_key",
    "fallback_config_id", "request_timeout_ms", "max_retries", "circuit_breaker_threshold",
    "circuit_breaker_cooldown_ms", "min_manager_version", "max_manager_version", "device_requests_per_minute",
    "device_daily_tokens", "tenant_monthly_tokens", "max_device_concurrency", "input_cost_microunits_per_million",
    "output_cost_microunits_per_million", "cache_cost_microunits_per_million", "updated_at",
  ],
  feature_policy: ["policy_id", "feature_id", "audience", "scope", "scope_id", "policy", "revision", "updated_at"],
  client_telemetry_hourly: [
    "bucket_start", "event_type", "manager_version", "openclaw_version", "platform", "architecture",
    "value", "agent_count_bucket", "count",
  ],
  model_request_hourly: ["bucket_start", "api_type", "outcome", "latency_bucket", "count"],
  http_route_hourly: ["bucket_start", "route_id", "status_class", "latency_bucket", "count"],
  feature_policy_emergency_observation: [
    "policy_id", "revision", "feature_id", "policy_updated_at", "first_enforced_at", "latency_ms",
  ],
  model_usage_aggregate: [
    "period_start", "period", "tenant_id", "device_id", "config_id", "request_count", "success_count",
    "error_count", "input_tokens", "output_tokens", "cache_tokens", "estimated_tokens", "cost_microunits",
  ],
  manager_release: [
    "release_id", "channel", "sequence", "version", "platform", "arch", "filename", "url_path", "size",
    "sha256", "manifest", "signature_key_id", "signature", "rollout_status", "rollout_basis_points",
    "uploaded_by", "uploaded_at", "rollout_updated_by", "rollout_updated_at",
  ],
  billing_settlement: [
    "settlement_id", "order_id", "operation", "idempotency_key", "request_hash", "method",
    "provider_reference", "amount_fen", "created_at",
  ],
  billing_outbox: [
    "outbox_id", "event_type", "aggregate_id", "settlement_id", "payload", "attempts", "available_at",
    "locked_until", "lock_token", "published_at", "dead_lettered_at", "last_error", "created_at",
  ],
});

export class CleanLaunchSchemaError extends Error {
  readonly code = "CLEAN_LAUNCH_SCHEMA_INVALID" as const;

  constructor(detail: string) {
    super(`CLEAN_LAUNCH_SCHEMA_INVALID: ${detail}`);
    this.name = "CleanLaunchSchemaError";
  }
}

function cleanLaunchUnsupported(operation: string): Error {
  return new Error(`CLEAN_LAUNCH_UNSUPPORTED:${operation}`);
}

function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function parseExecutionNow(value: string | undefined): Date | undefined {
  const date = value === undefined ? new Date() : new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function normalizeLeaseTtl(value: number | undefined): number | undefined {
  if (value === undefined) return DEFAULT_CLOUD_SKILL_LEASE_TTL_MS;
  if (!Number.isSafeInteger(value) || value < MIN_CLOUD_SKILL_LEASE_TTL_MS || value > MAX_CLOUD_SKILL_LEASE_TTL_MS) {
    return undefined;
  }
  return value;
}

function retryAfterSeconds(untilMs: number, nowMs: number): number | undefined {
  if (!Number.isFinite(untilMs) || untilMs <= nowMs) return undefined;
  return Math.max(1, Math.ceil((untilMs - nowMs) / 1000));
}

function validProviderReference(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value);
}

function normalizeBillingOutboxLimit(value: number | undefined): number | undefined {
  if (value === undefined) return 25;
  return Number.isSafeInteger(value) && value >= 1 && value <= 100 ? value : undefined;
}

function normalizeBillingOutboxLease(value: number | undefined): number | undefined {
  if (value === undefined) return DEFAULT_BILLING_OUTBOX_LEASE_MS;
  return Number.isSafeInteger(value) && value >= 1_000 && value <= MAX_BILLING_OUTBOX_LEASE_MS
    ? value
    : undefined;
}

function parseBillingOutboxTime(value: string | undefined): Date | undefined {
  const parsed = value === undefined ? new Date() : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

function validBillingOutboxLockToken(value: string): boolean {
  return /^bol-[0-9a-f-]{36}$/u.test(value);
}

function validBillingOutboxErrorCode(value: string): boolean {
  return /^[A-Z][A-Z0-9_]{0,63}$/u.test(value);
}

function billingPeriodExpiry(startedAt: string, period: "monthly" | "yearly"): string {
  const started = new Date(startedAt);
  if (!Number.isFinite(started.getTime())) throw new BillingSettlementError("FULFILLMENT_INVALID");
  const days = period === "monthly" ? 31 : 366;
  return new Date(started.getTime() + days * 24 * 60 * 60 * 1_000).toISOString();
}

function cloudSkillQueryValue(
  query: CloudSkillEntitlementQuery | CloudSkillAccessQuery,
  snake: string,
  camel: string,
): string | undefined {
  const value = (query as Record<string, unknown>)[snake] ?? (query as Record<string, unknown>)[camel];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function validateCloudSkillPlanFields(plan: {
  plan_id: string;
  name: string;
  skill_ids: readonly string[];
  price_monthly_fen: number;
  price_yearly_fen: number;
  included_calls: number;
  requests_per_minute: number;
  max_concurrency: number;
}): void {
  const uniqueSkills = new Set(plan.skill_ids);
  if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/.test(plan.plan_id) ||
    !plan.name.trim() || plan.name.length > 120 || plan.skill_ids.length === 0 ||
    uniqueSkills.size !== plan.skill_ids.length ||
    plan.skill_ids.some((skillId) => !/^[a-z][a-z0-9.-]*\.skill\.[a-z][a-z0-9.-]*$/.test(skillId)) ||
    !Number.isSafeInteger(plan.price_monthly_fen) || plan.price_monthly_fen < 0 ||
    !Number.isSafeInteger(plan.price_yearly_fen) || plan.price_yearly_fen < 0 ||
    !Number.isSafeInteger(plan.included_calls) || plan.included_calls < 0 ||
    !Number.isSafeInteger(plan.requests_per_minute) || plan.requests_per_minute <= 0 ||
    !Number.isSafeInteger(plan.max_concurrency) || plan.max_concurrency <= 0) {
    throw new Error("INVALID_CLOUD_SKILL_PLAN");
  }
}

interface TaskRow {
  task_id: string;
  tenant_id: string;
  device_id: string;
  agent_id: string;
  kind: string;
  request_fingerprint: string;
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
  device_token_hash: string;
  user_id: string | null;
  last_seen_at: string | null;
  last_model_success_at: string | null;
  last_error_code: string | null;
  credential_rotated_at: string | null;
  min_required_version: string | null;
  rollout_group: string | null;
  created_at: string;
}

interface DevicePairingChallengeRow {
  challenge_id: string;
  device_id: string;
  tenant_id: string;
  code_hash: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

interface UserRow {
  user_id: string;
  email: string;
  password_hash: string;
  status: "active" | "disabled";
  created_at: string;
}

interface SessionRow {
  token_hash: string;
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

interface OrderRow {
  order_id: string;
  user_id: string;
  type: "cloud_skill_plan";
  plan_id: string;
  tenant_id: string;
  period: "monthly" | "yearly";
  amount_fen: string | number;
  status: "pending" | "paid" | "cancelled" | "refunded";
  pay_method: "provider" | null;
  provider_payment_id: string | null;
  created_at: string;
  paid_at: string | null;
  refunded_at: string | null;
}

interface BillingSettlementRow {
  settlement_id: string;
  order_id: string;
  operation: "payment" | "refund";
  idempotency_key: string;
  request_hash: string;
  method: "provider";
  provider_reference: string | null;
  amount_fen: string | number;
  created_at: string;
}

interface BillingOutboxRow {
  outbox_id: string;
  event_type: "billing.payment.settled" | "billing.refund.settled";
  aggregate_id: string;
  settlement_id: string;
  payload: Record<string, unknown>;
  attempts: number;
  available_at: string;
  locked_until: string | null;
  lock_token: string | null;
  published_at: string | null;
  dead_lettered_at: string | null;
  last_error: string | null;
  created_at: string;
}

interface CloudSkillPlanRow {
  plan_id: string;
  name: string;
  description: string;
  skill_ids: string[];
  price_monthly_fen: string | number;
  price_yearly_fen: string | number;
  included_calls: string | number;
  requests_per_minute: string | number;
  max_concurrency: string | number;
  status: CloudSkillPlanStatus;
  created_at: string;
}

interface CloudSkillSubscriptionRow {
  subscription_id: string;
  user_id: string;
  tenant_id: string;
  plan_id: string;
  status: CloudSkillSubscriptionStatus;
  period: "monthly" | "yearly";
  starts_at: string;
  expires_at: string;
  cancelled_at: string | null;
  refunded_at: string | null;
  source_order_id: string;
  created_at: string;
}

interface CloudSkillEntitlementRow {
  entitlement_id: string;
  subscription_id: string;
  tenant_id: string;
  user_id: string;
  skill_id: string;
  plan_id: string;
  status: "active" | "suspended" | "revoked";
  expires_at: string;
  created_at: string;
}

interface CloudAgentSkillBindingRow {
  binding_id: string;
  tenant_id: string;
  device_id: string;
  user_id: string | null;
  agent_id: string;
  skill_id: string;
  status: "active" | "revoked";
  created_at: string | Date;
  revoked_at: string | Date | null;
}

interface CloudSkillExecutionReservationRow {
  reservation_id: string;
  task_id: string;
  user_id: string;
  tenant_id: string;
  device_id: string;
  agent_id: string;
  skill_id: string;
  plan_id: string;
  subscription_id: string;
  input_digest: string | null;
  period_start: string | Date;
  reserved_at: string | Date;
  lease_expires_at: string | Date;
  released_at: string | Date | null;
  created_at: string | Date;
}

interface CloudSkillAdapterReleaseRow {
  skill_id: string;
  version: string;
  status: "active" | "revoked";
  manifest_data: CloudSkillAdapterManifest;
  files_data: Record<string, string>;
  digest: string;
  signature_key_id: string;
  min_manager_version: string;
  openclaw_version: string;
  created_at: string | Date;
  revoked_at: string | Date | null;
}

function toTask(row: TaskRow): CloudTask {
  return {
    task_id: row.task_id,
    tenant_id: row.tenant_id,
    device_id: row.device_id,
    agent_id: row.agent_id,
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

function toDevice(row: DeviceRow, clearToken?: string): DeviceRecord {
  return {
    device_id: row.device_id,
    tenant_id: row.tenant_id,
    status: row.status,
    platform: row.platform,
    app_version: row.app_version,
    device_fingerprint: row.device_fingerprint,
    display_name: row.display_name ?? undefined,
    // PostgreSQL never returns the clear credential.  Callers that already
    // possess it (registration/rotation/authentication) may pass it as the
    // second argument for the one response where it is needed.
    ...(clearToken === undefined ? {} : { device_token: clearToken }),
    user_id: row.user_id ?? undefined,
    last_seen_at: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : undefined,
    last_model_success_at: row.last_model_success_at ? new Date(row.last_model_success_at).toISOString() : undefined,
    last_error_code: row.last_error_code ?? undefined,
    credential_rotated_at: row.credential_rotated_at ? new Date(row.credential_rotated_at).toISOString() : undefined,
    min_required_version: row.min_required_version ?? undefined,
    rollout_group: row.rollout_group ?? undefined,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function toDevicePairingChallenge(row: DevicePairingChallengeRow): DevicePairingChallengeRecord {
  return {
    challenge_id: row.challenge_id,
    device_id: row.device_id,
    tenant_id: row.tenant_id,
    code_hash: row.code_hash,
    expires_at: new Date(row.expires_at).toISOString(),
    ...(row.consumed_at === null ? {} : { consumed_at: new Date(row.consumed_at).toISOString() }),
    created_at: new Date(row.created_at).toISOString(),
  };
}

function toCloudSkillAdapterRelease(row: CloudSkillAdapterReleaseRow): CloudSkillAdapterReleaseRecord {
  return {
    skill_id: row.skill_id,
    version: row.version,
    status: row.status,
    manifest: row.manifest_data,
    files: { ...row.files_data },
    digest: row.digest,
    signature_key_id: row.signature_key_id,
    min_manager_version: row.min_manager_version,
    openclaw_version: row.openclaw_version,
    created_at: new Date(row.created_at).toISOString(),
    ...(row.revoked_at === null ? {} : { revoked_at: new Date(row.revoked_at).toISOString() }),
  };
}

interface FeaturePolicyRow {
  policy_id: string;
  policy: unknown;
  revision: string | number;
  updated_at: string | Date;
}

function toFeaturePolicy(row: FeaturePolicyRow): FeaturePolicyRecord {
  return {
    policy_id: row.policy_id,
    policy: parseFeaturePolicyEntry(row.policy),
    revision: Number(row.revision),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

type ModelConfigRow = Omit<ModelGatewayConfigRecord,
  "updated_at" | "fallback_config_id" | "max_manager_version" |
  "assistant_name" | "assistant_avatar_path" | "welcome_message" | "quick_tasks" | "features" |
  "device_daily_tokens" | "tenant_monthly_tokens" |
  "input_cost_microunits_per_million" | "output_cost_microunits_per_million" |
  "cache_cost_microunits_per_million"
> & {
  updated_at: string | Date;
  fallback_config_id: string | null;
  max_manager_version: string | null;
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
    max_manager_version: row.max_manager_version ?? undefined,
    device_daily_tokens: Number(row.device_daily_tokens),
    tenant_monthly_tokens: Number(row.tenant_monthly_tokens),
    input_cost_microunits_per_million: Number(row.input_cost_microunits_per_million),
    output_cost_microunits_per_million: Number(row.output_cost_microunits_per_million),
    cache_cost_microunits_per_million: Number(row.cache_cost_microunits_per_million),
    updated_at: new Date(row.updated_at).toISOString(),
  } as unknown as ModelGatewayConfigRecord;
}

function toUser(row: UserRow): UserRecord {
  return {
    user_id: row.user_id,
    email: row.email,
    password_hash: row.password_hash,
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
  } as UserRecord;
}

function toSession(row: SessionRow, token: string): SessionRecord {
  return {
    token,
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

function toOrder(row: OrderRow): OrderRecord {
  return {
    order_id: row.order_id,
    user_id: row.user_id,
    type: row.type,
    plan_id: row.plan_id,
    tenant_id: row.tenant_id,
    period: row.period,
    amount_fen: Number(row.amount_fen),
    status: row.status,
    pay_method: row.pay_method ?? undefined,
    created_at: new Date(row.created_at).toISOString(),
    paid_at: row.paid_at ? new Date(row.paid_at).toISOString() : undefined,
    refunded_at: row.refunded_at ? new Date(row.refunded_at).toISOString() : undefined,
  } as unknown as OrderRecord;
}

function toBillingSettlement(row: BillingSettlementRow): BillingSettlementRecord {
  return {
    settlement_id: row.settlement_id,
    order_id: row.order_id,
    operation: row.operation,
    idempotency_key: row.idempotency_key,
    request_hash: row.request_hash,
    method: row.method ?? undefined,
    provider_reference: row.provider_reference ?? undefined,
    amount_fen: Number(row.amount_fen),
    created_at: new Date(row.created_at).toISOString(),
  } as unknown as BillingSettlementRecord;
}

function toBillingOutbox(row: BillingOutboxRow): BillingOutboxRecord {
  return {
    outbox_id: row.outbox_id,
    event_type: row.event_type,
    aggregate_id: row.aggregate_id,
    settlement_id: row.settlement_id,
    payload: row.payload,
    attempts: Number(row.attempts),
    available_at: new Date(row.available_at).toISOString(),
    locked_until: row.locked_until ? new Date(row.locked_until).toISOString() : undefined,
    lock_token: row.lock_token ?? undefined,
    published_at: row.published_at ? new Date(row.published_at).toISOString() : undefined,
    dead_lettered_at: row.dead_lettered_at ? new Date(row.dead_lettered_at).toISOString() : undefined,
    last_error: row.last_error ?? undefined,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function toCloudSkillPlan(row: CloudSkillPlanRow): CloudSkillPlanRecord {
  return {
    plan_id: row.plan_id,
    name: row.name,
    description: row.description,
    skill_ids: Array.isArray(row.skill_ids) ? [...row.skill_ids] : [],
    price_monthly_fen: Number(row.price_monthly_fen),
    price_yearly_fen: Number(row.price_yearly_fen),
    included_calls: Number(row.included_calls),
    requests_per_minute: Number(row.requests_per_minute),
    max_concurrency: Number(row.max_concurrency),
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function toCloudSkillSubscription(row: CloudSkillSubscriptionRow): CloudSkillSubscriptionRecord {
  return {
    subscription_id: row.subscription_id,
    user_id: row.user_id,
    tenant_id: row.tenant_id,
    plan_id: row.plan_id,
    status: row.status,
    period: row.period,
    starts_at: new Date(row.starts_at).toISOString(),
    expires_at: new Date(row.expires_at).toISOString(),
    ...(row.cancelled_at === null ? {} : { cancelled_at: new Date(row.cancelled_at).toISOString() }),
    ...(row.refunded_at === null ? {} : { refunded_at: new Date(row.refunded_at).toISOString() }),
    source_order_id: row.source_order_id,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function toCloudSkillEntitlement(row: CloudSkillEntitlementRow): CloudSkillEntitlementRecord {
  return {
    entitlement_id: row.entitlement_id,
    subscription_id: row.subscription_id,
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    skill_id: row.skill_id,
    plan_id: row.plan_id,
    status: row.status,
    expires_at: new Date(row.expires_at).toISOString(),
    created_at: new Date(row.created_at).toISOString(),
  };
}

function toCloudAgentSkillBinding(row: CloudAgentSkillBindingRow): CloudAgentSkillBindingRecord {
  return {
    binding_id: row.binding_id,
    tenant_id: row.tenant_id,
    device_id: row.device_id,
    ...(row.user_id === null ? {} : { user_id: row.user_id }),
    agent_id: row.agent_id,
    skill_id: row.skill_id,
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
    ...(row.revoked_at === null ? {} : { revoked_at: new Date(row.revoked_at).toISOString() }),
  };
}

function toCloudSkillExecutionReservation(
  row: CloudSkillExecutionReservationRow,
): CloudSkillExecutionReservation {
  return {
    reservation_id: row.reservation_id,
    task_id: row.task_id,
    user_id: row.user_id,
    tenant_id: row.tenant_id,
    device_id: row.device_id,
    agent_id: row.agent_id,
    skill_id: row.skill_id,
    plan_id: row.plan_id,
    subscription_id: row.subscription_id,
    ...(row.input_digest === null ? {} : { input_digest: row.input_digest }),
    period_start: new Date(row.period_start).toISOString(),
    reserved_at: new Date(row.reserved_at).toISOString(),
    lease_expires_at: new Date(row.lease_expires_at).toISOString(),
    ...(row.released_at === null ? {} : { released_at: new Date(row.released_at).toISOString() }),
  };
}

export class PgStore implements CloudStore {
  private readonly pool: pg.Pool;
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      ...PG_STORE_POOL_LIMITS,
    });
  }

  /**
   * Verify the migration-owned clean-launch schema.  This method is read-only:
   * migrations are an explicit deployment step and a service process must not
   * create, alter, or repair tables on startup.
   */
  private async assertCleanLaunchSchema(): Promise<void> {
    const tableResult = await this.pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    const actualTables = tableResult.rows.map((row) => row.tablename);
    const expectedTables = [...CLEAN_LAUNCH_TABLES];
    const missingTables = expectedTables.filter((name) => !actualTables.includes(name));
    const unexpectedTables = actualTables.filter((name) => !expectedTables.includes(name as typeof CLEAN_LAUNCH_TABLES[number]));
    if (missingTables.length || unexpectedTables.length) {
      throw new CleanLaunchSchemaError(JSON.stringify({ missingTables, unexpectedTables }));
    }

    const migrationResult = await this.pool.query<{
      version: string;
      name: string;
      checksum: string;
    }>(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
    );
    const migrationRows = migrationResult.rows;
    const baseline = migrationRows.find((row) => row.version === CLEAN_LAUNCH_MIGRATION.version);
    const unknownMigrations = migrationRows
      .filter((row) => row.version !== CLEAN_LAUNCH_MIGRATION.version)
      .map((row) => row.version);
    if (!baseline || baseline.name !== CLEAN_LAUNCH_MIGRATION.name ||
      baseline.checksum !== CLEAN_LAUNCH_MIGRATION.checksum || unknownMigrations.length > 0) {
      throw new CleanLaunchSchemaError(JSON.stringify({
        expectedMigration: CLEAN_LAUNCH_MIGRATION,
        actualMigrations: migrationRows,
      }));
    }

    const columnResult = await this.pool.query<{
      table_name: string;
      column_name: string;
    }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [expectedTables],
    );
    const actualColumns = new Set(columnResult.rows.map((row) => `${row.table_name}.${row.column_name}`));
    const missingColumns: string[] = [];
    for (const [table, columns] of Object.entries(CLEAN_LAUNCH_COLUMNS)) {
      for (const column of columns) {
        if (!actualColumns.has(`${table}.${column}`)) missingColumns.push(`${table}.${column}`);
      }
    }
    const expectedColumnKeys = new Set(
      Object.entries(CLEAN_LAUNCH_COLUMNS).flatMap(([table, columns]) => columns.map((column) => `${table}.${column}`)),
    );
    const unexpectedColumns = columnResult.rows
      .map((row) => `${row.table_name}.${row.column_name}`)
      .filter((key) => !expectedColumnKeys.has(key));
    const legacyColumns = [
      "account_user.balance_fen", "device.device_token", "device.activation_code_id", "device.activated_at",
      "billing_order.product_id", "billing_order.pack_id", "model_gateway_config.assistant_name",
      "model_gateway_config.assistant_avatar_path", "model_gateway_config.welcome_message",
      "model_gateway_config.quick_tasks", "model_gateway_config.features",
    ];
    const retiredColumns = legacyColumns.filter((column) => actualColumns.has(column));
    if (missingColumns.length || unexpectedColumns.length || retiredColumns.length) {
      throw new CleanLaunchSchemaError(JSON.stringify({ missingColumns, unexpectedColumns, retiredColumns }));
    }

    const sequenceResult = await this.pool.query<{ sequence_name: string }>(
      `SELECT sequence_name FROM information_schema.sequences
        WHERE sequence_schema = 'public' AND sequence_name = 'feature_policy_revision_seq'`,
    );
    if (sequenceResult.rows.length !== 1) {
      throw new CleanLaunchSchemaError("missing sequence feature_policy_revision_seq");
    }
  }

  /** Migration-owned clean-launch schema; never self-creates or repairs DDL. */
  async init(): Promise<void> {
    await this.assertCleanLaunchSchema();
    return;
  }
  async findTaskByIdempotency(
    idempotencyKey: string,
    owner: CloudTaskOwner,
  ): Promise<CloudTaskIdempotencyBinding | undefined> {
    const existing = await this.pool.query<TaskRow>(
      `SELECT * FROM cloud_task
       WHERE tenant_id = $1 AND device_id = $2 AND agent_id = $3 AND idempotency_key = $4`,
      [owner.tenant_id, owner.device_id, owner.agent_id, idempotencyKey],
    );
    const row = existing.rows[0];
    if (!row) return undefined;
    return {
      task: toTask(row),
      request_fingerprint: row.request_fingerprint,
    };
  }

  async createTask(
    idempotencyKey: string,
    kind: string,
    input: unknown,
    owner?: CloudTaskOwner,
    requestFingerprint?: string,
  ): Promise<{ task: CloudTask; existed: boolean }> {
    if (!owner) throw cleanLaunchUnsupported("task.owner_required");
    if (!requestFingerprint) throw cleanLaunchUnsupported("task.request_fingerprint_required");
    const normalizedFingerprint = normalizeCloudTaskRequestFingerprint(requestFingerprint);
    const taskId = `ct-${randomUUID()}`;
    const inserted = await this.pool.query<TaskRow>(
      `INSERT INTO cloud_task (task_id, tenant_id, device_id, agent_id, idempotency_key, kind, request_fingerprint, status, input)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
       ON CONFLICT (tenant_id, device_id, agent_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [
        taskId,
        owner.tenant_id,
        owner.device_id,
        owner.agent_id,
        idempotencyKey,
        kind,
        normalizedFingerprint,
        JSON.stringify(input),
      ],
    );
    if (inserted.rowCount === 0) {
      const existing = await this.findTaskByIdempotency(idempotencyKey, owner);
      if (!existing) throw new Error("Task idempotency owner lookup failed");
      const existingFingerprint = existing.request_fingerprint;
      // Historical rows have no trustworthy binding and must fail closed;
      // they cannot be replayed or silently rebound by a new request.
      if (existingFingerprint === LEGACY_UNBOUND_TASK_REQUEST_FINGERPRINT || existingFingerprint !== normalizedFingerprint) {
        throw new CloudTaskIdempotencyConflictError();
      }
      return { task: existing.task, existed: true };
    }
    await this.appendEvent(taskId, "task.accepted");
    return { task: toTask(inserted.rows[0]!), existed: false };
  }

  async getTask(taskId: string): Promise<CloudTask | undefined> {
    const res = await this.pool.query<TaskRow>(`SELECT * FROM cloud_task WHERE task_id = $1`, [taskId]);
    return res.rows[0] ? toTask(res.rows[0]) : undefined;
  }

  async discardPendingTask(taskId: string, placeholder: CloudTaskAdmissionPlaceholder): Promise<boolean> {
    if (!isCloudTaskAdmissionPlaceholder(placeholder)) return false;
    const result = await this.pool.query(
      `DELETE FROM cloud_task
        WHERE task_id = $1 AND status = 'pending' AND input = $2::jsonb
        RETURNING task_id`,
      [taskId, JSON.stringify(placeholder)],
    );
    return result.rowCount === 1;
  }

  async admitPendingTaskInput(
    taskId: string,
    placeholder: CloudTaskAdmissionPlaceholder,
    input: unknown,
  ): Promise<CloudTask | undefined> {
    if (!isCloudTaskAdmissionPlaceholder(placeholder)) return undefined;
    const result = await this.pool.query<TaskRow>(
      `UPDATE cloud_task
          SET input = $3::jsonb, updated_at = now()
        WHERE task_id = $1 AND status = 'pending' AND input = $2::jsonb
        RETURNING *`,
      [taskId, JSON.stringify(placeholder), JSON.stringify(input)],
    );
    return result.rows[0] ? toTask(result.rows[0]) : undefined;
  }

  async claimPendingTask(taskId: string): Promise<CloudTask | undefined> {
    // The status predicate is the database CAS boundary. A concurrent cancel
    // either wins first (zero rows, so the worker exits) or observes running;
    // it can never be overwritten by an unconditional transition.
    const res = await this.pool.query<TaskRow>(
      `UPDATE cloud_task
       SET status = 'running', updated_at = now()
       WHERE task_id = $1 AND status = 'pending'
       RETURNING *`,
      [taskId],
    );
    if (res.rowCount === 0) return undefined;
    const task = toTask(res.rows[0]!);
    await this.appendEvent(taskId, TASK_EVENT_TYPE.running);
    return task;
  }

  async transitionIfStatus(
    taskId: string,
    expectedStatuses: readonly CloudTaskStatus[],
    status: CloudTaskStatus,
    patch?: Partial<CloudTask>,
  ): Promise<CloudTask | undefined> {
    if (expectedStatuses.length === 0) return undefined;
    const res = await this.pool.query<TaskRow>(
      `UPDATE cloud_task
       SET status = $3,
           output = COALESCE($4, output),
           error = COALESCE($5, error),
           updated_at = now()
       WHERE task_id = $1 AND status = ANY($2::text[])
       RETURNING *`,
      [
        taskId,
        expectedStatuses,
        status,
        patch?.output !== undefined ? JSON.stringify(patch.output) : null,
        patch?.error !== undefined ? JSON.stringify(patch.error) : null,
      ],
    );
    if (res.rowCount === 0) return undefined;
    const task = toTask(res.rows[0]!);
    await this.appendEvent(taskId, TASK_EVENT_TYPE[status], task.error ? { error: task.error } : undefined);
    return task;
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
    const clearToken = `dt-${randomUUID()}${randomUUID()}`;
    try {
      const res = await this.pool.query<DeviceRow>(
      `INSERT INTO device (device_id, tenant_id, platform, app_version, device_fingerprint, display_name, device_token_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        `dev-${randomUUID()}`,
        params.tenant_id,
        params.platform,
        params.app_version,
        params.device_fingerprint,
        params.display_name ?? null,
        hashDeviceToken(clearToken),
      ],
      );
      return { device: toDevice(res.rows[0]!, clearToken), existed: false };
    } catch (error) {
      // The partial fingerprint index is the race boundary.  Never return a
      // credential from the row that won the race.
      if ((error as { code?: string }).code === "23505") {
        const raced = await this.pool.query<DeviceRow>(
          `SELECT * FROM device WHERE tenant_id=$1 AND device_fingerprint=$2 AND status='active'`,
          [params.tenant_id, params.device_fingerprint],
        );
        if (raced.rows[0]) return { device: toDevice(raced.rows[0]), existed: true };
      }
      throw error;
    }
  }

  async createDevicePairingChallenge(params: {
    challenge_id: string;
    device_id: string;
    code_hash: string;
    expires_at: string;
    now?: string;
  }): Promise<DevicePairingChallengeRecord | undefined> {
    const now = params.now ?? new Date().toISOString();
    const nowDate = new Date(now);
    const expiresDate = new Date(params.expires_at);
    if (!Number.isFinite(nowDate.getTime()) || !Number.isFinite(expiresDate.getTime()) || expiresDate <= nowDate) {
      return undefined;
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const deviceResult = await client.query<DeviceRow>(
        `SELECT * FROM device WHERE device_id=$1 FOR UPDATE`, [params.device_id],
      );
      const device = deviceResult.rows[0];
      if (!device || device.status !== "active" || device.user_id !== null) {
        await client.query("ROLLBACK");
        return undefined;
      }
      // A device has at most one redeemable proof.  Reissuing invalidates the
      // previous digest while the device row lock serializes concurrent calls.
      await client.query(
        `DELETE FROM device_pairing_challenge
          WHERE device_id=$1 AND consumed_at IS NULL`, [params.device_id],
      );
      const inserted = await client.query<DevicePairingChallengeRow>(
        `INSERT INTO device_pairing_challenge
           (challenge_id,device_id,tenant_id,code_hash,expires_at,created_at)
         VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
        [params.challenge_id, device.device_id, device.tenant_id, params.code_hash, expiresDate.toISOString(), nowDate.toISOString()],
      );
      await client.query("COMMIT");
      return inserted.rows[0] ? toDevicePairingChallenge(inserted.rows[0]) : undefined;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async consumeDevicePairingChallenge(params: {
    code_hash: string;
    user_id: string;
    now?: string;
  }): Promise<DevicePairingConsumeResult> {
    const now = params.now ?? new Date().toISOString();
    const nowDate = new Date(now);
    if (!Number.isFinite(nowDate.getTime())) return { ok: false, reason: "CODE_INVALID" };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const challengeResult = await client.query<DevicePairingChallengeRow>(
        `SELECT * FROM device_pairing_challenge WHERE code_hash=$1 FOR UPDATE`, [params.code_hash],
      );
      const challenge = challengeResult.rows[0];
      if (!challenge || challenge.consumed_at !== null) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "CODE_INVALID" };
      }
      if (new Date(challenge.expires_at) <= nowDate) {
        await client.query(`DELETE FROM device_pairing_challenge WHERE challenge_id=$1`, [challenge.challenge_id]);
        await client.query("COMMIT");
        return { ok: false, reason: "CODE_EXPIRED" };
      }
      const deviceResult = await client.query<DeviceRow>(
        `SELECT * FROM device WHERE device_id=$1 FOR UPDATE`, [challenge.device_id],
      );
      const device = deviceResult.rows[0];
      if (!device) {
        await client.query(`DELETE FROM device_pairing_challenge WHERE challenge_id=$1`, [challenge.challenge_id]);
        await client.query("COMMIT");
        return { ok: false, reason: "DEVICE_NOT_FOUND" };
      }
      if (device.status !== "active") {
        await client.query("COMMIT");
        return { ok: false, reason: "DEVICE_REVOKED" };
      }
      if (device.user_id !== null) {
        await client.query("COMMIT");
        return { ok: false, reason: "DEVICE_ALREADY_BOUND" };
      }
      const updatedDevice = await client.query<DeviceRow>(
        `UPDATE device SET user_id=$2 WHERE device_id=$1 RETURNING *`, [device.device_id, params.user_id],
      );
      await client.query(
        `UPDATE device_pairing_challenge SET consumed_at=$2 WHERE challenge_id=$1`,
        [challenge.challenge_id, nowDate.toISOString()],
      );
      await client.query(
        `DELETE FROM device_pairing_challenge
          WHERE device_id=$1 AND challenge_id<>$2 AND consumed_at IS NULL`,
        [device.device_id, challenge.challenge_id],
      );
      await client.query("COMMIT");
      return updatedDevice.rows[0]
        ? { ok: true, device: toDevice(updatedDevice.rows[0]) }
        : { ok: false, reason: "DEVICE_NOT_FOUND" };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getDevice(deviceId: string): Promise<DeviceRecord | undefined> {
    const res = await this.pool.query<DeviceRow>(`SELECT * FROM device WHERE device_id = $1`, [deviceId]);
    return res.rows[0] ? toDevice(res.rows[0]) : undefined;
  }

  async findDeviceByToken(token: string): Promise<DeviceRecord | undefined> {
    const res = await this.pool.query<DeviceRow>(`SELECT * FROM device WHERE device_token_hash = $1`, [hashDeviceToken(token)]);
    // Authentication only needs the device's non-secret metadata.  The clear
    // bearer is never reconstructed into a DeviceRecord after the hash lookup;
    // registration and explicit admin rotation are the only responses that
    // carry a freshly issued token.
    return res.rows[0] ? toDevice(res.rows[0]) : undefined;
  }

  async listDevices(userId?: string): Promise<DeviceRecord[]> {
    const res = userId
      ? await this.pool.query<DeviceRow>(`SELECT * FROM device WHERE user_id = $1 ORDER BY created_at`, [userId])
      : await this.pool.query<DeviceRow>(`SELECT * FROM device ORDER BY created_at`);
    return res.rows.map((row) => toDevice(row));
  }

  async bindDevice(deviceId: string, userId: string): Promise<DeviceRecord | undefined> {
    const res = await this.pool.query<DeviceRow>(
      `UPDATE device SET user_id = $2 WHERE device_id = $1 RETURNING *`,
      [deviceId, userId],
    );
    return res.rows[0] ? toDevice(res.rows[0]) : undefined;
  }

  async updateDeviceVersion(deviceId: string, appVersion: string): Promise<DeviceRecord | undefined> {
    const result = await this.pool.query<DeviceRow>(
      `UPDATE device SET app_version = $2 WHERE device_id = $1 RETURNING *`,
      [deviceId, appVersion],
    );
    return result.rows[0] ? toDevice(result.rows[0]) : undefined;
  }

  async updateDeviceOperations(deviceId: string, patch: Partial<Pick<DeviceRecord, "status" | "last_seen_at" | "last_model_success_at" | "last_error_code" | "credential_rotated_at" | "min_required_version" | "rollout_group" | "device_token">>): Promise<DeviceRecord | undefined> {
    const current = await this.getDevice(deviceId);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    const clearToken = patch.device_token;
    const result = await this.pool.query<DeviceRow>(
      `UPDATE device SET status=$2, last_seen_at=$3, last_model_success_at=$4, last_error_code=$5,
       credential_rotated_at=$6, min_required_version=$7, rollout_group=$8,
       device_token_hash=COALESCE($9, device_token_hash)
       WHERE device_id=$1 RETURNING *`,
      [deviceId, next.status, next.last_seen_at ?? null, next.last_model_success_at ?? null, next.last_error_code ?? null,
        next.credential_rotated_at ?? null, next.min_required_version ?? null, next.rollout_group ?? null,
        clearToken === undefined ? null : hashDeviceToken(clearToken)],
    );
    return result.rows[0] ? toDevice(result.rows[0], clearToken) : undefined;
  }

  /** Activation codes are retired from the clean-launch schema. */
  async createActivationCode(params: {
    tenant_id: string;
    code_hash: string;
    code_hint: string;
    label?: string;
    max_uses: number;
    pack_ids: string[];
    expires_at: string;
  }): Promise<ActivationCodeRecord> {
    void params;
    throw cleanLaunchUnsupported("activation.create");
  }

  async getActivationCode(activationCodeId: string): Promise<ActivationCodeRecord | undefined> {
    void activationCodeId;
    throw cleanLaunchUnsupported("activation.get");
  }

  async listActivationCodes(): Promise<ActivationCodeRecord[]> {
    throw cleanLaunchUnsupported("activation.list");
  }

  async revokeActivationCode(activationCodeId: string): Promise<ActivationCodeRecord | undefined> {
    void activationCodeId;
    throw cleanLaunchUnsupported("activation.revoke");
  }

  async redeemActivationCode(params: {
    device_id: string;
    code_hash: string;
    now: string;
  }): Promise<ActivationRedemptionResult> {
    void params;
    throw cleanLaunchUnsupported("activation.redeem");
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
      `INSERT INTO auth_session (token_hash, subject_type, subject_id, expires_at)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [hashSessionToken(params.token), params.subject_type, params.subject_id, params.expires_at],
    );
    return toSession(res.rows[0]!, params.token);
  }

  async getSession(token: string): Promise<SessionRecord | undefined> {
    const res = await this.pool.query<SessionRow>(
      `SELECT * FROM auth_session WHERE token_hash = $1 AND expires_at > now()`,
      [hashSessionToken(token)],
    );
    return res.rows[0] ? toSession(res.rows[0], token) : undefined;
  }

  async deleteSession(token: string): Promise<void> {
    await this.pool.query(`DELETE FROM auth_session WHERE token_hash = $1`, [hashSessionToken(token)]);
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

  /** Catalog products are a retired Pack surface in clean launch. */
  async createProduct(params: {
    pack_id: string;
    name: string;
    description: string;
    price_monthly_fen: number;
    price_yearly_fen: number;
    status?: "listed" | "unlisted";
  }): Promise<ProductRecord> {
    void params;
    throw cleanLaunchUnsupported("product.create");
  }

  async updateProduct(
    productId: string,
    patch: Partial<Pick<ProductRecord, "name" | "description" | "price_monthly_fen" | "price_yearly_fen" | "status">>,
  ): Promise<ProductRecord | undefined> {
    void productId;
    void patch;
    throw cleanLaunchUnsupported("product.update");
  }

  async getProduct(productId: string): Promise<ProductRecord | undefined> {
    void productId;
    throw cleanLaunchUnsupported("product.get");
  }

  async listProducts(): Promise<ProductRecord[]> {
    throw cleanLaunchUnsupported("product.list");
  }

  async createOrder(params: {
    user_id: string;
    type: "plan" | "cloud_skill_plan" | "recharge";
    product_id?: string;
    pack_id?: string;
    plan_id?: string;
    tenant_id?: string;
    period?: "monthly" | "yearly";
    amount_fen: number;
  }): Promise<OrderRecord> {
    if (params.type !== "cloud_skill_plan" || !params.plan_id || !params.tenant_id || !params.period ||
      params.product_id !== undefined || params.pack_id !== undefined) {
      throw cleanLaunchUnsupported("billing.order_legacy_type");
    }
    const res = await this.pool.query<OrderRow>(
      `INSERT INTO billing_order
         (order_id, user_id, type, plan_id, tenant_id, period, amount_fen, pay_method)
       VALUES ($1, $2, 'cloud_skill_plan', $3, $4, $5, $6, NULL)
       RETURNING order_id, user_id, type, plan_id, tenant_id, period, amount_fen, status,
                 pay_method, provider_payment_id, created_at, paid_at, refunded_at`,
      [
        `ord-${randomUUID()}`,
        params.user_id,
        params.plan_id,
        params.tenant_id,
        params.period,
        params.amount_fen,
      ],
    );
    return toOrder(res.rows[0]!);
  }

  async getOrder(orderId: string): Promise<OrderRecord | undefined> {
    const res = await this.pool.query<OrderRow>(
      `SELECT order_id, user_id, type, plan_id, tenant_id, period, amount_fen, status,
              pay_method, provider_payment_id, created_at, paid_at, refunded_at
         FROM billing_order WHERE order_id = $1 AND type = 'cloud_skill_plan'`, [orderId],
    );
    return res.rows[0] ? toOrder(res.rows[0]) : undefined;
  }

  async updateOrder(
    orderId: string,
    patch: Partial<Pick<OrderRecord, "status" | "pay_method" | "paid_at" | "refunded_at">>,
  ): Promise<OrderRecord | undefined> {
    const paymentMethod = (patch as { pay_method?: string | null }).pay_method;
    if (paymentMethod !== undefined && paymentMethod !== null && paymentMethod !== "provider") {
      throw cleanLaunchUnsupported("billing.payment_method");
    }
    const res = await this.pool.query<OrderRow>(
      `UPDATE billing_order SET
         status = COALESCE($2, status),
         pay_method = COALESCE($3, pay_method),
         paid_at = COALESCE($4, paid_at),
         refunded_at = COALESCE($5, refunded_at)
       WHERE order_id = $1 AND type = 'cloud_skill_plan'
       RETURNING order_id, user_id, type, plan_id, tenant_id, period, amount_fen, status,
                 pay_method, provider_payment_id, created_at, paid_at, refunded_at`,
      [orderId, patch.status ?? null, paymentMethod ?? null, patch.paid_at ?? null, patch.refunded_at ?? null],
    );
    return res.rows[0] ? toOrder(res.rows[0]) : undefined;
  }

  async listOrders(userId?: string): Promise<OrderRecord[]> {
    const res = userId
      ? await this.pool.query<OrderRow>(`SELECT order_id, user_id, type, plan_id, tenant_id, period, amount_fen, status,
          pay_method, provider_payment_id, created_at, paid_at, refunded_at
          FROM billing_order WHERE user_id = $1 AND type = 'cloud_skill_plan' ORDER BY created_at DESC`, [
          userId,
        ])
      : await this.pool.query<OrderRow>(`SELECT order_id, user_id, type, plan_id, tenant_id, period, amount_fen, status,
          pay_method, provider_payment_id, created_at, paid_at, refunded_at
          FROM billing_order WHERE type = 'cloud_skill_plan' ORDER BY created_at DESC`);
    return res.rows.map(toOrder);
  }

  private async loadProviderSettlementResult(
    client: pg.PoolClient,
    settlementRow: BillingSettlementRow,
    replayed: boolean,
  ): Promise<BillingSettlementResult> {
    const orderResult = await client.query<OrderRow>(
      `SELECT order_id, user_id, type, plan_id, tenant_id, period, amount_fen, status,
              pay_method, provider_payment_id, created_at, paid_at, refunded_at
         FROM billing_order WHERE order_id=$1`,
      [settlementRow.order_id],
    );
    const outboxResult = await client.query<BillingOutboxRow>(
      `SELECT * FROM billing_outbox WHERE settlement_id=$1 ORDER BY created_at, outbox_id`,
      [settlementRow.settlement_id],
    );
    if (!orderResult.rows[0] || outboxResult.rows.length !== 1) {
      throw new BillingSettlementError("REFUND_REQUIRES_RECONCILIATION");
    }
    const subscriptionResult = await client.query<CloudSkillSubscriptionRow>(
      `SELECT * FROM cloud_skill_subscription WHERE source_order_id=$1`,
      [settlementRow.order_id],
    );
    const subscription = subscriptionResult.rows[0];
    const entitlementResult = subscription
      ? await client.query<CloudSkillEntitlementRow>(
          `SELECT * FROM cloud_skill_entitlement WHERE subscription_id=$1 ORDER BY skill_id`,
          [subscription.subscription_id],
        )
      : { rows: [] as CloudSkillEntitlementRow[] };
    return {
      replayed,
      settlement: toBillingSettlement(settlementRow),
      order: toOrder(orderResult.rows[0]),
      ...(subscription ? { subscription: toCloudSkillSubscription(subscription) } : {}),
      ...(entitlementResult.rows.length > 0
        ? { cloud_skill_entitlements: entitlementResult.rows.map(toCloudSkillEntitlement) }
        : {}),
      outbox: toBillingOutbox(outboxResult.rows[0]!),
    };
  }

  private async findProviderSettlementReplay(
    client: pg.PoolClient,
    operation: "payment" | "refund",
    orderId: string,
    idempotencyKey: string,
    requestHash: string,
    providerReference: string,
  ): Promise<BillingSettlementResult | undefined> {
    const existing = await client.query<BillingSettlementRow>(
      `SELECT * FROM billing_settlement
        WHERE (order_id=$1 AND operation=$2) OR (operation=$2 AND idempotency_key=$3)
        ORDER BY settlement_id
        FOR UPDATE`,
      [orderId, operation, idempotencyKey],
    );
    if (existing.rows.length === 0) return undefined;
    if (existing.rows.length !== 1) throw new BillingSettlementError("IDEMPOTENCY_CONFLICT");
    const row = existing.rows[0]!;
    if (row.order_id !== orderId || row.operation !== operation || row.idempotency_key !== idempotencyKey ||
      row.request_hash !== requestHash || row.method !== "provider" ||
      row.provider_reference !== providerReference) {
      throw new BillingSettlementError("IDEMPOTENCY_CONFLICT");
    }
    return this.loadProviderSettlementResult(client, row, true);
  }

  /** Provider facts can enter only through a verified internal adapter. */
  async settleOrderPayment(params: SettleOrderPaymentParams): Promise<BillingSettlementResult> {
    if (params.method !== "provider") {
      throw new BillingSettlementError("SETTLEMENT_UNAVAILABLE", "provider payment adapter is required", 503);
    }
    if (!validProviderReference(params.provider_reference) ||
      !/^[\x21-\x7e]{1,128}$/u.test(params.idempotency_key) ||
      !/^v1:[a-f0-9]{64}$/u.test(params.request_hash)) {
      throw new BillingSettlementError("FULFILLMENT_INVALID", "provider settlement identity is invalid", 422);
    }
    const paidAt = params.paid_at ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(paidAt))) throw new BillingSettlementError("FULFILLMENT_INVALID");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const orderResult = await client.query<OrderRow>(
        `SELECT order_id, user_id, type, plan_id, tenant_id, period, amount_fen, status,
                pay_method, provider_payment_id, created_at, paid_at, refunded_at
           FROM billing_order WHERE order_id=$1 FOR UPDATE`,
        [params.order_id],
      );
      const order = orderResult.rows[0];
      if (!order || order.user_id !== params.user_id) throw new BillingSettlementError("ORDER_NOT_FOUND");
      const replay = await this.findProviderSettlementReplay(
        client, "payment", params.order_id, params.idempotency_key, params.request_hash,
        params.provider_reference,
      );
      if (replay) {
        await client.query("COMMIT");
        return replay;
      }
      if (order.status !== "pending") throw new BillingSettlementError("ORDER_NOT_PENDING");
      if (order.type !== "cloud_skill_plan" || !order.plan_id || !order.tenant_id ||
        (order.period !== "monthly" && order.period !== "yearly")) {
        throw new BillingSettlementError("FULFILLMENT_INVALID");
      }
      const planSkills = await client.query<{ skill_id: string }>(
        `SELECT skill_id FROM cloud_skill_plan_skill WHERE plan_id=$1 ORDER BY skill_id`,
        [order.plan_id],
      );
      if (planSkills.rows.length === 0) throw new BillingSettlementError("FULFILLMENT_INVALID");

      const settlementId = `bst-${randomUUID()}`;
      const settlementResult = await client.query<BillingSettlementRow>(
        `INSERT INTO billing_settlement
           (settlement_id,order_id,operation,idempotency_key,request_hash,method,provider_reference,amount_fen)
         VALUES($1,$2,'payment',$3,$4,'provider',$5,$6) RETURNING *`,
        [settlementId, order.order_id, params.idempotency_key, params.request_hash,
          params.provider_reference, order.amount_fen],
      );
      await client.query(
        `UPDATE billing_order SET status='paid', pay_method='provider', provider_payment_id=$2, paid_at=$3
          WHERE order_id=$1`,
        [order.order_id, params.provider_reference, paidAt],
      );
      const subscriptionId = `csub-${randomUUID()}`;
      const expiresAt = billingPeriodExpiry(paidAt, order.period);
      await client.query(
        `INSERT INTO cloud_skill_subscription
           (subscription_id,user_id,tenant_id,plan_id,status,period,starts_at,expires_at,source_order_id)
         VALUES($1,$2,$3,$4,'active',$5,$6,$7,$8)`,
        [subscriptionId, order.user_id, order.tenant_id, order.plan_id, order.period,
          paidAt, expiresAt, order.order_id],
      );
      for (const { skill_id: skillId } of planSkills.rows) {
        await client.query(
          `INSERT INTO cloud_skill_entitlement
             (entitlement_id,subscription_id,tenant_id,user_id,skill_id,plan_id,status,expires_at)
           VALUES($1,$2,$3,$4,$5,$6,'active',$7)`,
          [`csent-${randomUUID()}`, subscriptionId, order.tenant_id, order.user_id,
            skillId, order.plan_id, expiresAt],
        );
      }
      const payload = {
        order_id: order.order_id,
        user_id: order.user_id,
        tenant_id: order.tenant_id,
        order_type: order.type,
        method: "provider",
        amount_fen: Number(order.amount_fen),
        provider_reference: params.provider_reference,
      };
      await client.query(
        `INSERT INTO billing_outbox
           (outbox_id,event_type,aggregate_id,settlement_id,payload)
         VALUES($1,'billing.payment.settled',$2,$3,$4)`,
        [`bout-${randomUUID()}`, order.order_id, settlementId, payload],
      );
      await client.query(
        `INSERT INTO audit_log(audit_id,actor,action,detail)
         VALUES($1,'payment-provider','order.payment.settled',$2)`,
        [`aud-${randomUUID()}`, { order_id: order.order_id, settlement_id: settlementId }],
      );
      const result = await this.loadProviderSettlementResult(client, settlementResult.rows[0]!, false);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof BillingSettlementError) throw error;
      if ((error as { code?: string }).code === "23505") {
        throw new BillingSettlementError("IDEMPOTENCY_CONFLICT");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async settleOrderRefund(params: SettleOrderRefundParams): Promise<BillingSettlementResult> {
    if (!validProviderReference(params.provider_reference) ||
      !/^[\x21-\x7e]{1,128}$/u.test(params.idempotency_key) ||
      !/^v1:[a-f0-9]{64}$/u.test(params.request_hash)) {
      throw new BillingSettlementError("FULFILLMENT_INVALID", "provider refund identity is invalid", 422);
    }
    const refundedAt = params.refunded_at ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(refundedAt))) throw new BillingSettlementError("FULFILLMENT_INVALID");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const orderResult = await client.query<OrderRow>(
        `SELECT order_id, user_id, type, plan_id, tenant_id, period, amount_fen, status,
                pay_method, provider_payment_id, created_at, paid_at, refunded_at
           FROM billing_order WHERE order_id=$1 FOR UPDATE`,
        [params.order_id],
      );
      const order = orderResult.rows[0];
      if (!order) throw new BillingSettlementError("ORDER_NOT_FOUND");
      const replay = await this.findProviderSettlementReplay(
        client, "refund", params.order_id, params.idempotency_key, params.request_hash,
        params.provider_reference,
      );
      if (replay) {
        await client.query("COMMIT");
        return replay;
      }
      if (order.status !== "paid") throw new BillingSettlementError("ORDER_NOT_PAID");
      if (order.type !== "cloud_skill_plan" || order.pay_method !== "provider" || !order.provider_payment_id) {
        throw new BillingSettlementError("REFUND_REQUIRES_RECONCILIATION");
      }
      const subscriptionResult = await client.query<CloudSkillSubscriptionRow>(
        `SELECT * FROM cloud_skill_subscription WHERE source_order_id=$1 FOR UPDATE`,
        [order.order_id],
      );
      const subscription = subscriptionResult.rows[0];
      if (!subscription || subscription.user_id !== order.user_id || subscription.tenant_id !== order.tenant_id ||
        subscription.plan_id !== order.plan_id || subscription.status === "refunded") {
        throw new BillingSettlementError("REFUND_REQUIRES_RECONCILIATION");
      }

      const settlementId = `bst-${randomUUID()}`;
      const settlementResult = await client.query<BillingSettlementRow>(
        `INSERT INTO billing_settlement
           (settlement_id,order_id,operation,idempotency_key,request_hash,method,provider_reference,amount_fen)
         VALUES($1,$2,'refund',$3,$4,'provider',$5,$6) RETURNING *`,
        [settlementId, order.order_id, params.idempotency_key, params.request_hash,
          params.provider_reference, order.amount_fen],
      );
      await client.query(`UPDATE billing_order SET status='refunded', refunded_at=$2 WHERE order_id=$1`,
        [order.order_id, refundedAt]);
      await client.query(
        `UPDATE cloud_skill_subscription SET status='refunded', refunded_at=$2
          WHERE subscription_id=$1`,
        [subscription.subscription_id, refundedAt],
      );
      await client.query(
        `UPDATE cloud_skill_entitlement SET status='revoked' WHERE subscription_id=$1`,
        [subscription.subscription_id],
      );
      const payload = {
        order_id: order.order_id,
        user_id: order.user_id,
        tenant_id: order.tenant_id,
        order_type: order.type,
        amount_fen: Number(order.amount_fen),
        provider_reference: params.provider_reference,
        payment_reference: order.provider_payment_id,
      };
      await client.query(
        `INSERT INTO billing_outbox
           (outbox_id,event_type,aggregate_id,settlement_id,payload)
         VALUES($1,'billing.refund.settled',$2,$3,$4)`,
        [`bout-${randomUUID()}`, order.order_id, settlementId, payload],
      );
      await client.query(
        `INSERT INTO audit_log(audit_id,actor,action,detail)
         VALUES($1,$2,'order.refund.settled',$3)`,
        [`aud-${randomUUID()}`, params.actor,
          { order_id: order.order_id, settlement_id: settlementId }],
      );
      const result = await this.loadProviderSettlementResult(client, settlementResult.rows[0]!, false);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof BillingSettlementError) throw error;
      if ((error as { code?: string }).code === "23505") {
        throw new BillingSettlementError("IDEMPOTENCY_CONFLICT");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async listBillingOutbox(): Promise<BillingOutboxRecord[]> {
    const result = await this.pool.query<BillingOutboxRow>(
      `SELECT * FROM billing_outbox ORDER BY created_at, outbox_id`,
    );
    return result.rows.map(toBillingOutbox);
  }

  async claimBillingOutbox(params: BillingOutboxClaimParams = {}): Promise<BillingOutboxRecord[]> {
    const limit = normalizeBillingOutboxLimit(params.limit);
    const leaseMs = normalizeBillingOutboxLease(params.lease_ms);
    const now = parseBillingOutboxTime(params.now);
    if (limit === undefined || leaseMs === undefined || now === undefined) return [];
    const lockToken = `bol-${randomUUID()}`;
    const result = await this.pool.query<BillingOutboxRow>(
      `WITH claimable AS (
         SELECT outbox_id
           FROM billing_outbox
          WHERE published_at IS NULL
            AND dead_lettered_at IS NULL
            AND available_at <= $1
            AND (locked_until IS NULL OR locked_until <= $1)
          ORDER BY available_at, created_at, outbox_id
          FOR UPDATE SKIP LOCKED
          LIMIT $2
       )
       UPDATE billing_outbox AS outbox
          SET attempts = outbox.attempts + 1,
              locked_until = $1::timestamptz + ($3::bigint * interval '1 millisecond'),
              lock_token = $4,
              last_error = NULL
         FROM claimable
        WHERE outbox.outbox_id = claimable.outbox_id
       RETURNING outbox.*`,
      [now.toISOString(), limit, leaseMs, lockToken],
    );
    return result.rows.map(toBillingOutbox);
  }

  async completeBillingOutbox(outboxId: string, lockToken: string, publishedAt?: string): Promise<boolean> {
    const completedAt = parseBillingOutboxTime(publishedAt);
    if (!completedAt || !validBillingOutboxLockToken(lockToken)) return false;
    const result = await this.pool.query(
      `UPDATE billing_outbox
          SET published_at=$3, locked_until=NULL, lock_token=NULL, last_error=NULL
        WHERE outbox_id=$1 AND lock_token=$2 AND published_at IS NULL AND dead_lettered_at IS NULL
          AND locked_until > $3`,
      [outboxId, lockToken, completedAt.toISOString()],
    );
    return result.rowCount === 1;
  }

  async failBillingOutbox(params: BillingOutboxFailureParams): Promise<boolean> {
    const failedAt = parseBillingOutboxTime(params.failed_at);
    const retryAt = parseBillingOutboxTime(params.retry_at);
    const deadLetteredAt = params.dead_lettered_at === undefined
      ? undefined
      : parseBillingOutboxTime(params.dead_lettered_at);
    if (!failedAt || !retryAt || (params.dead_lettered_at !== undefined && !deadLetteredAt) ||
      !validBillingOutboxLockToken(params.lock_token) || !validBillingOutboxErrorCode(params.error_code)) return false;
    const result = await this.pool.query(
      `UPDATE billing_outbox
          SET available_at=$3, locked_until=NULL, lock_token=NULL, last_error=$4, dead_lettered_at=$5
        WHERE outbox_id=$1 AND lock_token=$2 AND published_at IS NULL AND dead_lettered_at IS NULL
          AND locked_until > $6`,
      [params.outbox_id, params.lock_token, retryAt.toISOString(), params.error_code,
        deadLetteredAt?.toISOString() ?? null, failedAt.toISOString()],
    );
    return result.rowCount === 1;
  }

  // Wallet and legacy Pack entitlements are absent from the baseline.
  async addWalletTransaction(params: {
    user_id: string;
    type: "recharge" | "purchase" | "refund" | "adjust";
    amount_fen: number;
    order_id?: string;
    remark?: string;
  }): Promise<WalletTransactionRecord> {
    void params;
    throw cleanLaunchUnsupported("wallet.adjust");
  }

  async listTransactions(userId?: string): Promise<WalletTransactionRecord[]> {
    void userId;
    throw cleanLaunchUnsupported("wallet.list");
  }

  async listAllEntitlements(): Promise<EntitlementRecord[]> {
    throw cleanLaunchUnsupported("entitlement.list");
  }

  // ===== Cloud Skill Billing (independent from Pack entitlement) =====

  async createCloudSkillPlan(params: {
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
  }): Promise<CloudSkillPlanRecord> {
    const values = {
      ...params,
      included_calls: params.included_calls ?? 1_000,
      requests_per_minute: params.requests_per_minute ?? 60,
      max_concurrency: params.max_concurrency ?? 2,
    };
    validateCloudSkillPlanFields(values);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO cloud_skill_plan
           (plan_id, name, description, price_monthly_fen, price_yearly_fen,
            included_calls, requests_per_minute, max_concurrency, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [params.plan_id, params.name, params.description ?? "", params.price_monthly_fen,
          params.price_yearly_fen, values.included_calls, values.requests_per_minute,
          values.max_concurrency, params.status ?? "listed"],
      );
      for (const skillId of params.skill_ids) {
        await client.query(
          `INSERT INTO cloud_skill_plan_skill (plan_id, skill_id) VALUES ($1, $2)`,
          [params.plan_id, skillId],
        );
      }
      await client.query("COMMIT");
      return (await this.getCloudSkillPlan(params.plan_id))!;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if ((error as { code?: string }).code === "23505") throw new Error("CLOUD_SKILL_PLAN_EXISTS");
      throw error;
    } finally {
      client.release();
    }
  }

  async getCloudSkillPlan(planId: string): Promise<CloudSkillPlanRecord | undefined> {
    const result = await this.pool.query<CloudSkillPlanRow>(
      `SELECT p.*, COALESCE(array_agg(ps.skill_id ORDER BY ps.skill_id)
         FILTER (WHERE ps.skill_id IS NOT NULL), ARRAY[]::TEXT[]) AS skill_ids
       FROM cloud_skill_plan p
       LEFT JOIN cloud_skill_plan_skill ps ON ps.plan_id = p.plan_id
       WHERE p.plan_id = $1
       GROUP BY p.plan_id`,
      [planId],
    );
    return result.rows[0] ? toCloudSkillPlan(result.rows[0]) : undefined;
  }

  async listCloudSkillPlans(status?: CloudSkillPlanStatus): Promise<CloudSkillPlanRecord[]> {
    const result = await this.pool.query<CloudSkillPlanRow>(
      `SELECT p.*, COALESCE(array_agg(ps.skill_id ORDER BY ps.skill_id)
         FILTER (WHERE ps.skill_id IS NOT NULL), ARRAY[]::TEXT[]) AS skill_ids
       FROM cloud_skill_plan p
       LEFT JOIN cloud_skill_plan_skill ps ON ps.plan_id = p.plan_id
       WHERE ($1::TEXT IS NULL OR p.status = $1)
       GROUP BY p.plan_id
       ORDER BY p.created_at, p.plan_id`,
      [status ?? null],
    );
    return result.rows.map(toCloudSkillPlan);
  }

  async updateCloudSkillPlan(
    planId: string,
    patch: Partial<Pick<CloudSkillPlanRecord,
      "name" | "description" | "skill_ids" | "price_monthly_fen" | "price_yearly_fen" |
      "included_calls" | "requests_per_minute" | "max_concurrency" | "status">>,
  ): Promise<CloudSkillPlanRecord | undefined> {
    const current = await this.getCloudSkillPlan(planId);
    if (!current) return undefined;
    const next = { ...current, ...patch, skill_ids: patch.skill_ids ? [...patch.skill_ids] : current.skill_ids };
    validateCloudSkillPlanFields(next);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE cloud_skill_plan SET name=$2, description=$3, price_monthly_fen=$4,
           price_yearly_fen=$5, included_calls=$6, requests_per_minute=$7,
           max_concurrency=$8, status=$9 WHERE plan_id=$1`,
        [planId, next.name, next.description, next.price_monthly_fen, next.price_yearly_fen,
          next.included_calls, next.requests_per_minute, next.max_concurrency, next.status],
      );
      if (patch.skill_ids !== undefined) {
        // Existing entitlements keep their referenced mappings; removing a Skill with
        // active history is rejected by the FK instead of silently broadening access.
        // Apply the set delta so a no-op/full-form update never deletes a mapping
        // that an active entitlement still references.
        const currentSkillIds = new Set(current.skill_ids);
        const nextSkillIds = new Set(next.skill_ids);
        for (const skillId of currentSkillIds) {
          if (!nextSkillIds.has(skillId)) {
            await client.query(
              `DELETE FROM cloud_skill_plan_skill WHERE plan_id=$1 AND skill_id=$2`,
              [planId, skillId],
            );
          }
        }
        for (const skillId of nextSkillIds) {
          if (!currentSkillIds.has(skillId)) {
            await client.query(
              `INSERT INTO cloud_skill_plan_skill(plan_id, skill_id) VALUES($1,$2)`,
              [planId, skillId],
            );
          }
        }
      }
      await client.query("COMMIT");
      return (await this.getCloudSkillPlan(planId))!;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async createCloudSkillSubscription(params: {
    user_id: string;
    tenant_id: string;
    plan_id: string;
    period: "monthly" | "yearly";
    starts_at: string;
    expires_at: string;
    source_order_id: string;
    status?: CloudSkillSubscriptionStatus;
  }): Promise<{ subscription: CloudSkillSubscriptionRecord; existed: boolean }> {
    if (!params.user_id || !params.tenant_id || params.starts_at >= params.expires_at) {
      throw new Error("INVALID_CLOUD_SKILL_SUBSCRIPTION");
    }
    const inserted = await this.pool.query<CloudSkillSubscriptionRow>(
      `INSERT INTO cloud_skill_subscription
         (subscription_id,user_id,tenant_id,plan_id,status,period,starts_at,expires_at,source_order_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (source_order_id) DO NOTHING RETURNING *`,
      [`csub-${randomUUID()}`, params.user_id, params.tenant_id, params.plan_id,
        params.status ?? "active", params.period, params.starts_at, params.expires_at, params.source_order_id],
    );
    if (inserted.rows[0]) return { subscription: toCloudSkillSubscription(inserted.rows[0]), existed: false };
    const existing = await this.getCloudSkillSubscriptionByOrder(params.source_order_id);
    if (!existing || existing.user_id !== params.user_id || existing.plan_id !== params.plan_id) {
      throw new Error("CLOUD_SKILL_ORDER_CONFLICT");
    }
    return { subscription: existing, existed: true };
  }

  async getCloudSkillSubscription(subscriptionId: string): Promise<CloudSkillSubscriptionRecord | undefined> {
    const result = await this.pool.query<CloudSkillSubscriptionRow>(
      `SELECT * FROM cloud_skill_subscription WHERE subscription_id=$1`, [subscriptionId],
    );
    return result.rows[0] ? toCloudSkillSubscription(result.rows[0]) : undefined;
  }

  async getCloudSkillSubscriptionByOrder(orderId: string): Promise<CloudSkillSubscriptionRecord | undefined> {
    const result = await this.pool.query<CloudSkillSubscriptionRow>(
      `SELECT * FROM cloud_skill_subscription WHERE source_order_id=$1`, [orderId],
    );
    return result.rows[0] ? toCloudSkillSubscription(result.rows[0]) : undefined;
  }

  async listCloudSkillSubscriptions(userId?: string): Promise<CloudSkillSubscriptionRecord[]> {
    const result = userId === undefined
      ? await this.pool.query<CloudSkillSubscriptionRow>(`SELECT * FROM cloud_skill_subscription ORDER BY created_at DESC`)
      : await this.pool.query<CloudSkillSubscriptionRow>(
          `SELECT * FROM cloud_skill_subscription WHERE user_id=$1 ORDER BY created_at DESC`, [userId],
        );
    return result.rows.map(toCloudSkillSubscription);
  }

  async updateCloudSkillSubscriptionStatus(
    subscriptionId: string,
    status: CloudSkillSubscriptionStatus,
    changedAt = new Date().toISOString(),
  ): Promise<CloudSkillSubscriptionRecord | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<CloudSkillSubscriptionRow>(
        `UPDATE cloud_skill_subscription SET status=$2,
           cancelled_at=CASE WHEN $2='cancelled' THEN $3 ELSE cancelled_at END,
           refunded_at=CASE WHEN $2='refunded' THEN $3 ELSE refunded_at END
         WHERE subscription_id=$1 RETURNING *`,
        [subscriptionId, status, changedAt],
      );
      if (result.rows[0] && status !== "active") {
        await client.query(
          `UPDATE cloud_skill_entitlement SET status='revoked'
           WHERE subscription_id=$1 AND status='active'`, [subscriptionId],
        );
      }
      await client.query("COMMIT");
      return result.rows[0] ? toCloudSkillSubscription(result.rows[0]) : undefined;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async grantCloudSkillEntitlement(params: {
    subscription_id: string;
    tenant_id?: string;
    user_id?: string;
    skill_id: string;
    plan_id: string;
    expires_at?: string;
  }): Promise<{ entitlement: CloudSkillEntitlementRecord; existed: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const subscriptionResult = await client.query<CloudSkillSubscriptionRow>(
        `SELECT * FROM cloud_skill_subscription WHERE subscription_id=$1 FOR UPDATE`, [params.subscription_id],
      );
      const subscription = subscriptionResult.rows[0];
      if (!subscription) throw new Error("CLOUD_SKILL_SUBSCRIPTION_NOT_FOUND");
      if (subscription.plan_id !== params.plan_id) throw new Error("CLOUD_SKILL_PLAN_MISMATCH");
      const tenantId = params.tenant_id ?? subscription.tenant_id;
      const userId = params.user_id ?? subscription.user_id;
      if (tenantId !== subscription.tenant_id || userId !== subscription.user_id) throw new Error("CLOUD_SKILL_SCOPE_MISMATCH");
      const membership = await client.query(
        `SELECT 1 FROM cloud_skill_plan_skill WHERE plan_id=$1 AND skill_id=$2`,
        [params.plan_id, params.skill_id],
      );
      if (membership.rowCount === 0) throw new Error("CLOUD_SKILL_SKILL_NOT_IN_PLAN");
      const existingResult = await client.query<CloudSkillEntitlementRow>(
        `SELECT * FROM cloud_skill_entitlement
         WHERE subscription_id=$1 AND skill_id=$2 AND plan_id=$3`,
        [subscription.subscription_id, params.skill_id, params.plan_id],
      );
      let row: CloudSkillEntitlementRow;
      let existed = false;
      if (existingResult.rows[0]) {
        existed = true;
        const updated = await client.query<CloudSkillEntitlementRow>(
          `UPDATE cloud_skill_entitlement SET expires_at=$2,
             status=CASE WHEN $3='active' THEN 'active' ELSE 'revoked' END
           WHERE entitlement_id=$1 RETURNING *`,
          [existingResult.rows[0].entitlement_id, params.expires_at ?? subscription.expires_at, subscription.status],
        );
        row = updated.rows[0]!;
      } else {
        const inserted = await client.query<CloudSkillEntitlementRow>(
          `INSERT INTO cloud_skill_entitlement
             (entitlement_id,subscription_id,tenant_id,user_id,skill_id,plan_id,status,expires_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [`csent-${randomUUID()}`, subscription.subscription_id, tenantId, userId, params.skill_id,
            params.plan_id, subscription.status === "active" ? "active" : "revoked",
            params.expires_at ?? subscription.expires_at],
        );
        row = inserted.rows[0]!;
      }
      await client.query("COMMIT");
      return { entitlement: toCloudSkillEntitlement(row), existed };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getCloudSkillEntitlement(entitlementId: string): Promise<CloudSkillEntitlementRecord | undefined> {
    const result = await this.pool.query<CloudSkillEntitlementRow>(
      `SELECT * FROM cloud_skill_entitlement WHERE entitlement_id=$1`, [entitlementId],
    );
    return result.rows[0] ? toCloudSkillEntitlement(result.rows[0]) : undefined;
  }

  async listCloudSkillEntitlements(query: CloudSkillEntitlementQuery = {}): Promise<CloudSkillEntitlementRecord[]> {
    const values = [
      cloudSkillQueryValue(query, "user_id", "userId") ?? null,
      cloudSkillQueryValue(query, "tenant_id", "tenantId") ?? null,
      cloudSkillQueryValue(query, "skill_id", "skillId") ?? null,
      cloudSkillQueryValue(query, "plan_id", "planId") ?? null,
    ];
    const result = await this.pool.query<CloudSkillEntitlementRow>(
      `SELECT * FROM cloud_skill_entitlement
       WHERE ($1::TEXT IS NULL OR user_id=$1) AND ($2::TEXT IS NULL OR tenant_id=$2)
         AND ($3::TEXT IS NULL OR skill_id=$3) AND ($4::TEXT IS NULL OR plan_id=$4)
       ORDER BY created_at DESC`, values,
    );
    return result.rows.map(toCloudSkillEntitlement);
  }

  async revokeCloudSkillEntitlement(entitlementId: string): Promise<CloudSkillEntitlementRecord | undefined> {
    const result = await this.pool.query<CloudSkillEntitlementRow>(
      `UPDATE cloud_skill_entitlement SET status='revoked' WHERE entitlement_id=$1 RETURNING *`,
      [entitlementId],
    );
    return result.rows[0] ? toCloudSkillEntitlement(result.rows[0]) : undefined;
  }

  async resolveCloudSkillAccess(query: CloudSkillAccessQuery): Promise<CloudSkillAccessGrant | undefined> {
    const userId = cloudSkillQueryValue(query, "user_id", "userId");
    const tenantId = cloudSkillQueryValue(query, "tenant_id", "tenantId");
    const skillId = cloudSkillQueryValue(query, "skill_id", "skillId");
    const allowed = query.allowed_plan_ids ?? query.allowedPlanIds;
    const now = query.now ?? new Date().toISOString();
    if (!userId || !tenantId || !skillId || (allowed !== undefined && allowed.length === 0)) return undefined;
    const result = await this.pool.query<CloudSkillEntitlementRow & { subscription_data: CloudSkillSubscriptionRow }>(
      `SELECT e.*, row_to_json(s) AS subscription_data
       FROM cloud_skill_entitlement e
       JOIN cloud_skill_subscription s
         ON s.subscription_id=e.subscription_id AND s.plan_id=e.plan_id
        AND s.tenant_id=e.tenant_id AND s.user_id=e.user_id
       JOIN cloud_skill_plan_skill ps ON ps.plan_id=e.plan_id AND ps.skill_id=e.skill_id
       WHERE e.user_id=$1 AND e.tenant_id=$2 AND e.skill_id=$3
         AND e.status='active' AND e.expires_at>$4
         AND s.status='active' AND s.starts_at<=$4 AND s.expires_at>$4
         AND ($5::TEXT[] IS NULL OR e.plan_id=ANY($5::TEXT[]))
       ORDER BY e.created_at DESC LIMIT 1`,
      [userId, tenantId, skillId, now, allowed === undefined ? null : [...allowed]],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const plan = await this.getCloudSkillPlan(row.plan_id);
    if (!plan) return undefined;
    return {
      ...toCloudSkillEntitlement(row),
      subscription: toCloudSkillSubscription(row.subscription_data),
      plan,
    };
  }

  async hasCloudSkillAccess(query: CloudSkillAccessQuery): Promise<boolean> {
    return (await this.resolveCloudSkillAccess(query)) !== undefined;
  }

  async upsertCloudAgentSkillBinding(
    params: CloudAgentSkillBindingUpsertRequest,
  ): Promise<{ binding: CloudAgentSkillBindingRecord; existed: boolean }> {
    const result = await this.pool.query<CloudAgentSkillBindingRow & { inserted: boolean }>(
      `INSERT INTO cloud_agent_skill_binding
         (binding_id, tenant_id, device_id, user_id, agent_id, skill_id, status, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', NULL)
       ON CONFLICT (tenant_id, device_id, agent_id, skill_id) DO UPDATE SET
         user_id = COALESCE(EXCLUDED.user_id, cloud_agent_skill_binding.user_id),
         status = 'active',
         revoked_at = NULL
       RETURNING *, (xmax = 0) AS inserted`,
      [
        `casb-${randomUUID()}`,
        params.tenant_id,
        params.device_id,
        params.user_id ?? null,
        params.agent_id,
        params.skill_id,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("CLOUD_AGENT_SKILL_BINDING_UPSERT_FAILED");
    return { binding: toCloudAgentSkillBinding(row), existed: !row.inserted };
  }

  async resolveCloudAgentSkillBinding(
    query: CloudAgentSkillBindingResolveQuery,
  ): Promise<CloudAgentSkillBindingRecord | undefined> {
    const result = await this.pool.query<CloudAgentSkillBindingRow>(
      `SELECT * FROM cloud_agent_skill_binding
       WHERE tenant_id = $1 AND device_id = $2 AND agent_id = $3 AND skill_id = $4
         AND status = 'active'
         AND ($5::TEXT IS NULL OR user_id = $5)
       LIMIT 1`,
      [query.tenant_id, query.device_id, query.agent_id, query.skill_id, query.user_id ?? null],
    );
    return result.rows[0] ? toCloudAgentSkillBinding(result.rows[0]) : undefined;
  }

  async revokeCloudAgentSkillBinding(bindingId: string): Promise<CloudAgentSkillBindingRecord | undefined> {
    const result = await this.pool.query<CloudAgentSkillBindingRow>(
      `UPDATE cloud_agent_skill_binding
       SET status = 'revoked', revoked_at = COALESCE(revoked_at, now())
       WHERE binding_id = $1
       RETURNING *`,
      [bindingId],
    );
    return result.rows[0] ? toCloudAgentSkillBinding(result.rows[0]) : undefined;
  }

  async listCloudAgentSkillBindings(
    query: CloudAgentSkillBindingListQuery = {},
  ): Promise<CloudAgentSkillBindingRecord[]> {
    const result = await this.pool.query<CloudAgentSkillBindingRow>(
      `SELECT * FROM cloud_agent_skill_binding
       WHERE ($1::TEXT IS NULL OR tenant_id = $1)
         AND ($2::TEXT IS NULL OR device_id = $2)
         AND ($3::TEXT IS NULL OR user_id = $3)
         AND ($4::TEXT IS NULL OR agent_id = $4)
         AND ($5::TEXT IS NULL OR skill_id = $5)
         AND ($6::TEXT IS NULL OR status = $6)
       ORDER BY created_at DESC, binding_id`,
      [
        query.tenant_id ?? null,
        query.device_id ?? null,
        query.user_id ?? null,
        query.agent_id ?? null,
        query.skill_id ?? null,
        query.status ?? null,
      ],
    );
    return result.rows.map(toCloudAgentSkillBinding);
  }

  /**
   * Atomically admit one Cloud Skill task.  The subscription row is locked for
   * the whole count-and-insert transaction, so two API replicas cannot both
   * pass the same plan limits. Cycle usage is subscription+Skill; rate and
   * concurrency are subscription+tenant+user+device (Agents share a device
   * bucket). Reservation rows are the usage ledger; only `released_at` changes
   * on release and usage is never refunded.
   */
  async reserveCloudSkillExecution(
    params: CloudSkillExecutionReservationRequest,
  ): Promise<CloudSkillExecutionReservationResult> {
    const required = [
      params.task_id,
      params.user_id,
      params.tenant_id,
      params.device_id,
      params.agent_id,
      params.skill_id,
      params.plan_id,
    ];
    if (required.some((value) => typeof value !== "string" || value.length === 0 || value.length > 256)) {
      return { ok: false, reason: "INVALID_REQUEST" };
    }
    if (params.subscription_id !== undefined &&
      (typeof params.subscription_id !== "string" || params.subscription_id.length === 0 || params.subscription_id.length > 256)) {
      return { ok: false, reason: "INVALID_REQUEST" };
    }
    if (params.input_digest !== undefined &&
      (typeof params.input_digest !== "string" || params.input_digest.length === 0 || params.input_digest.length > 512)) {
      return { ok: false, reason: "INVALID_REQUEST" };
    }
    const now = parseExecutionNow(params.now);
    const leaseTtlMs = normalizeLeaseTtl(params.lease_ttl_ms);
    if (!now || leaseTtlMs === undefined) return { ok: false, reason: "INVALID_REQUEST" };
    const nowIso = now.toISOString();
    const nowMs = now.getTime();
    let client: pg.PoolClient | undefined;
    let inTransaction = false;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      inTransaction = true;

      // The unique task_id is checked before entitlement/quota work.  This is
      // what makes network retries return the original admission lease rather
      // than consuming another included call.
      const existingResult = await client.query<CloudSkillExecutionReservationRow>(
        `SELECT * FROM cloud_skill_execution_reservation WHERE task_id=$1 FOR UPDATE`,
        [params.task_id],
      );
      let existing = existingResult.rows[0];
      if (existing) {
        // A retry after a process crash must not leave an expired lease
        // consuming concurrency. Keep the same reservation/idempotency row,
        // but persist the fail-safe release before returning it.
        if (existing.released_at === null && new Date(existing.lease_expires_at).getTime() <= nowMs) {
          const expired = await client.query<CloudSkillExecutionReservationRow>(
            `UPDATE cloud_skill_execution_reservation
                SET released_at=COALESCE(released_at,$2)
              WHERE reservation_id=$1
              RETURNING *`,
            [existing.reservation_id, nowIso],
          );
          existing = expired.rows[0] ?? existing;
        }
        const sameBinding = existing.user_id === params.user_id &&
          existing.tenant_id === params.tenant_id &&
          existing.device_id === params.device_id &&
          existing.agent_id === params.agent_id &&
          existing.skill_id === params.skill_id &&
          existing.plan_id === params.plan_id &&
          (params.subscription_id === undefined || existing.subscription_id === params.subscription_id) &&
          (existing.input_digest ?? undefined) === params.input_digest;
        await client.query("COMMIT");
        inTransaction = false;
        return sameBinding
          ? { ok: true, reservation: toCloudSkillExecutionReservation(existing) }
          : { ok: false, reason: "IDEMPOTENCY_CONFLICT" };
      }

      const planResult = await client.query<CloudSkillPlanRow>(
        `SELECT p.plan_id, p.name, p.description,
                COALESCE(array_agg(ps.skill_id) FILTER (WHERE ps.skill_id IS NOT NULL), '{}') AS skill_ids,
                p.price_monthly_fen, p.price_yearly_fen, p.included_calls,
                p.requests_per_minute, p.max_concurrency, p.status, p.created_at
           FROM cloud_skill_plan p
           LEFT JOIN cloud_skill_plan_skill ps ON ps.plan_id=p.plan_id
          WHERE p.plan_id=$1
          GROUP BY p.plan_id`,
        [params.plan_id],
      );
      const plan = planResult.rows[0];
      if (!plan) {
        await client.query("ROLLBACK");
        inTransaction = false;
        return { ok: false, reason: "PLAN_MISMATCH" };
      }

      // Lock the selected subscription.  A caller may omit subscription_id;
      // in that case choose the same newest matching grant as access queries.
      const subscriptionResult = await client.query<CloudSkillSubscriptionRow>(
        `SELECT * FROM cloud_skill_subscription
          WHERE plan_id=$1 AND user_id=$2 AND tenant_id=$3
            AND ($4::TEXT IS NULL OR subscription_id=$4)
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE`,
        [params.plan_id, params.user_id, params.tenant_id, params.subscription_id ?? null],
      );
      const subscription = subscriptionResult.rows[0];
      if (!subscription) {
        await client.query("ROLLBACK");
        inTransaction = false;
        return { ok: false, reason: "PLAN_MISMATCH" };
      }
      const subscriptionStartsMs = new Date(subscription.starts_at).getTime();
      const subscriptionExpiresMs = new Date(subscription.expires_at).getTime();
      if (subscription.status !== "active" || !Number.isFinite(subscriptionStartsMs) ||
        !Number.isFinite(subscriptionExpiresMs) || nowMs < subscriptionStartsMs || nowMs >= subscriptionExpiresMs) {
        await client.query("ROLLBACK");
        inTransaction = false;
        return { ok: false, reason: "SUBSCRIPTION_INACTIVE" };
      }
      if (plan.plan_id !== subscription.plan_id) {
        await client.query("ROLLBACK");
        inTransaction = false;
        return { ok: false, reason: "PLAN_MISMATCH" };
      }
      const entitlementResult = await client.query<CloudSkillEntitlementRow>(
        `SELECT e.*
           FROM cloud_skill_entitlement e
           JOIN cloud_skill_plan_skill ps ON ps.plan_id=e.plan_id AND ps.skill_id=e.skill_id
          WHERE e.subscription_id=$1 AND e.tenant_id=$2 AND e.user_id=$3
            AND e.skill_id=$4 AND e.plan_id=$5
            AND e.status='active' AND e.expires_at>$6
          ORDER BY e.created_at DESC
          LIMIT 1
          FOR UPDATE`,
        [subscription.subscription_id, params.tenant_id, params.user_id, params.skill_id, params.plan_id, nowIso],
      );
      if (!entitlementResult.rows[0]) {
        await client.query("ROLLBACK");
        inTransaction = false;
        return { ok: false, reason: "SKILL_NOT_ENTITLED" };
      }

      // Expired leases are fail-safe: release their concurrency before the
      // count, while leaving their rows in the usage ledger.
      await client.query(
        `UPDATE cloud_skill_execution_reservation
            SET released_at=COALESCE(released_at,$2)
          WHERE subscription_id=$1 AND released_at IS NULL AND lease_expires_at <= $2`,
        [subscription.subscription_id, nowIso],
      );

      const cycleUsage = await client.query<{ count: string | number }>(
        `SELECT COUNT(*)::BIGINT AS count
           FROM cloud_skill_execution_reservation
          WHERE subscription_id=$1 AND skill_id=$2 AND reserved_at >= $3 AND reserved_at <= $4`,
        [subscription.subscription_id, params.skill_id, new Date(subscriptionStartsMs).toISOString(), nowIso],
      );
      if (Number(cycleUsage.rows[0]?.count ?? 0) >= Number(plan.included_calls)) {
        await client.query("ROLLBACK");
        inTransaction = false;
        return { ok: false, reason: "QUOTA_EXCEEDED" };
      }

      const minuteStartIso = new Date(Math.floor(nowMs / 60_000) * 60_000).toISOString();
      const minuteUsage = await client.query<{ count: string | number }>(
        `SELECT COUNT(*)::BIGINT AS count
           FROM cloud_skill_execution_reservation
          WHERE subscription_id=$1 AND tenant_id=$2 AND user_id=$3 AND device_id=$4
            AND reserved_at >= $5 AND reserved_at <= $6`,
        [subscription.subscription_id, params.tenant_id, params.user_id, params.device_id, minuteStartIso, nowIso],
      );
      if (Number(minuteUsage.rows[0]?.count ?? 0) >= Number(plan.requests_per_minute)) {
        await client.query("ROLLBACK");
        inTransaction = false;
        return {
          ok: false,
          reason: "RATE_LIMITED",
          retry_after_seconds: Math.max(1, Math.ceil((new Date(minuteStartIso).getTime() + 60_000 - nowMs) / 1000)),
        };
      }

      const activeUsage = await client.query<{ count: string | number; next_expiry: string | Date | null }>(
        `SELECT COUNT(*)::BIGINT AS count, MIN(lease_expires_at) AS next_expiry
           FROM cloud_skill_execution_reservation
          WHERE subscription_id=$1 AND tenant_id=$2 AND user_id=$3 AND device_id=$4
            AND released_at IS NULL AND lease_expires_at > $5`,
        [subscription.subscription_id, params.tenant_id, params.user_id, params.device_id, nowIso],
      );
      if (Number(activeUsage.rows[0]?.count ?? 0) >= Number(plan.max_concurrency)) {
        const nextExpiryMs = activeUsage.rows[0]?.next_expiry
          ? new Date(activeUsage.rows[0]!.next_expiry!).getTime()
          : Number.NaN;
        await client.query("ROLLBACK");
        inTransaction = false;
        return {
          ok: false,
          reason: "CONCURRENCY_LIMIT",
          retry_after_seconds: retryAfterSeconds(nextExpiryMs, nowMs),
        };
      }

      const reservationId = `csres-${randomUUID()}`;
      const inserted = await client.query<CloudSkillExecutionReservationRow>(
        `INSERT INTO cloud_skill_execution_reservation
          (reservation_id, task_id, user_id, tenant_id, device_id, agent_id,
           skill_id, plan_id, subscription_id, input_digest, period_start,
           reserved_at, lease_expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [
          reservationId,
          params.task_id,
          params.user_id,
          params.tenant_id,
          params.device_id,
          params.agent_id,
          params.skill_id,
          params.plan_id,
          subscription.subscription_id,
          params.input_digest ?? null,
          new Date(subscriptionStartsMs).toISOString(),
          nowIso,
          new Date(nowMs + leaseTtlMs).toISOString(),
        ],
      );
      await client.query("COMMIT");
      inTransaction = false;
      return { ok: true, reservation: toCloudSkillExecutionReservation(inserted.rows[0]!) };
    } catch (error) {
      if (inTransaction && client) await client.query("ROLLBACK").catch(() => undefined);
      // A concurrent replica may have won the task_id unique race.  Return its
      // original lease when the binding agrees; this preserves idempotency.
      if ((error as { code?: string }).code === "23505") {
        try {
          const existing = client
            ? await client.query<CloudSkillExecutionReservationRow>(
                `SELECT * FROM cloud_skill_execution_reservation WHERE task_id=$1`, [params.task_id],
              )
            : await this.pool.query<CloudSkillExecutionReservationRow>(
                `SELECT * FROM cloud_skill_execution_reservation WHERE task_id=$1`, [params.task_id],
              );
          const row = existing.rows[0];
          if (row) {
            const sameBinding = row.user_id === params.user_id && row.tenant_id === params.tenant_id &&
              row.device_id === params.device_id && row.agent_id === params.agent_id &&
              row.skill_id === params.skill_id && row.plan_id === params.plan_id &&
              (params.subscription_id === undefined || row.subscription_id === params.subscription_id) &&
              (row.input_digest ?? undefined) === params.input_digest;
            return sameBinding
              ? { ok: true, reservation: toCloudSkillExecutionReservation(row) }
              : { ok: false, reason: "IDEMPOTENCY_CONFLICT" };
          }
        } catch {
          // Fall through to the stable unavailable result below.
        }
      }
      return { ok: false, reason: "STORAGE_UNAVAILABLE" };
    } finally {
      client?.release();
    }
  }

  async releaseCloudSkillExecution(
    params: CloudSkillExecutionReleaseRequest,
  ): Promise<CloudSkillExecutionReleaseResult> {
    const now = parseExecutionNow(params.now);
    if (!now || (!params.reservation_id && !params.task_id)) return { released: false };
    const nowIso = now.toISOString();
    let client: pg.PoolClient | undefined;
    let inTransaction = false;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      inTransaction = true;
      const result = params.reservation_id
        ? await client.query<CloudSkillExecutionReservationRow>(
            `SELECT * FROM cloud_skill_execution_reservation WHERE reservation_id=$1 FOR UPDATE`,
            [params.reservation_id],
          )
        : await client.query<CloudSkillExecutionReservationRow>(
            `SELECT * FROM cloud_skill_execution_reservation WHERE task_id=$1 FOR UPDATE`,
            [params.task_id],
          );
      const row = result.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        inTransaction = false;
        return { released: false };
      }
      if ((params.task_id !== undefined && row.task_id !== params.task_id) ||
        (params.user_id !== undefined && row.user_id !== params.user_id) ||
        (params.tenant_id !== undefined && row.tenant_id !== params.tenant_id)) {
        await client.query("ROLLBACK");
        inTransaction = false;
        return { released: false };
      }
      const alreadyReleased = row.released_at !== null;
      if (alreadyReleased) {
        await client.query("COMMIT");
        inTransaction = false;
        return { released: false, reservation: toCloudSkillExecutionReservation(row) };
      }
      const leaseExpired = new Date(row.lease_expires_at).getTime() <= now.getTime();
      const updated = await client.query<CloudSkillExecutionReservationRow>(
        `UPDATE cloud_skill_execution_reservation
            SET released_at=COALESCE(released_at,$2)
          WHERE reservation_id=$1
          RETURNING *`,
        [row.reservation_id, nowIso],
      );
      await client.query("COMMIT");
      inTransaction = false;
      return {
        released: !leaseExpired,
        reservation: toCloudSkillExecutionReservation(updated.rows[0]!),
      };
    } catch {
      if (inTransaction && client) await client.query("ROLLBACK").catch(() => undefined);
      return { released: false };
    } finally {
      client?.release();
    }
  }

  async getCloudSkillOperationalSummary(nowValue?: string): Promise<CloudSkillOperationalSummary> {
    const now = parseExecutionNow(nowValue);
    if (!now) throw new Error("INVALID_CLOUD_SKILL_OPERATIONAL_TIME");
    type Row = {
      plan_id: string;
      skill_id: string;
      calls: string | number;
      active_concurrency: string | number;
      succeeded: string | number;
      failed: string | number;
      cancelled: string | number;
      active_subscriptions: string | number;
      included_calls_per_subscription: string | number;
    };
    const result = await this.pool.query<Row>(
      `WITH active_subscriptions AS (
         SELECT plan_id, COUNT(*)::BIGINT AS count
           FROM cloud_skill_subscription
          WHERE status='active' AND starts_at <= $1 AND expires_at > $1
          GROUP BY plan_id
       )
       SELECT ps.plan_id,
              ps.skill_id,
              COUNT(r.reservation_id) FILTER (
                WHERE r.reserved_at >= $1::timestamptz - interval '24 hours' AND r.reserved_at <= $1
              )::BIGINT AS calls,
              COUNT(r.reservation_id) FILTER (
                WHERE r.released_at IS NULL AND r.lease_expires_at > $1
              )::BIGINT AS active_concurrency,
              COUNT(r.reservation_id) FILTER (
                WHERE r.reserved_at >= $1::timestamptz - interval '24 hours' AND r.reserved_at <= $1
                  AND task.status='succeeded'
              )::BIGINT AS succeeded,
              COUNT(r.reservation_id) FILTER (
                WHERE r.reserved_at >= $1::timestamptz - interval '24 hours' AND r.reserved_at <= $1
                  AND task.status IN ('failed','timed_out')
              )::BIGINT AS failed,
              COUNT(r.reservation_id) FILTER (
                WHERE r.reserved_at >= $1::timestamptz - interval '24 hours' AND r.reserved_at <= $1
                  AND task.status='cancelled'
              )::BIGINT AS cancelled,
              COALESCE(active.count, 0)::BIGINT AS active_subscriptions,
              plan.included_calls::BIGINT AS included_calls_per_subscription
         FROM cloud_skill_plan_skill ps
         JOIN cloud_skill_plan plan ON plan.plan_id=ps.plan_id
         LEFT JOIN active_subscriptions active ON active.plan_id=ps.plan_id
         LEFT JOIN cloud_skill_execution_reservation r
           ON r.plan_id=ps.plan_id AND r.skill_id=ps.skill_id
         LEFT JOIN cloud_task task ON task.task_id=r.task_id
        GROUP BY ps.plan_id, ps.skill_id, active.count, plan.included_calls
        ORDER BY ps.plan_id, ps.skill_id`,
      [now.toISOString()],
    );
    return {
      window_hours: 24,
      generated_at: now.toISOString(),
      skills: result.rows.map((row) => ({
        plan_id: row.plan_id,
        skill_id: row.skill_id,
        calls: Number(row.calls),
        active_concurrency: Number(row.active_concurrency),
        succeeded: Number(row.succeeded),
        failed: Number(row.failed),
        cancelled: Number(row.cancelled),
        active_subscriptions: Number(row.active_subscriptions),
        included_calls_per_subscription: Number(row.included_calls_per_subscription),
      })),
    };
  }

  /** Legacy Pack/entitlement/release APIs are intentionally unavailable in clean launch. */
  async grantEntitlement(params: {
    tenant_id: string;
    device_id: string;
    pack_id: string;
    scope?: "tenant" | "user" | "device";
    expires_at?: string;
    source_order_id?: string;
  }): Promise<EntitlementRecord> {
    void params;
    throw cleanLaunchUnsupported("entitlement.grant");
  }

  async revokeEntitlement(entitlementId: string): Promise<EntitlementRecord | undefined> {
    void entitlementId;
    throw cleanLaunchUnsupported("entitlement.revoke");
  }

  async listEntitlements(deviceId: string): Promise<EntitlementRecord[]> {
    void deviceId;
    throw cleanLaunchUnsupported("entitlement.list");
  }

  async publishRelease(params: {
    pack: PackFile;
    digest: string;
    signature_key_id: string;
  }): Promise<{ release: PackReleaseRecord; existed: boolean }> {
    void params;
    throw cleanLaunchUnsupported("pack_release.publish");
  }

  async getRelease(packId: string, version: string): Promise<PackReleaseRecord | undefined> {
    void packId;
    void version;
    throw cleanLaunchUnsupported("pack_release.get");
  }

  async listReleases(packId?: string): Promise<PackReleaseRecord[]> {
    void packId;
    throw cleanLaunchUnsupported("pack_release.list");
  }

  async revokeRelease(packId: string, version: string): Promise<PackReleaseRecord | undefined> {
    void packId;
    void version;
    throw cleanLaunchUnsupported("pack_release.revoke");
  }

  async publishSkillRelease(params: {
    package: SkillPackage;
    digest: string;
    signature_key_id: string;
  }): Promise<{ release: SkillReleaseRecord; existed: boolean }> {
    void params;
    throw cleanLaunchUnsupported("skill_release.publish");
  }

  async getSkillRelease(skillId: string, version: string): Promise<SkillReleaseRecord | undefined> {
    void skillId;
    void version;
    throw cleanLaunchUnsupported("skill_release.get");
  }

  async listSkillReleases(skillId?: string): Promise<SkillReleaseRecord[]> {
    void skillId;
    throw cleanLaunchUnsupported("skill_release.list");
  }

  async revokeSkillRelease(skillId: string, version: string): Promise<SkillReleaseRecord | undefined> {
    void skillId;
    void version;
    throw cleanLaunchUnsupported("skill_release.revoke");
  }

  async publishCloudSkillAdapterRelease(params: {
    manifest: CloudSkillAdapterManifest;
    files: Record<string, string>;
    digest: string;
    signature_key_id: string;
  }): Promise<{ release: CloudSkillAdapterReleaseRecord; existed: boolean }> {
    const inserted = await this.pool.query<CloudSkillAdapterReleaseRow>(
      `INSERT INTO cloud_skill_adapter_release (
        skill_id, version, manifest_data, files_data, digest, signature_key_id,
        min_manager_version, openclaw_version
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (skill_id, version) DO NOTHING
       RETURNING *`,
      [
        params.manifest.skill_id,
        params.manifest.version,
        JSON.stringify(params.manifest),
        JSON.stringify(params.files),
        params.digest,
        params.signature_key_id,
        params.manifest.compatibility.manager_min_version,
        params.manifest.compatibility.openclaw_version,
      ],
    );
    if (inserted.rowCount === 0) {
      const existing = await this.pool.query<CloudSkillAdapterReleaseRow>(
        `SELECT * FROM cloud_skill_adapter_release WHERE skill_id = $1 AND version = $2`,
        [params.manifest.skill_id, params.manifest.version],
      );
      return { release: toCloudSkillAdapterRelease(existing.rows[0]!), existed: true };
    }
    return { release: toCloudSkillAdapterRelease(inserted.rows[0]!), existed: false };
  }

  async getCloudSkillAdapterRelease(skillId: string, version: string): Promise<CloudSkillAdapterReleaseRecord | undefined> {
    const result = await this.pool.query<CloudSkillAdapterReleaseRow>(
      `SELECT * FROM cloud_skill_adapter_release WHERE skill_id = $1 AND version = $2`,
      [skillId, version],
    );
    return result.rows[0] ? toCloudSkillAdapterRelease(result.rows[0]) : undefined;
  }

  async listCloudSkillAdapterReleases(skillId?: string): Promise<CloudSkillAdapterReleaseRecord[]> {
    const result = skillId === undefined
      ? await this.pool.query<CloudSkillAdapterReleaseRow>(
          `SELECT * FROM cloud_skill_adapter_release ORDER BY created_at, skill_id, version`,
        )
      : await this.pool.query<CloudSkillAdapterReleaseRow>(
          `SELECT * FROM cloud_skill_adapter_release WHERE skill_id = $1 ORDER BY created_at, version`,
          [skillId],
        );
    return result.rows.map(toCloudSkillAdapterRelease);
  }

  async revokeCloudSkillAdapterRelease(skillId: string, version: string): Promise<CloudSkillAdapterReleaseRecord | undefined> {
    const result = await this.pool.query<CloudSkillAdapterReleaseRow>(
      `UPDATE cloud_skill_adapter_release SET status = 'revoked', revoked_at = now()
       WHERE skill_id = $1 AND version = $2 AND status = 'active' RETURNING *`,
      [skillId, version],
    );
    return result.rows[0] ? toCloudSkillAdapterRelease(result.rows[0]) : undefined;
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
    // The five client-facing UI fields were retired with the legacy product.
    // Ignore them even when an old in-process caller still supplies them.
    const res = await this.pool.query<ModelConfigRow>(
      `INSERT INTO model_gateway_config
         (config_id, scope_type, scope_id, enabled, emergency_disabled, base_url, model_id, display_name, api_type,
          context_window, max_tokens, input_capabilities, encrypted_api_key, fallback_config_id, request_timeout_ms,
          max_retries, circuit_breaker_threshold, circuit_breaker_cooldown_ms, min_manager_version, max_manager_version,
          device_requests_per_minute, device_daily_tokens, tenant_monthly_tokens, max_device_concurrency,
          input_cost_microunits_per_million, output_cost_microunits_per_million, cache_cost_microunits_per_million, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
       ON CONFLICT (config_id) DO UPDATE SET
         scope_type=EXCLUDED.scope_type, scope_id=EXCLUDED.scope_id, enabled=EXCLUDED.enabled,
         emergency_disabled=EXCLUDED.emergency_disabled, base_url=EXCLUDED.base_url, model_id=EXCLUDED.model_id,
         display_name=EXCLUDED.display_name, api_type=EXCLUDED.api_type, context_window=EXCLUDED.context_window,
         max_tokens=EXCLUDED.max_tokens, input_capabilities=EXCLUDED.input_capabilities,
         encrypted_api_key=EXCLUDED.encrypted_api_key, fallback_config_id=EXCLUDED.fallback_config_id,
         request_timeout_ms=EXCLUDED.request_timeout_ms, max_retries=EXCLUDED.max_retries,
         circuit_breaker_threshold=EXCLUDED.circuit_breaker_threshold,
         circuit_breaker_cooldown_ms=EXCLUDED.circuit_breaker_cooldown_ms,
         min_manager_version=EXCLUDED.min_manager_version, max_manager_version=EXCLUDED.max_manager_version,
         device_requests_per_minute=EXCLUDED.device_requests_per_minute, device_daily_tokens=EXCLUDED.device_daily_tokens,
         tenant_monthly_tokens=EXCLUDED.tenant_monthly_tokens, max_device_concurrency=EXCLUDED.max_device_concurrency,
         input_cost_microunits_per_million=EXCLUDED.input_cost_microunits_per_million,
         output_cost_microunits_per_million=EXCLUDED.output_cost_microunits_per_million,
         cache_cost_microunits_per_million=EXCLUDED.cache_cost_microunits_per_million,
         updated_at=EXCLUDED.updated_at
       RETURNING *`,
      [
        config.config_id, config.scope_type, config.scope_id, config.enabled, config.emergency_disabled,
        config.base_url, config.model_id, config.display_name, config.api_type, config.context_window,
        config.max_tokens, JSON.stringify(config.input_capabilities), config.encrypted_api_key ?? null,
        config.fallback_config_id ?? null, config.request_timeout_ms, config.max_retries,
        config.circuit_breaker_threshold, config.circuit_breaker_cooldown_ms, config.min_manager_version,
        config.max_manager_version ?? null, config.device_requests_per_minute, config.device_daily_tokens,
        config.tenant_monthly_tokens, config.max_device_concurrency, config.input_cost_microunits_per_million,
        config.output_cost_microunits_per_million, config.cache_cost_microunits_per_million, config.updated_at,
      ],
    );
    return toModelConfig(res.rows[0]!);
  }

  async listFeaturePolicies(): Promise<FeaturePolicyRecord[]> {
    const result = await this.pool.query<FeaturePolicyRow>(
      `SELECT policy_id, policy, revision, updated_at
       FROM feature_policy
       ORDER BY feature_id, audience, scope, scope_id`,
    );
    return result.rows.map(toFeaturePolicy);
  }

  async upsertFeaturePolicy(policy: FeaturePolicyEntry): Promise<FeaturePolicyRecord> {
    const client = await this.pool.connect();
    const scopeId = policy.scope_id ?? "-";
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        ["longhub-feature-policy-capacity"],
      );
      const existing = await client.query(
        `SELECT 1 FROM feature_policy
         WHERE feature_id = $1 AND audience = $2 AND scope = $3 AND scope_id = $4`,
        [policy.feature_id, policy.audience, policy.scope, scopeId],
      );
      if (existing.rowCount === 0) {
        const count = await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM feature_policy",
        );
        if (count.rows[0]!.count >= FEATURE_POLICY_MAX_FEATURES) {
          throw new FeaturePolicyCapacityError();
        }
      }
      const result = await client.query<FeaturePolicyRow>(
        `INSERT INTO feature_policy
           (policy_id, feature_id, audience, scope, scope_id, policy, revision, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, nextval('feature_policy_revision_seq'), now())
         ON CONFLICT (feature_id, audience, scope, scope_id) DO UPDATE SET
           policy = EXCLUDED.policy,
           revision = nextval('feature_policy_revision_seq'),
           updated_at = now()
         RETURNING policy_id, policy, revision, updated_at`,
        [
          "fp-" + randomUUID(),
          policy.feature_id,
          policy.audience,
          policy.scope,
          scopeId,
          JSON.stringify(policy),
        ],
      );
      await client.query("COMMIT");
      return toFeaturePolicy(result.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async incrementClientTelemetry(records: readonly ClientTelemetryAggregateRecord[]): Promise<void> {
    if (records.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const record of records) {
        await client.query(
          `INSERT INTO client_telemetry_hourly
             (bucket_start, event_type, manager_version, openclaw_version, platform,
              architecture, value, agent_count_bucket, count)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (bucket_start, event_type, manager_version, openclaw_version,
                        platform, architecture, value, agent_count_bucket)
           DO UPDATE SET count = client_telemetry_hourly.count + EXCLUDED.count`,
          [
            record.bucket_start, record.event_type, record.manager_version, record.openclaw_version,
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
      manager_version: string;
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

  async incrementHttpRouteMetrics(records: readonly HttpRouteMetricRecord[]): Promise<void> {
    if (records.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const record of records) {
        await client.query(
          `INSERT INTO http_route_hourly (bucket_start, route_id, status_class, latency_bucket, count)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (bucket_start, route_id, status_class, latency_bucket)
           DO UPDATE SET count = http_route_hourly.count + EXCLUDED.count`,
          [record.bucket_start, record.route_id, record.status_class, record.latency_bucket, record.count],
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

  async listHttpRouteMetrics(): Promise<HttpRouteMetricRecord[]> {
    const result = await this.pool.query<{
      bucket_start: string;
      route_id: HttpRouteMetricRecord["route_id"];
      status_class: HttpRouteMetricRecord["status_class"];
      latency_bucket: HttpRouteMetricRecord["latency_bucket"];
      count: string | number;
    }>(`SELECT * FROM http_route_hourly ORDER BY bucket_start, route_id`);
    return result.rows.map((row) => ({
      ...row,
      bucket_start: new Date(row.bucket_start).toISOString(),
      count: Number(row.count),
    }));
  }

  async recordFeaturePolicyEmergencyObservation(
    record: FeaturePolicyEmergencyObservationRecord,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO feature_policy_emergency_observation
         (policy_id, revision, feature_id, policy_updated_at, first_enforced_at, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (policy_id, revision) DO NOTHING`,
      [
        record.policy_id,
        record.revision,
        record.feature_id,
        record.policy_updated_at,
        record.first_enforced_at,
        record.latency_ms,
      ],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async listFeaturePolicyEmergencyObservations(): Promise<FeaturePolicyEmergencyObservationRecord[]> {
    const result = await this.pool.query<{
      policy_id: string;
      revision: string | number;
      feature_id: string;
      policy_updated_at: string;
      first_enforced_at: string;
      latency_ms: string | number;
    }>(`SELECT * FROM feature_policy_emergency_observation ORDER BY first_enforced_at`);
    return result.rows.map((row) => ({
      ...row,
      revision: Number(row.revision),
      policy_updated_at: new Date(row.policy_updated_at).toISOString(),
      first_enforced_at: new Date(row.first_enforced_at).toISOString(),
      latency_ms: Number(row.latency_ms),
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

  // Knowledge base and Pack review are post-launch modules.  They are not
  // represented in the clean-launch schema and must fail closed.
  async createKnowledgeDocument(params: Omit<KnowledgeDocumentRecord, "document_id" | "created_at">): Promise<KnowledgeDocumentRecord> {
    void params;
    throw cleanLaunchUnsupported("knowledge.create");
  }

  async listKnowledgeDocuments(tenantId: string): Promise<KnowledgeDocumentRecord[]> {
    void tenantId;
    throw cleanLaunchUnsupported("knowledge.list");
  }

  async deleteKnowledgeDocument(documentId: string): Promise<KnowledgeDocumentRecord | undefined> {
    void documentId;
    throw cleanLaunchUnsupported("knowledge.delete");
  }

  async createPackReview(params: { publisher: string; pack: PackFile; findings: string[] }): Promise<PackReviewRecord> {
    void params;
    throw cleanLaunchUnsupported("pack_review.create");
  }

  async getPackReview(reviewId: string): Promise<PackReviewRecord | undefined> {
    void reviewId;
    throw cleanLaunchUnsupported("pack_review.get");
  }

  async listPackReviews(): Promise<PackReviewRecord[]> {
    throw cleanLaunchUnsupported("pack_review.list");
  }

  async updatePackReview(reviewId: string, patch: Pick<PackReviewRecord, "status" | "findings">): Promise<PackReviewRecord | undefined> {
    void reviewId;
    void patch;
    throw cleanLaunchUnsupported("pack_review.update");
  }

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
