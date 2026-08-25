/** 内存存储实现：用于测试与本地原型；生产部署使用 PgStore。 */
import { randomUUID } from "node:crypto";
import type { PackFile, SkillPackage } from "@longhub/pack-schema";
import { FEATURE_POLICY_MAX_FEATURES } from "@longhub/feature-policy";
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
  type CloudSkillOperationalMetric,
  type CloudSkillOperationalSummary,
  type CloudSkillExecutionReleaseRequest,
  type CloudSkillExecutionReleaseResult,
  type CloudSkillPlanRecord,
  type CloudSkillPlanStatus,
  type CloudSkillSubscriptionRecord,
  type CloudSkillSubscriptionStatus,
  type DeviceRecord,
  type DevicePairingChallengeRecord,
  type DevicePairingConsumeResult,
  type EntitlementRecord,
  type EventListener,
  type ModelGatewayConfigRecord,
  type FeaturePolicyRecord,
  type FeaturePolicyEmergencyObservationRecord,
  type HttpRouteMetricRecord,
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

const FAR_FUTURE = "2099-12-31T00:00:00.000Z";
const DEFAULT_CLOUD_SKILL_INCLUDED_CALLS = 1_000;
const DEFAULT_CLOUD_SKILL_REQUESTS_PER_MINUTE = 60;
const DEFAULT_CLOUD_SKILL_MAX_CONCURRENCY = 2;
const DEFAULT_CLOUD_SKILL_LEASE_TTL_MS = 5 * 60_000;
const MAX_CLOUD_SKILL_LEASE_TTL_MS = 15 * 60_000;
const MIN_CLOUD_SKILL_LEASE_TTL_MS = 1_000;
const DEFAULT_BILLING_OUTBOX_LEASE_MS = 30_000;
const MAX_BILLING_OUTBOX_LEASE_MS = 5 * 60_000;

function deviceClone(device: DeviceRecord, includeToken = false): DeviceRecord {
  const clone = { ...device };
  if (!includeToken) delete clone.device_token;
  return clone;
}

function cloudSkillPlanClone(plan: CloudSkillPlanRecord): CloudSkillPlanRecord {
  return { ...plan, skill_ids: [...plan.skill_ids] };
}

function cloudSkillSubscriptionClone(subscription: CloudSkillSubscriptionRecord): CloudSkillSubscriptionRecord {
  return { ...subscription };
}

function cloudSkillEntitlementClone(entitlement: CloudSkillEntitlementRecord): CloudSkillEntitlementRecord {
  return { ...entitlement };
}

function cloudSkillExecutionReservationClone(
  reservation: CloudSkillExecutionReservation,
): CloudSkillExecutionReservation {
  return { ...reservation };
}

function cloudAgentSkillBindingClone(binding: CloudAgentSkillBindingRecord): CloudAgentSkillBindingRecord {
  return { ...binding };
}

function cloudAgentSkillBindingKey(binding: {
  tenant_id: string;
  device_id: string;
  agent_id: string;
  skill_id: string;
}): string {
  return [binding.tenant_id, binding.device_id, binding.agent_id, binding.skill_id].join("\u0000");
}

function billingOutboxClone(record: BillingOutboxRecord): BillingOutboxRecord {
  return { ...record, payload: { ...record.payload } };
}

function billingSettlementResultClone(result: BillingSettlementResult, replayed = result.replayed): BillingSettlementResult {
  return {
    ...result,
    replayed,
    settlement: { ...result.settlement },
    order: { ...result.order },
    ...(result.wallet_transaction ? { wallet_transaction: { ...result.wallet_transaction } } : {}),
    ...(result.subscription ? { subscription: { ...result.subscription } } : {}),
    ...(result.cloud_skill_entitlements
      ? { cloud_skill_entitlements: result.cloud_skill_entitlements.map((record) => ({ ...record })) }
      : {}),
    ...(result.entitlements ? { entitlements: result.entitlements.map((record) => ({ ...record })) } : {}),
    outbox: billingOutboxClone(result.outbox),
  };
}

function billingPeriodExpiry(startedAt: string, period: "monthly" | "yearly"): string {
  const started = new Date(startedAt);
  if (!Number.isFinite(started.getTime())) throw new BillingSettlementError("FULFILLMENT_INVALID");
  const days = period === "monthly" ? 31 : 366;
  return new Date(started.getTime() + days * 24 * 60 * 60 * 1_000).toISOString();
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

function queryValue(query: CloudSkillEntitlementQuery | CloudSkillAccessQuery, snake: string, camel: string): string | undefined {
  const value = (query as Record<string, unknown>)[snake] ?? (query as Record<string, unknown>)[camel];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function cloudSkillPlanInputError(message: string): Error {
  return new Error(`INVALID_CLOUD_SKILL_PLAN:${message}`);
}

export class MemoryStore implements CloudStore {
  private readonly tasks = new Map<string, CloudTask>();
  private readonly eventsByTask = new Map<string, CloudTaskEvent[]>();
  private readonly listeners = new Map<string, Set<EventListener>>();
  /** Composite owner scope prevents a tenant/device/agent from reusing another owner's key. */
  private readonly idempotency = new Map<string, string>();
  /** Internal request binding; never included in the public CloudTask object. */
  private readonly taskRequestFingerprints = new Map<string, string>();
  private readonly devices = new Map<string, DeviceRecord>();
  /** Short-lived one-time Manager→Portal pairing proofs (clear codes never persist). */
  private readonly devicePairingChallenges = new Map<string, DevicePairingChallengeRecord>();
  private readonly devicePairingByHash = new Map<string, string>();
  private readonly activationCodes = new Map<string, ActivationCodeRecord>();
  private readonly entitlements = new Map<string, EntitlementRecord>();
  private readonly releases = new Map<string, PackReleaseRecord>();
  private readonly skillReleases = new Map<string, SkillReleaseRecord>();
  private readonly cloudSkillAdapterReleases = new Map<string, CloudSkillAdapterReleaseRecord>();
  private readonly users = new Map<string, UserRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly admins = new Map<string, AdminRecord>();
  private readonly audits: AuditLogRecord[] = [];
  private readonly products = new Map<string, ProductRecord>();
  private readonly orders = new Map<string, OrderRecord>();
  private readonly transactions: WalletTransactionRecord[] = [];
  private readonly billingSettlements = new Map<string, BillingSettlementRecord>();
  private readonly billingSettlementByOrderOperation = new Map<string, string>();
  private readonly billingSettlementByOperationKey = new Map<string, string>();
  private readonly billingSettlementResults = new Map<string, BillingSettlementResult>();
  private readonly billingOutbox = new Map<string, BillingOutboxRecord>();
  private readonly cloudSkillPlans = new Map<string, CloudSkillPlanRecord>();
  private readonly cloudSkillSubscriptions = new Map<string, CloudSkillSubscriptionRecord>();
  private readonly cloudSkillSubscriptionsByOrder = new Map<string, string>();
  private readonly cloudSkillEntitlements = new Map<string, CloudSkillEntitlementRecord>();
  private readonly cloudAgentSkillBindings = new Map<string, CloudAgentSkillBindingRecord>();
  private readonly cloudAgentSkillBindingByOwner = new Map<string, string>();
  /** Admission rows are retained after release so included-call usage cannot be rolled back. */
  private readonly cloudSkillExecutionReservations = new Map<string, CloudSkillExecutionReservation>();
  private readonly cloudSkillExecutionReservationsByTask = new Map<string, string>();
  private readonly modelGatewayConfigs = new Map<string, ModelGatewayConfigRecord>();
  private readonly featurePolicies = new Map<string, FeaturePolicyRecord>();
  private readonly clientTelemetry = new Map<string, ClientTelemetryAggregateRecord>();
  private readonly modelRequestMetrics = new Map<string, ModelRequestAggregateRecord>();
  private readonly httpRouteMetrics = new Map<string, HttpRouteMetricRecord>();
  private readonly emergencyObservations = new Map<string, FeaturePolicyEmergencyObservationRecord>();
  private readonly modelUsage = new Map<string, ModelUsageAggregateRecord>();
  private readonly knowledgeDocuments = new Map<string, KnowledgeDocumentRecord>();
  private readonly packReviews = new Map<string, PackReviewRecord>();
  private taskSeq = 0;
  private eventSeq = 0;
  private featurePolicyRevision = 0;

  private taskIdempotencyBinding(
    idempotencyKey: string,
    owner: CloudTaskOwner,
  ): CloudTaskIdempotencyBinding | undefined {
    const ownerKey = [owner.tenant_id, owner.device_id, owner.agent_id, idempotencyKey].join("\u0000");
    const taskId = this.idempotency.get(ownerKey);
    if (taskId === undefined) return undefined;
    return {
      task: this.mustGet(taskId),
      request_fingerprint: this.taskRequestFingerprints.get(taskId) ?? LEGACY_UNBOUND_TASK_REQUEST_FINGERPRINT,
    };
  }

  async findTaskByIdempotency(
    idempotencyKey: string,
    owner: CloudTaskOwner,
  ): Promise<CloudTaskIdempotencyBinding | undefined> {
    return this.taskIdempotencyBinding(idempotencyKey, owner);
  }

  async createTask(
    idempotencyKey: string,
    kind: string,
    input: unknown,
    owner: CloudTaskOwner = { tenant_id: "__legacy__", device_id: "__legacy__", agent_id: "__legacy__" },
    requestFingerprint?: string,
  ): Promise<{ task: CloudTask; existed: boolean }> {
    const normalizedFingerprint = normalizeCloudTaskRequestFingerprint(requestFingerprint);
    const ownerKey = [owner.tenant_id, owner.device_id, owner.agent_id, idempotencyKey].join("\u0000");
    const existing = this.taskIdempotencyBinding(idempotencyKey, owner);
    if (existing !== undefined) {
      // A row without a v1 binding is historical/legacy data.  It must never
      // be replayed because the missing Skill/plan/session metadata cannot be
      // reconstructed safely.
      const existingFingerprint = existing.request_fingerprint;
      if (existingFingerprint === LEGACY_UNBOUND_TASK_REQUEST_FINGERPRINT || existingFingerprint !== normalizedFingerprint) {
        throw new CloudTaskIdempotencyConflictError();
      }
      return { task: existing.task, existed: true };
    }
    const now = new Date().toISOString();
    const task: CloudTask = {
      task_id: `ct-${++this.taskSeq}`,
      tenant_id: owner.tenant_id,
      device_id: owner.device_id,
      agent_id: owner.agent_id,
      kind,
      status: "pending",
      input,
      created_at: now,
      updated_at: now,
    };
    this.tasks.set(task.task_id, task);
    this.eventsByTask.set(task.task_id, []);
    this.idempotency.set(ownerKey, task.task_id);
    this.taskRequestFingerprints.set(task.task_id, normalizedFingerprint);
    this.emit(task.task_id, "task.accepted");
    return { task, existed: false };
  }

  async getTask(taskId: string): Promise<CloudTask | undefined> {
    return this.tasks.get(taskId);
  }

  async discardPendingTask(taskId: string, placeholder: CloudTaskAdmissionPlaceholder): Promise<boolean> {
    if (!isCloudTaskAdmissionPlaceholder(placeholder)) return false;
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "pending" || !isCloudTaskAdmissionPlaceholder(task.input, placeholder)) return false;
    this.tasks.delete(taskId);
    this.eventsByTask.delete(taskId);
    this.taskRequestFingerprints.delete(taskId);
    this.listeners.delete(taskId);
    for (const [key, value] of this.idempotency) {
      if (value === taskId) this.idempotency.delete(key);
    }
    return true;
  }

  async admitPendingTaskInput(
    taskId: string,
    placeholder: CloudTaskAdmissionPlaceholder,
    input: unknown,
  ): Promise<CloudTask | undefined> {
    if (!isCloudTaskAdmissionPlaceholder(placeholder)) return undefined;
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "pending" || !isCloudTaskAdmissionPlaceholder(task.input, placeholder)) {
      return undefined;
    }
    task.input = input;
    task.updated_at = new Date().toISOString();
    return task;
  }

  async claimPendingTask(taskId: string): Promise<CloudTask | undefined> {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "pending") return undefined;
    // No await occurs between the state check and write. In the in-memory
    // implementation this is the CAS boundary matching PostgreSQL's guarded
    // UPDATE below, so a cancelled task can never be revived as running.
    task.status = "running";
    task.updated_at = new Date().toISOString();
    this.emit(taskId, TASK_EVENT_TYPE.running);
    return task;
  }

  async transitionIfStatus(
    taskId: string,
    expectedStatuses: readonly CloudTaskStatus[],
    status: CloudTaskStatus,
    patch?: Partial<CloudTask>,
  ): Promise<CloudTask | undefined> {
    const task = this.tasks.get(taskId);
    if (!task || !expectedStatuses.includes(task.status)) return undefined;
    // Deliberately keep the check and write in one synchronous section. This
    // is MemoryStore's CAS boundary and mirrors PgStore's guarded UPDATE.
    Object.assign(task, patch);
    task.status = status;
    task.updated_at = new Date().toISOString();
    this.emit(taskId, TASK_EVENT_TYPE[status], task.error ? { error: task.error } : undefined);
    return task;
  }

  async transition(taskId: string, status: CloudTaskStatus, patch?: Partial<CloudTask>): Promise<CloudTask> {
    const task = this.mustGet(taskId);
    Object.assign(task, patch);
    task.status = status;
    task.updated_at = new Date().toISOString();
    this.emit(taskId, TASK_EVENT_TYPE[status], task.error ? { error: task.error } : undefined);
    return task;
  }

  async eventsAfter(taskId: string, afterEventId?: string): Promise<CloudTaskEvent[]> {
    const events = this.eventsByTask.get(taskId) ?? [];
    if (afterEventId === undefined) return [...events];
    const after = Number(afterEventId);
    return events.filter((e) => Number(e.event_id) > after);
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
    for (const device of this.devices.values()) {
      if (
        device.tenant_id === params.tenant_id &&
        device.device_fingerprint === params.device_fingerprint &&
        device.status === "active"
      ) {
        return { device: deviceClone(device), existed: true };
      }
    }
    const device: DeviceRecord = {
      device_id: `dev-${randomUUID()}`,
      tenant_id: params.tenant_id,
      status: "active",
      platform: params.platform,
      app_version: params.app_version,
      device_fingerprint: params.device_fingerprint,
      display_name: params.display_name,
      device_token: `dt-${randomUUID()}${randomUUID()}`,
      created_at: new Date().toISOString(),
    };
    this.devices.set(device.device_id, device);
    return { device: deviceClone(device, true), existed: false };
  }

  async createDevicePairingChallenge(params: {
    challenge_id: string;
    device_id: string;
    code_hash: string;
    expires_at: string;
    now?: string;
  }): Promise<DevicePairingChallengeRecord | undefined> {
    const device = this.devices.get(params.device_id);
    if (!device || device.status !== "active" || device.user_id !== undefined) return undefined;
    const now = params.now ?? new Date().toISOString();
    const expires = new Date(params.expires_at);
    if (!Number.isFinite(expires.getTime()) || expires.toISOString() <= now) return undefined;
    // A device has at most one redeemable code. Reissuing invalidates the old
    // proof before the new one is returned to the Manager.
    for (const [id, challenge] of this.devicePairingChallenges) {
      if (challenge.device_id === device.device_id && challenge.consumed_at === undefined) {
        this.devicePairingByHash.delete(challenge.code_hash);
        this.devicePairingChallenges.delete(id);
      }
    }
    const challenge: DevicePairingChallengeRecord = {
      challenge_id: params.challenge_id,
      device_id: device.device_id,
      tenant_id: device.tenant_id,
      code_hash: params.code_hash,
      expires_at: expires.toISOString(),
      created_at: now,
    };
    this.devicePairingChallenges.set(challenge.challenge_id, challenge);
    this.devicePairingByHash.set(challenge.code_hash, challenge.challenge_id);
    return { ...challenge };
  }

  async consumeDevicePairingChallenge(params: {
    code_hash: string;
    user_id: string;
    now?: string;
  }): Promise<DevicePairingConsumeResult> {
    const challengeId = this.devicePairingByHash.get(params.code_hash);
    if (!challengeId) return { ok: false, reason: "CODE_INVALID" };
    const challenge = this.devicePairingChallenges.get(challengeId);
    if (!challenge || challenge.consumed_at !== undefined) return { ok: false, reason: "CODE_INVALID" };
    const now = params.now ?? new Date().toISOString();
    if (challenge.expires_at <= now) {
      this.devicePairingByHash.delete(challenge.code_hash);
      this.devicePairingChallenges.delete(challenge.challenge_id);
      return { ok: false, reason: "CODE_EXPIRED" };
    }
    const device = this.devices.get(challenge.device_id);
    if (!device) {
      this.devicePairingByHash.delete(challenge.code_hash);
      this.devicePairingChallenges.delete(challenge.challenge_id);
      return { ok: false, reason: "DEVICE_NOT_FOUND" };
    }
    if (device.status !== "active") return { ok: false, reason: "DEVICE_REVOKED" };
    if (device.user_id !== undefined) return { ok: false, reason: "DEVICE_ALREADY_BOUND" };
    device.user_id = params.user_id;
    challenge.consumed_at = now;
    // Consume and remove every outstanding proof for this device, so a code
    // generated just before redemption cannot bind it a second time.
    for (const [id, candidate] of this.devicePairingChallenges) {
      if (candidate.device_id === device.device_id) {
        this.devicePairingByHash.delete(candidate.code_hash);
        this.devicePairingChallenges.delete(id);
      }
    }
    return { ok: true, device: deviceClone(device) };
  }

  async getDevice(deviceId: string): Promise<DeviceRecord | undefined> {
    const device = this.devices.get(deviceId);
    return device ? deviceClone(device) : undefined;
  }

  async findDeviceByToken(token: string): Promise<DeviceRecord | undefined> {
    for (const device of this.devices.values()) {
      if (device.device_token === token) return deviceClone(device);
    }
    return undefined;
  }

  async listDevices(userId?: string): Promise<DeviceRecord[]> {
    return [...this.devices.values()]
      .filter((d) => userId === undefined || d.user_id === userId)
      .map((d) => deviceClone(d));
  }

  async bindDevice(deviceId: string, userId: string): Promise<DeviceRecord | undefined> {
    const device = this.devices.get(deviceId);
    if (!device) return undefined;
    device.user_id = userId;
    return deviceClone(device);
  }

  async updateDeviceVersion(deviceId: string, appVersion: string): Promise<DeviceRecord | undefined> {
    const device = this.devices.get(deviceId);
    if (!device) return undefined;
    device.app_version = appVersion;
    return deviceClone(device);
  }

  async updateDeviceOperations(deviceId: string, patch: Partial<Pick<DeviceRecord, "status" | "last_seen_at" | "last_model_success_at" | "last_error_code" | "credential_rotated_at" | "min_required_version" | "rollout_group" | "device_token">>): Promise<DeviceRecord | undefined> {
    const device = this.devices.get(deviceId);
    if (!device) return undefined;
    Object.assign(device, patch);
    return deviceClone(device, patch.device_token !== undefined);
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
    const record: ActivationCodeRecord = {
      activation_code_id: `act-${randomUUID()}`,
      ...params,
      pack_ids: [...params.pack_ids],
      status: "active",
      use_count: 0,
      created_at: new Date().toISOString(),
    };
    this.activationCodes.set(record.activation_code_id, record);
    return { ...record, pack_ids: [...record.pack_ids] };
  }

  async getActivationCode(activationCodeId: string): Promise<ActivationCodeRecord | undefined> {
    const record = this.activationCodes.get(activationCodeId);
    return record ? { ...record, pack_ids: [...record.pack_ids] } : undefined;
  }

  async listActivationCodes(): Promise<ActivationCodeRecord[]> {
    return [...this.activationCodes.values()].map((record) => ({ ...record, pack_ids: [...record.pack_ids] }));
  }

  async revokeActivationCode(activationCodeId: string): Promise<ActivationCodeRecord | undefined> {
    const record = this.activationCodes.get(activationCodeId);
    if (!record) return undefined;
    record.status = "revoked";
    return { ...record, pack_ids: [...record.pack_ids] };
  }

  async redeemActivationCode(params: {
    device_id: string;
    code_hash: string;
    now: string;
  }): Promise<ActivationRedemptionResult> {
    const device = this.devices.get(params.device_id);
    if (!device) return { ok: false, reason: "DEVICE_NOT_FOUND" };
    const code = [...this.activationCodes.values()].find((candidate) => candidate.code_hash === params.code_hash);
    if (!code || code.tenant_id !== device.tenant_id || code.status !== "active" || code.expires_at <= params.now) {
      return { ok: false, reason: "CODE_UNAVAILABLE" };
    }
    if (device.activation_code_id === code.activation_code_id) {
      return { ok: true, code: { ...code, pack_ids: [...code.pack_ids] }, device: { ...device }, alreadyActivated: true };
    }
    if (code.use_count >= code.max_uses) return { ok: false, reason: "CODE_UNAVAILABLE" };

    const previousActivationCodeId = device.activation_code_id;
    if (previousActivationCodeId) {
      for (const entitlement of this.entitlements.values()) {
        if (entitlement.device_id === device.device_id && entitlement.source_activation_code_id === previousActivationCodeId) {
          entitlement.status = "revoked";
        }
      }
    }
    code.use_count += 1;
    device.activation_code_id = code.activation_code_id;
    device.activated_at = params.now;
    for (const packId of code.pack_ids) {
      const exists = [...this.entitlements.values()].some((entitlement) =>
        entitlement.device_id === device.device_id && entitlement.pack_id === packId &&
        entitlement.status === "active" && entitlement.expires_at > params.now,
      );
      if (!exists) {
        const entitlement: EntitlementRecord = {
          entitlement_id: `ent-${randomUUID()}`,
          tenant_id: device.tenant_id,
          device_id: device.device_id,
          pack_id: packId,
          scope: "device",
          status: "active",
          expires_at: code.expires_at,
          source_activation_code_id: code.activation_code_id,
          created_at: params.now,
        };
        this.entitlements.set(entitlement.entitlement_id, entitlement);
      }
    }
    return { ok: true, code: { ...code, pack_ids: [...code.pack_ids] }, device: { ...device }, alreadyActivated: false };
  }

  async createUser(params: { email: string; password_hash: string }): Promise<{ user: UserRecord; existed: boolean }> {
    for (const user of this.users.values()) {
      if (user.email === params.email) return { user, existed: true };
    }
    const user: UserRecord = {
      user_id: `usr-${randomUUID()}`,
      email: params.email,
      password_hash: params.password_hash,
      status: "active",
      balance_fen: 0,
      created_at: new Date().toISOString(),
    };
    this.users.set(user.user_id, user);
    return { user, existed: false };
  }

  async getUser(userId: string): Promise<UserRecord | undefined> {
    return this.users.get(userId);
  }

  async getUserByEmail(email: string): Promise<UserRecord | undefined> {
    for (const user of this.users.values()) {
      if (user.email === email) return user;
    }
    return undefined;
  }

  async listUsers(): Promise<UserRecord[]> {
    return [...this.users.values()];
  }

  async setUserStatus(userId: string, status: "active" | "disabled"): Promise<UserRecord | undefined> {
    const user = this.users.get(userId);
    if (!user) return undefined;
    user.status = status;
    return user;
  }

  async createSession(params: {
    subject_type: "user" | "admin";
    subject_id: string;
    token: string;
    expires_at: string;
  }): Promise<SessionRecord> {
    const session: SessionRecord = { ...params, created_at: new Date().toISOString() };
    this.sessions.set(hashSessionToken(session.token), session);
    return session;
  }

  async getSession(token: string): Promise<SessionRecord | undefined> {
    const tokenHash = hashSessionToken(token);
    const session = this.sessions.get(tokenHash);
    if (!session) return undefined;
    if (session.expires_at <= new Date().toISOString()) {
      this.sessions.delete(tokenHash);
      return undefined;
    }
    return session;
  }

  async deleteSession(token: string): Promise<void> {
    this.sessions.delete(hashSessionToken(token));
  }

  async createAdmin(params: {
    username: string;
    password_hash: string;
    role: AdminRole;
  }): Promise<{ admin: AdminRecord; existed: boolean }> {
    for (const admin of this.admins.values()) {
      if (admin.username === params.username) return { admin, existed: true };
    }
    const admin: AdminRecord = {
      admin_id: `adm-${randomUUID()}`,
      username: params.username,
      password_hash: params.password_hash,
      role: params.role,
      status: "active",
      created_at: new Date().toISOString(),
    };
    this.admins.set(admin.admin_id, admin);
    return { admin, existed: false };
  }

  async getAdmin(adminId: string): Promise<AdminRecord | undefined> {
    return this.admins.get(adminId);
  }

  async getAdminByUsername(username: string): Promise<AdminRecord | undefined> {
    for (const admin of this.admins.values()) {
      if (admin.username === username) return admin;
    }
    return undefined;
  }

  async appendAudit(actor: string, action: string, detail?: unknown): Promise<AuditLogRecord> {
    const record: AuditLogRecord = {
      audit_id: `aud-${randomUUID()}`,
      actor,
      action,
      detail: redactLogValue(detail),
      created_at: new Date().toISOString(),
    };
    this.audits.push(record);
    return record;
  }

  async listAudits(limit = 200): Promise<AuditLogRecord[]> {
    return this.audits.slice(-limit).reverse();
  }

  async createProduct(params: {
    pack_id: string;
    name: string;
    description: string;
    price_monthly_fen: number;
    price_yearly_fen: number;
    status?: "listed" | "unlisted";
  }): Promise<ProductRecord> {
    const product: ProductRecord = {
      product_id: `prd-${randomUUID()}`,
      pack_id: params.pack_id,
      name: params.name,
      description: params.description,
      price_monthly_fen: params.price_monthly_fen,
      price_yearly_fen: params.price_yearly_fen,
      status: params.status ?? "listed",
      created_at: new Date().toISOString(),
    };
    this.products.set(product.product_id, product);
    return product;
  }

  async updateProduct(
    productId: string,
    patch: Partial<Pick<ProductRecord, "name" | "description" | "price_monthly_fen" | "price_yearly_fen" | "status">>,
  ): Promise<ProductRecord | undefined> {
    const product = this.products.get(productId);
    if (!product) return undefined;
    Object.assign(product, patch);
    return product;
  }

  async getProduct(productId: string): Promise<ProductRecord | undefined> {
    return this.products.get(productId);
  }

  async listProducts(): Promise<ProductRecord[]> {
    return [...this.products.values()];
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
    const order: OrderRecord = {
      order_id: `ord-${randomUUID()}`,
      user_id: params.user_id,
      type: params.type,
      product_id: params.product_id,
      pack_id: params.pack_id,
      plan_id: params.plan_id,
      tenant_id: params.tenant_id,
      period: params.period,
      amount_fen: params.amount_fen,
      status: "pending",
      created_at: new Date().toISOString(),
    };
    this.orders.set(order.order_id, order);
    return order;
  }

  async getOrder(orderId: string): Promise<OrderRecord | undefined> {
    return this.orders.get(orderId);
  }

  async updateOrder(
    orderId: string,
    patch: Partial<Pick<OrderRecord, "status" | "pay_method" | "paid_at" | "refunded_at">>,
  ): Promise<OrderRecord | undefined> {
    const order = this.orders.get(orderId);
    if (!order) return undefined;
    Object.assign(order, patch);
    return order;
  }

  async listOrders(userId?: string): Promise<OrderRecord[]> {
    return [...this.orders.values()].filter((o) => userId === undefined || o.user_id === userId);
  }

  private billingSettlementReplay(
    operation: "payment" | "refund",
    orderId: string,
    idempotencyKey: string,
    requestHash: string,
    method?: "balance" | "mock" | "provider",
    providerReference?: string,
  ): BillingSettlementResult | undefined {
    if (!idempotencyKey || !requestHash) throw new BillingSettlementError("IDEMPOTENCY_CONFLICT");
    const orderLookup = `${orderId}\u0000${operation}`;
    const keyLookup = `${operation}\u0000${idempotencyKey}`;
    const byOrder = this.billingSettlementByOrderOperation.get(orderLookup);
    const byKey = this.billingSettlementByOperationKey.get(keyLookup);
    if (byOrder === undefined && byKey === undefined) return undefined;
    if (byOrder === undefined || byKey === undefined || byOrder !== byKey) {
      throw new BillingSettlementError("IDEMPOTENCY_CONFLICT");
    }
    const settlement = this.billingSettlements.get(byOrder);
    const result = this.billingSettlementResults.get(byOrder);
    if (!settlement || !result || settlement.order_id !== orderId || settlement.operation !== operation ||
      settlement.idempotency_key !== idempotencyKey || settlement.request_hash !== requestHash ||
      settlement.provider_reference !== providerReference ||
      (operation === "payment" && settlement.method !== method)) {
      throw new BillingSettlementError("IDEMPOTENCY_CONFLICT");
    }
    return billingSettlementResultClone(result, true);
  }

  async settleOrderPayment(params: SettleOrderPaymentParams): Promise<BillingSettlementResult> {
    const replay = this.billingSettlementReplay(
      "payment",
      params.order_id,
      params.idempotency_key,
      params.request_hash,
      params.method,
      params.provider_reference,
    );
    if (replay) return replay;
    if (params.method !== "balance" && params.method !== "mock" && params.method !== "provider") {
      throw new BillingSettlementError("INVALID_PAYMENT_METHOD", "method must be balance, mock or provider", 422);
    }
    if (params.method === "provider" && !validProviderReference(params.provider_reference)) {
      throw new BillingSettlementError("FULFILLMENT_INVALID", "provider reference is required", 422);
    }
    const currentOrder = this.orders.get(params.order_id);
    if (!currentOrder || currentOrder.user_id !== params.user_id) {
      throw new BillingSettlementError("ORDER_NOT_FOUND");
    }
    if (currentOrder.status !== "pending") throw new BillingSettlementError("ORDER_NOT_PENDING");
    if (currentOrder.type === "recharge" && params.method === "balance") {
      throw new BillingSettlementError("RECHARGE_BALANCE_FORBIDDEN", "recharge cannot use wallet balance", 422);
    }

    const currentUser = this.users.get(currentOrder.user_id);
    if (!currentUser) throw new BillingSettlementError("ORDER_NOT_FOUND");
    const paidAt = params.paid_at ?? new Date().toISOString();
    if (!Number.isFinite(new Date(paidAt).getTime())) throw new BillingSettlementError("FULFILLMENT_INVALID");

    let balanceDelta = 0;
    let transactionType: WalletTransactionRecord["type"] | undefined;
    let transactionRemark: string | undefined;
    if (currentOrder.type === "recharge") {
      balanceDelta = currentOrder.amount_fen;
      transactionType = "recharge";
      transactionRemark = "模拟支付充值";
    } else if (params.method === "balance") {
      balanceDelta = -currentOrder.amount_fen;
      transactionType = "purchase";
      transactionRemark = currentOrder.type === "cloud_skill_plan" ? "余额购买云端 Skill 订阅" : "余额购买套装订阅";
    }
    const balanceAfter = currentUser.balance_fen + balanceDelta;
    if (balanceAfter < 0) throw new BillingSettlementError("INSUFFICIENT_BALANCE");

    const settlementId = `bst-${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const settlement: BillingSettlementRecord = {
      settlement_id: settlementId,
      order_id: currentOrder.order_id,
      operation: "payment",
      idempotency_key: params.idempotency_key,
      request_hash: params.request_hash,
      method: params.method,
      ...(params.provider_reference ? { provider_reference: params.provider_reference } : {}),
      amount_fen: currentOrder.amount_fen,
      created_at: createdAt,
    };
    const paidOrder: OrderRecord = {
      ...currentOrder,
      status: "paid",
      pay_method: params.method,
      paid_at: paidAt,
    };
    const walletTransaction: WalletTransactionRecord | undefined = transactionType === undefined ? undefined : {
      txn_id: `txn-${randomUUID()}`,
      user_id: currentOrder.user_id,
      type: transactionType,
      amount_fen: balanceDelta,
      balance_after_fen: balanceAfter,
      order_id: currentOrder.order_id,
      settlement_id: settlementId,
      remark: transactionRemark,
      created_at: createdAt,
    };

    const stagedPackEntitlements: EntitlementRecord[] = [];
    let stagedSubscription: CloudSkillSubscriptionRecord | undefined;
    const stagedCloudEntitlements: CloudSkillEntitlementRecord[] = [];
    if (paidOrder.type === "plan") {
      if (!paidOrder.pack_id || !paidOrder.period) throw new BillingSettlementError("FULFILLMENT_INVALID");
      const expiresAt = billingPeriodExpiry(paidAt, paidOrder.period);
      const devices = [...this.devices.values()]
        .filter((device) => device.user_id === paidOrder.user_id && device.status === "active")
        .sort((left, right) => left.device_id.localeCompare(right.device_id));
      for (const device of devices) {
        const existing = [...this.entitlements.values()].find((entitlement) =>
          entitlement.source_order_id === paidOrder.order_id && entitlement.device_id === device.device_id &&
          entitlement.pack_id === paidOrder.pack_id,
        );
        stagedPackEntitlements.push(existing ? {
          ...existing,
          tenant_id: device.tenant_id,
          scope: "user",
          status: "active",
          expires_at: expiresAt,
        } : {
          entitlement_id: `ent-${randomUUID()}`,
          tenant_id: device.tenant_id,
          device_id: device.device_id,
          pack_id: paidOrder.pack_id,
          scope: "user",
          status: "active",
          expires_at: expiresAt,
          source_order_id: paidOrder.order_id,
          created_at: createdAt,
        });
      }
    } else if (paidOrder.type === "cloud_skill_plan") {
      if (!paidOrder.plan_id || !paidOrder.tenant_id || !paidOrder.period) {
        throw new BillingSettlementError("FULFILLMENT_INVALID");
      }
      const plan = this.cloudSkillPlans.get(paidOrder.plan_id);
      if (!plan) throw new BillingSettlementError("FULFILLMENT_INVALID", "cloud Skill plan not found");
      const expiresAt = billingPeriodExpiry(paidAt, paidOrder.period);
      const existingSubscriptionId = this.cloudSkillSubscriptionsByOrder.get(paidOrder.order_id);
      const existingSubscription = existingSubscriptionId
        ? this.cloudSkillSubscriptions.get(existingSubscriptionId)
        : undefined;
      if (existingSubscription && (existingSubscription.user_id !== paidOrder.user_id ||
        existingSubscription.tenant_id !== paidOrder.tenant_id || existingSubscription.plan_id !== paidOrder.plan_id ||
        existingSubscription.period !== paidOrder.period || existingSubscription.status === "refunded")) {
        throw new BillingSettlementError("FULFILLMENT_INVALID");
      }
      stagedSubscription = existingSubscription ? {
        ...existingSubscription,
        status: "active",
        starts_at: paidAt,
        expires_at: expiresAt,
        cancelled_at: undefined,
        refunded_at: undefined,
      } : {
        subscription_id: `csub-${randomUUID()}`,
        user_id: paidOrder.user_id,
        tenant_id: paidOrder.tenant_id,
        plan_id: paidOrder.plan_id,
        status: "active",
        period: paidOrder.period,
        starts_at: paidAt,
        expires_at: expiresAt,
        source_order_id: paidOrder.order_id,
        created_at: createdAt,
      };
      for (const skillId of [...plan.skill_ids].sort()) {
        const existing = [...this.cloudSkillEntitlements.values()].find((entitlement) =>
          entitlement.subscription_id === stagedSubscription!.subscription_id && entitlement.plan_id === plan.plan_id &&
          entitlement.skill_id === skillId,
        );
        stagedCloudEntitlements.push(existing ? {
          ...existing,
          tenant_id: paidOrder.tenant_id,
          user_id: paidOrder.user_id,
          status: "active",
          expires_at: expiresAt,
        } : {
          entitlement_id: `csent-${randomUUID()}`,
          subscription_id: stagedSubscription.subscription_id,
          tenant_id: paidOrder.tenant_id,
          user_id: paidOrder.user_id,
          skill_id: skillId,
          plan_id: plan.plan_id,
          status: "active",
          expires_at: expiresAt,
          created_at: createdAt,
        });
      }
    }

    const outbox: BillingOutboxRecord = {
      outbox_id: `bout-${randomUUID()}`,
      event_type: "billing.payment.settled",
      aggregate_id: paidOrder.order_id,
      settlement_id: settlementId,
      payload: {
        order_id: paidOrder.order_id,
        user_id: paidOrder.user_id,
        order_type: paidOrder.type,
        method: params.method,
        amount_fen: paidOrder.amount_fen,
      },
      attempts: 0,
      available_at: createdAt,
      created_at: createdAt,
    };
    const result: BillingSettlementResult = {
      replayed: false,
      settlement,
      order: paidOrder,
      ...(walletTransaction ? { wallet_transaction: walletTransaction } : {}),
      ...(stagedSubscription ? { subscription: stagedSubscription } : {}),
      ...(stagedCloudEntitlements.length > 0 ? { cloud_skill_entitlements: stagedCloudEntitlements } : {}),
      ...(stagedPackEntitlements.length > 0 ? { entitlements: stagedPackEntitlements } : {}),
      outbox,
    };

    // All preconditions are checked above. These synchronous mutations form a
    // single event-loop critical section, so concurrent callers cannot observe
    // a partially settled MemoryStore order.
    if (balanceDelta !== 0) this.users.set(currentUser.user_id, { ...currentUser, balance_fen: balanceAfter });
    if (walletTransaction) this.transactions.push(walletTransaction);
    this.orders.set(paidOrder.order_id, paidOrder);
    for (const entitlement of stagedPackEntitlements) this.entitlements.set(entitlement.entitlement_id, entitlement);
    if (stagedSubscription) {
      this.cloudSkillSubscriptions.set(stagedSubscription.subscription_id, stagedSubscription);
      this.cloudSkillSubscriptionsByOrder.set(stagedSubscription.source_order_id, stagedSubscription.subscription_id);
    }
    for (const entitlement of stagedCloudEntitlements) {
      this.cloudSkillEntitlements.set(entitlement.entitlement_id, entitlement);
    }
    this.billingSettlements.set(settlementId, settlement);
    this.billingSettlementByOrderOperation.set(`${paidOrder.order_id}\u0000payment`, settlementId);
    this.billingSettlementByOperationKey.set(`payment\u0000${params.idempotency_key}`, settlementId);
    this.billingOutbox.set(outbox.outbox_id, outbox);
    this.billingSettlementResults.set(settlementId, billingSettlementResultClone(result));
    return billingSettlementResultClone(result);
  }

  async settleOrderRefund(params: SettleOrderRefundParams): Promise<BillingSettlementResult> {
    const replay = this.billingSettlementReplay(
      "refund",
      params.order_id,
      params.idempotency_key,
      params.request_hash,
      undefined,
      params.provider_reference,
    );
    if (replay) return replay;
    const currentOrder = this.orders.get(params.order_id);
    if (!currentOrder) throw new BillingSettlementError("ORDER_NOT_FOUND");
    if (currentOrder.type === "recharge") throw new BillingSettlementError("RECHARGE_REFUND_FORBIDDEN");
    if (currentOrder.status !== "paid") throw new BillingSettlementError("ORDER_NOT_PAID");
    const currentUser = this.users.get(currentOrder.user_id);
    if (!currentUser) throw new BillingSettlementError("ORDER_NOT_FOUND");
    const refundedAt = params.refunded_at ?? new Date().toISOString();
    if (!Number.isFinite(new Date(refundedAt).getTime())) throw new BillingSettlementError("FULFILLMENT_INVALID");
    if (params.provider_reference !== undefined && !validProviderReference(params.provider_reference)) {
      throw new BillingSettlementError("FULFILLMENT_INVALID", "provider reference is invalid", 422);
    }

    const stagedPackEntitlements: EntitlementRecord[] = [];
    let stagedSubscription: CloudSkillSubscriptionRecord | undefined;
    const stagedCloudEntitlements: CloudSkillEntitlementRecord[] = [];
    if (currentOrder.type === "plan") {
      if (!currentOrder.pack_id) throw new BillingSettlementError("REFUND_REQUIRES_RECONCILIATION");
      const userDeviceIds = new Set([...this.devices.values()]
        .filter((device) => device.user_id === currentOrder.user_id)
        .map((device) => device.device_id));
      const orderOwned = [...this.entitlements.values()].filter((entitlement) =>
        entitlement.source_order_id === currentOrder.order_id,
      );
      const ambiguousLegacy = [...this.entitlements.values()].some((entitlement) =>
        userDeviceIds.has(entitlement.device_id) && entitlement.pack_id === currentOrder.pack_id &&
        entitlement.status === "active" && entitlement.source_order_id === undefined &&
        entitlement.source_activation_code_id === undefined,
      );
      if (ambiguousLegacy) {
        throw new BillingSettlementError("REFUND_REQUIRES_RECONCILIATION");
      }
      for (const entitlement of orderOwned) stagedPackEntitlements.push({ ...entitlement, status: "revoked" });
    } else {
      const subscriptionId = this.cloudSkillSubscriptionsByOrder.get(currentOrder.order_id);
      const subscription = subscriptionId ? this.cloudSkillSubscriptions.get(subscriptionId) : undefined;
      if (!subscription || subscription.user_id !== currentOrder.user_id || subscription.plan_id !== currentOrder.plan_id) {
        throw new BillingSettlementError("REFUND_REQUIRES_RECONCILIATION");
      }
      stagedSubscription = { ...subscription, status: "refunded", refunded_at: refundedAt };
      for (const entitlement of this.cloudSkillEntitlements.values()) {
        if (entitlement.subscription_id === subscription.subscription_id) {
          stagedCloudEntitlements.push({ ...entitlement, status: "revoked" });
        }
      }
    }

    const settlementId = `bst-${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const balanceAfter = currentUser.balance_fen + currentOrder.amount_fen;
    const walletTransaction: WalletTransactionRecord = {
      txn_id: `txn-${randomUUID()}`,
      user_id: currentOrder.user_id,
      type: "refund",
      amount_fen: currentOrder.amount_fen,
      balance_after_fen: balanceAfter,
      order_id: currentOrder.order_id,
      settlement_id: settlementId,
      remark: "管理端退款入余额",
      created_at: createdAt,
    };
    const refundedOrder: OrderRecord = {
      ...currentOrder,
      status: "refunded",
      refunded_at: refundedAt,
    };
    const settlement: BillingSettlementRecord = {
      settlement_id: settlementId,
      order_id: currentOrder.order_id,
      operation: "refund",
      idempotency_key: params.idempotency_key,
      request_hash: params.request_hash,
      ...(params.provider_reference ? { method: "provider", provider_reference: params.provider_reference } : {}),
      amount_fen: currentOrder.amount_fen,
      created_at: createdAt,
    };
    const outbox: BillingOutboxRecord = {
      outbox_id: `bout-${randomUUID()}`,
      event_type: "billing.refund.settled",
      aggregate_id: currentOrder.order_id,
      settlement_id: settlementId,
      payload: {
        order_id: currentOrder.order_id,
        user_id: currentOrder.user_id,
        order_type: currentOrder.type,
        amount_fen: currentOrder.amount_fen,
        actor: params.actor,
      },
      attempts: 0,
      available_at: createdAt,
      created_at: createdAt,
    };
    const result: BillingSettlementResult = {
      replayed: false,
      settlement,
      order: refundedOrder,
      wallet_transaction: walletTransaction,
      ...(stagedSubscription ? { subscription: stagedSubscription } : {}),
      ...(stagedCloudEntitlements.length > 0 ? { cloud_skill_entitlements: stagedCloudEntitlements } : {}),
      ...(stagedPackEntitlements.length > 0 ? { entitlements: stagedPackEntitlements } : {}),
      outbox,
    };

    this.users.set(currentUser.user_id, { ...currentUser, balance_fen: balanceAfter });
    this.transactions.push(walletTransaction);
    this.orders.set(refundedOrder.order_id, refundedOrder);
    for (const entitlement of stagedPackEntitlements) this.entitlements.set(entitlement.entitlement_id, entitlement);
    if (stagedSubscription) this.cloudSkillSubscriptions.set(stagedSubscription.subscription_id, stagedSubscription);
    for (const entitlement of stagedCloudEntitlements) {
      this.cloudSkillEntitlements.set(entitlement.entitlement_id, entitlement);
    }
    this.audits.push({
      audit_id: `aud-${randomUUID()}`,
      actor: params.actor,
      action: "order.refund",
      detail: redactLogValue({ order_id: currentOrder.order_id, amount_fen: currentOrder.amount_fen }),
      created_at: createdAt,
    });
    this.billingSettlements.set(settlementId, settlement);
    this.billingSettlementByOrderOperation.set(`${currentOrder.order_id}\u0000refund`, settlementId);
    this.billingSettlementByOperationKey.set(`refund\u0000${params.idempotency_key}`, settlementId);
    this.billingOutbox.set(outbox.outbox_id, outbox);
    this.billingSettlementResults.set(settlementId, billingSettlementResultClone(result));
    return billingSettlementResultClone(result);
  }

  async listBillingOutbox(): Promise<BillingOutboxRecord[]> {
    return [...this.billingOutbox.values()]
      .sort((left, right) => left.created_at.localeCompare(right.created_at))
      .map(billingOutboxClone);
  }

  async claimBillingOutbox(params: BillingOutboxClaimParams = {}): Promise<BillingOutboxRecord[]> {
    const limit = normalizeBillingOutboxLimit(params.limit);
    const leaseMs = normalizeBillingOutboxLease(params.lease_ms);
    const now = parseBillingOutboxTime(params.now);
    if (limit === undefined || leaseMs === undefined || now === undefined) return [];
    const lockToken = `bol-${randomUUID()}`;
    const lockedUntil = new Date(now.getTime() + leaseMs).toISOString();
    const claimed = [...this.billingOutbox.values()]
      .filter((record) => !record.published_at && !record.dead_lettered_at &&
        Date.parse(record.available_at) <= now.getTime() &&
        (record.locked_until === undefined || Date.parse(record.locked_until) <= now.getTime()))
      .sort((left, right) => left.available_at.localeCompare(right.available_at) ||
        left.created_at.localeCompare(right.created_at) || left.outbox_id.localeCompare(right.outbox_id))
      .slice(0, limit);
    for (const record of claimed) {
      record.attempts += 1;
      record.lock_token = lockToken;
      record.locked_until = lockedUntil;
      record.last_error = undefined;
    }
    return claimed.map(billingOutboxClone);
  }

  async completeBillingOutbox(outboxId: string, lockToken: string, publishedAt?: string): Promise<boolean> {
    const record = this.billingOutbox.get(outboxId);
    const completedAt = parseBillingOutboxTime(publishedAt);
    if (!record || !completedAt || !validBillingOutboxLockToken(lockToken) || record.lock_token !== lockToken ||
      record.published_at !== undefined || record.dead_lettered_at !== undefined ||
      record.locked_until === undefined || Date.parse(record.locked_until) <= completedAt.getTime()) return false;
    record.published_at = completedAt.toISOString();
    record.lock_token = undefined;
    record.locked_until = undefined;
    record.last_error = undefined;
    return true;
  }

  async failBillingOutbox(params: BillingOutboxFailureParams): Promise<boolean> {
    const record = this.billingOutbox.get(params.outbox_id);
    const failedAt = parseBillingOutboxTime(params.failed_at);
    const retryAt = parseBillingOutboxTime(params.retry_at);
    const deadLetteredAt = params.dead_lettered_at === undefined
      ? undefined
      : parseBillingOutboxTime(params.dead_lettered_at);
    if (!record || !failedAt || !retryAt || (params.dead_lettered_at !== undefined && !deadLetteredAt) ||
      !validBillingOutboxLockToken(params.lock_token) || record.lock_token !== params.lock_token ||
      !validBillingOutboxErrorCode(params.error_code) || record.published_at !== undefined ||
      record.dead_lettered_at !== undefined || record.locked_until === undefined ||
      Date.parse(record.locked_until) <= failedAt.getTime()) return false;
    record.available_at = retryAt.toISOString();
    record.lock_token = undefined;
    record.locked_until = undefined;
    record.last_error = params.error_code;
    if (deadLetteredAt) record.dead_lettered_at = deadLetteredAt.toISOString();
    return true;
  }

  async addWalletTransaction(params: {
    user_id: string;
    type: "recharge" | "purchase" | "refund" | "adjust";
    amount_fen: number;
    order_id?: string;
    remark?: string;
  }): Promise<WalletTransactionRecord> {
    const user = this.users.get(params.user_id);
    if (!user) throw new Error(`Unknown user: ${params.user_id}`);
    const next = user.balance_fen + params.amount_fen;
    if (next < 0) throw new Error("INSUFFICIENT_BALANCE");
    user.balance_fen = next;
    const txn: WalletTransactionRecord = {
      txn_id: `txn-${randomUUID()}`,
      user_id: params.user_id,
      type: params.type,
      amount_fen: params.amount_fen,
      balance_after_fen: next,
      order_id: params.order_id,
      remark: params.remark,
      created_at: new Date().toISOString(),
    };
    this.transactions.push(txn);
    return txn;
  }

  async listTransactions(userId?: string): Promise<WalletTransactionRecord[]> {
    return this.transactions.filter((t) => userId === undefined || t.user_id === userId).slice().reverse();
  }

  async listAllEntitlements(): Promise<EntitlementRecord[]> {
    return [...this.entitlements.values()];
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
    if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/.test(params.plan_id)) {
      throw cloudSkillPlanInputError("plan_id");
    }
    if (!params.name.trim() || params.name.length > 120) {
      throw cloudSkillPlanInputError("name");
    }
    const skillIds = [...new Set(params.skill_ids)];
    if (skillIds.length === 0 || skillIds.some((skillId) => !/^[a-z][a-z0-9.-]*\.skill\.[a-z][a-z0-9.-]*$/.test(skillId))) {
      throw cloudSkillPlanInputError("skill_ids");
    }
    if (skillIds.length !== params.skill_ids.length) {
      throw cloudSkillPlanInputError("skill_ids_duplicate");
    }
    const numeric = [params.price_monthly_fen, params.price_yearly_fen,
      params.included_calls ?? DEFAULT_CLOUD_SKILL_INCLUDED_CALLS,
      params.requests_per_minute ?? DEFAULT_CLOUD_SKILL_REQUESTS_PER_MINUTE,
      params.max_concurrency ?? DEFAULT_CLOUD_SKILL_MAX_CONCURRENCY];
    if (numeric.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw cloudSkillPlanInputError("limits");
    }
    const rpm = params.requests_per_minute ?? DEFAULT_CLOUD_SKILL_REQUESTS_PER_MINUTE;
    const concurrency = params.max_concurrency ?? DEFAULT_CLOUD_SKILL_MAX_CONCURRENCY;
    if (rpm <= 0 || concurrency <= 0) throw cloudSkillPlanInputError("limits");
    if (this.cloudSkillPlans.has(params.plan_id)) throw new Error("CLOUD_SKILL_PLAN_EXISTS");
    const record: CloudSkillPlanRecord = {
      plan_id: params.plan_id,
      name: params.name,
      description: params.description ?? "",
      skill_ids: skillIds,
      price_monthly_fen: params.price_monthly_fen,
      price_yearly_fen: params.price_yearly_fen,
      included_calls: params.included_calls ?? DEFAULT_CLOUD_SKILL_INCLUDED_CALLS,
      requests_per_minute: rpm,
      max_concurrency: concurrency,
      status: params.status ?? "listed",
      created_at: new Date().toISOString(),
    };
    this.cloudSkillPlans.set(record.plan_id, record);
    return cloudSkillPlanClone(record);
  }

  async getCloudSkillPlan(planId: string): Promise<CloudSkillPlanRecord | undefined> {
    const plan = this.cloudSkillPlans.get(planId);
    return plan ? cloudSkillPlanClone(plan) : undefined;
  }

  async listCloudSkillPlans(status?: CloudSkillPlanStatus): Promise<CloudSkillPlanRecord[]> {
    return [...this.cloudSkillPlans.values()]
      .filter((plan) => status === undefined || plan.status === status)
      .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.plan_id.localeCompare(right.plan_id))
      .map(cloudSkillPlanClone);
  }

  async updateCloudSkillPlan(
    planId: string,
    patch: Partial<Pick<CloudSkillPlanRecord,
      "name" | "description" | "skill_ids" | "price_monthly_fen" | "price_yearly_fen" |
      "included_calls" | "requests_per_minute" | "max_concurrency" | "status">>,
  ): Promise<CloudSkillPlanRecord | undefined> {
    const current = this.cloudSkillPlans.get(planId);
    if (!current) return undefined;
    if (patch.name !== undefined && (!patch.name.trim() || patch.name.length > 120)) {
      throw cloudSkillPlanInputError("name");
    }
    if (patch.skill_ids !== undefined) {
      const ids = [...new Set(patch.skill_ids)];
      if (ids.length === 0 || ids.length !== patch.skill_ids.length || ids.some((skillId) => !/^[a-z][a-z0-9.-]*\.skill\.[a-z][a-z0-9.-]*$/.test(skillId))) {
        throw cloudSkillPlanInputError("skill_ids");
      }
      patch = { ...patch, skill_ids: ids };
    }
    for (const key of ["price_monthly_fen", "price_yearly_fen", "included_calls", "requests_per_minute", "max_concurrency"] as const) {
      const value = patch[key];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw cloudSkillPlanInputError(key);
    }
    if (patch.requests_per_minute !== undefined && patch.requests_per_minute <= 0) throw cloudSkillPlanInputError("requests_per_minute");
    if (patch.max_concurrency !== undefined && patch.max_concurrency <= 0) throw cloudSkillPlanInputError("max_concurrency");
    Object.assign(current, patch);
    return cloudSkillPlanClone(current);
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
    const plan = this.cloudSkillPlans.get(params.plan_id);
    if (!plan) throw new Error("CLOUD_SKILL_PLAN_NOT_FOUND");
    const existingId = this.cloudSkillSubscriptionsByOrder.get(params.source_order_id);
    if (existingId) {
      const existing = this.cloudSkillSubscriptions.get(existingId)!;
      if (existing.plan_id !== params.plan_id || existing.user_id !== params.user_id) {
        throw new Error("CLOUD_SKILL_ORDER_CONFLICT");
      }
      return { subscription: cloudSkillSubscriptionClone(existing), existed: true };
    }
    if (!params.tenant_id || !params.user_id || params.starts_at >= params.expires_at) {
      throw new Error("INVALID_CLOUD_SKILL_SUBSCRIPTION");
    }
    const subscription: CloudSkillSubscriptionRecord = {
      subscription_id: `csub-${randomUUID()}`,
      user_id: params.user_id,
      tenant_id: params.tenant_id,
      plan_id: plan.plan_id,
      status: params.status ?? "active",
      period: params.period,
      starts_at: params.starts_at,
      expires_at: params.expires_at,
      source_order_id: params.source_order_id,
      created_at: new Date().toISOString(),
    };
    this.cloudSkillSubscriptions.set(subscription.subscription_id, subscription);
    this.cloudSkillSubscriptionsByOrder.set(subscription.source_order_id, subscription.subscription_id);
    return { subscription: cloudSkillSubscriptionClone(subscription), existed: false };
  }

  async getCloudSkillSubscription(subscriptionId: string): Promise<CloudSkillSubscriptionRecord | undefined> {
    const subscription = this.cloudSkillSubscriptions.get(subscriptionId);
    return subscription ? cloudSkillSubscriptionClone(subscription) : undefined;
  }

  async getCloudSkillSubscriptionByOrder(orderId: string): Promise<CloudSkillSubscriptionRecord | undefined> {
    const id = this.cloudSkillSubscriptionsByOrder.get(orderId);
    return id ? this.getCloudSkillSubscription(id) : undefined;
  }

  async listCloudSkillSubscriptions(userId?: string): Promise<CloudSkillSubscriptionRecord[]> {
    return [...this.cloudSkillSubscriptions.values()]
      .filter((subscription) => userId === undefined || subscription.user_id === userId)
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .map(cloudSkillSubscriptionClone);
  }

  async updateCloudSkillSubscriptionStatus(
    subscriptionId: string,
    status: CloudSkillSubscriptionStatus,
    changedAt = new Date().toISOString(),
  ): Promise<CloudSkillSubscriptionRecord | undefined> {
    const subscription = this.cloudSkillSubscriptions.get(subscriptionId);
    if (!subscription) return undefined;
    subscription.status = status;
    if (status === "cancelled") subscription.cancelled_at = changedAt;
    if (status === "refunded") subscription.refunded_at = changedAt;
    if (status !== "active") {
      for (const entitlement of this.cloudSkillEntitlements.values()) {
        if (entitlement.subscription_id === subscription.subscription_id && entitlement.status === "active") {
          entitlement.status = "revoked";
        }
      }
    }
    return cloudSkillSubscriptionClone(subscription);
  }

  async grantCloudSkillEntitlement(params: {
    subscription_id: string;
    tenant_id?: string;
    user_id?: string;
    skill_id: string;
    plan_id: string;
    expires_at?: string;
  }): Promise<{ entitlement: CloudSkillEntitlementRecord; existed: boolean }> {
    const subscription = this.cloudSkillSubscriptions.get(params.subscription_id);
    if (!subscription) throw new Error("CLOUD_SKILL_SUBSCRIPTION_NOT_FOUND");
    if (subscription.plan_id !== params.plan_id) throw new Error("CLOUD_SKILL_PLAN_MISMATCH");
    const plan = this.cloudSkillPlans.get(params.plan_id);
    if (!plan || !plan.skill_ids.includes(params.skill_id)) throw new Error("CLOUD_SKILL_SKILL_NOT_IN_PLAN");
    const tenantId = params.tenant_id ?? subscription.tenant_id;
    const userId = params.user_id ?? subscription.user_id;
    if (tenantId !== subscription.tenant_id || userId !== subscription.user_id) throw new Error("CLOUD_SKILL_SCOPE_MISMATCH");
    const existing = [...this.cloudSkillEntitlements.values()].find((entitlement) =>
      entitlement.subscription_id === subscription.subscription_id &&
      entitlement.skill_id === params.skill_id && entitlement.plan_id === params.plan_id,
    );
    if (existing) {
      if (existing.status === "revoked" && subscription.status === "active") existing.status = "active";
      existing.expires_at = params.expires_at ?? subscription.expires_at;
      return { entitlement: cloudSkillEntitlementClone(existing), existed: true };
    }
    const entitlement: CloudSkillEntitlementRecord = {
      entitlement_id: `csent-${randomUUID()}`,
      subscription_id: subscription.subscription_id,
      tenant_id: tenantId,
      user_id: userId,
      skill_id: params.skill_id,
      plan_id: params.plan_id,
      status: subscription.status === "active" ? "active" : "revoked",
      expires_at: params.expires_at ?? subscription.expires_at,
      created_at: new Date().toISOString(),
    };
    this.cloudSkillEntitlements.set(entitlement.entitlement_id, entitlement);
    return { entitlement: cloudSkillEntitlementClone(entitlement), existed: false };
  }

  async getCloudSkillEntitlement(entitlementId: string): Promise<CloudSkillEntitlementRecord | undefined> {
    const entitlement = this.cloudSkillEntitlements.get(entitlementId);
    return entitlement ? cloudSkillEntitlementClone(entitlement) : undefined;
  }

  async listCloudSkillEntitlements(query: CloudSkillEntitlementQuery = {}): Promise<CloudSkillEntitlementRecord[]> {
    const userId = queryValue(query, "user_id", "userId");
    const tenantId = queryValue(query, "tenant_id", "tenantId");
    const skillId = queryValue(query, "skill_id", "skillId");
    const planId = queryValue(query, "plan_id", "planId");
    return [...this.cloudSkillEntitlements.values()]
      .filter((entitlement) =>
        (userId === undefined || entitlement.user_id === userId) &&
        (tenantId === undefined || entitlement.tenant_id === tenantId) &&
        (skillId === undefined || entitlement.skill_id === skillId) &&
        (planId === undefined || entitlement.plan_id === planId),
      )
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .map(cloudSkillEntitlementClone);
  }

  async revokeCloudSkillEntitlement(entitlementId: string): Promise<CloudSkillEntitlementRecord | undefined> {
    const entitlement = this.cloudSkillEntitlements.get(entitlementId);
    if (!entitlement) return undefined;
    entitlement.status = "revoked";
    return cloudSkillEntitlementClone(entitlement);
  }

  async resolveCloudSkillAccess(query: CloudSkillAccessQuery): Promise<CloudSkillAccessGrant | undefined> {
    const userId = queryValue(query, "user_id", "userId");
    const tenantId = queryValue(query, "tenant_id", "tenantId");
    const skillId = queryValue(query, "skill_id", "skillId");
    const allowed = query.allowed_plan_ids ?? query.allowedPlanIds;
    const now = query.now ?? new Date().toISOString();
    if (!userId || !tenantId || !skillId) return undefined;
    const candidates = [...this.cloudSkillEntitlements.values()]
      .filter((entitlement) =>
        entitlement.user_id === userId && entitlement.tenant_id === tenantId && entitlement.skill_id === skillId &&
        entitlement.status === "active" && entitlement.expires_at > now &&
        (allowed === undefined || allowed.includes(entitlement.plan_id)),
      )
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
    for (const entitlement of candidates) {
      const subscription = this.cloudSkillSubscriptions.get(entitlement.subscription_id);
      const plan = this.cloudSkillPlans.get(entitlement.plan_id);
      if (!subscription || !plan || subscription.plan_id !== entitlement.plan_id ||
        subscription.user_id !== userId || subscription.tenant_id !== tenantId ||
        subscription.status !== "active" || subscription.starts_at > now || subscription.expires_at <= now ||
        !plan.skill_ids.includes(skillId)) continue;
      return {
        ...cloudSkillEntitlementClone(entitlement),
        subscription: cloudSkillSubscriptionClone(subscription),
        plan: cloudSkillPlanClone(plan),
      };
    }
    return undefined;
  }

  async hasCloudSkillAccess(query: CloudSkillAccessQuery): Promise<boolean> {
    return (await this.resolveCloudSkillAccess(query)) !== undefined;
  }

  async upsertCloudAgentSkillBinding(
    params: CloudAgentSkillBindingUpsertRequest,
  ): Promise<{ binding: CloudAgentSkillBindingRecord; existed: boolean }> {
    // No await is used between lookup and mutation: one MemoryStore JS turn is
    // the atomic equivalent of PgStore's unique-key upsert.
    const ownerKey = cloudAgentSkillBindingKey(params);
    const existingId = this.cloudAgentSkillBindingByOwner.get(ownerKey);
    if (existingId !== undefined) {
      const existing = this.cloudAgentSkillBindings.get(existingId);
      if (!existing) {
        // Repair a stale reverse index rather than permanently denying this
        // owner tuple.
        this.cloudAgentSkillBindingByOwner.delete(ownerKey);
      } else {
        if (params.user_id !== undefined) existing.user_id = params.user_id;
        existing.status = "active";
        delete existing.revoked_at;
        return { binding: cloudAgentSkillBindingClone(existing), existed: true };
      }
    }

    const binding: CloudAgentSkillBindingRecord = {
      binding_id: `casb-${randomUUID()}`,
      tenant_id: params.tenant_id,
      device_id: params.device_id,
      ...(params.user_id === undefined ? {} : { user_id: params.user_id }),
      agent_id: params.agent_id,
      skill_id: params.skill_id,
      status: "active",
      created_at: new Date().toISOString(),
    };
    this.cloudAgentSkillBindings.set(binding.binding_id, binding);
    this.cloudAgentSkillBindingByOwner.set(ownerKey, binding.binding_id);
    return { binding: cloudAgentSkillBindingClone(binding), existed: false };
  }

  async resolveCloudAgentSkillBinding(
    query: CloudAgentSkillBindingResolveQuery,
  ): Promise<CloudAgentSkillBindingRecord | undefined> {
    const bindingId = this.cloudAgentSkillBindingByOwner.get(cloudAgentSkillBindingKey(query));
    const binding = bindingId === undefined ? undefined : this.cloudAgentSkillBindings.get(bindingId);
    if (!binding || binding.status !== "active") return undefined;
    // A binding without user_id can be inspected by a device-level caller,
    // but it must not silently authorize a user-scoped execution. Device-facing
    // enrollment always writes user_id; this fail-closed comparison prevents a
    // stale binding from surviving account rebinding/deletion.
    if (query.user_id !== undefined && binding.user_id !== query.user_id) {
      return undefined;
    }
    return cloudAgentSkillBindingClone(binding);
  }

  async revokeCloudAgentSkillBinding(bindingId: string): Promise<CloudAgentSkillBindingRecord | undefined> {
    const binding = this.cloudAgentSkillBindings.get(bindingId);
    if (!binding) return undefined;
    if (binding.status !== "revoked") {
      binding.status = "revoked";
      binding.revoked_at = new Date().toISOString();
    }
    return cloudAgentSkillBindingClone(binding);
  }

  async listCloudAgentSkillBindings(
    query: CloudAgentSkillBindingListQuery = {},
  ): Promise<CloudAgentSkillBindingRecord[]> {
    return [...this.cloudAgentSkillBindings.values()]
      .filter((binding) =>
        (query.tenant_id === undefined || binding.tenant_id === query.tenant_id) &&
        (query.device_id === undefined || binding.device_id === query.device_id) &&
        (query.user_id === undefined || binding.user_id === query.user_id) &&
        (query.agent_id === undefined || binding.agent_id === query.agent_id) &&
        (query.skill_id === undefined || binding.skill_id === query.skill_id) &&
        (query.status === undefined || binding.status === query.status),
      )
      .sort((left, right) => right.created_at.localeCompare(left.created_at) ||
        left.binding_id.localeCompare(right.binding_id))
      .map(cloudAgentSkillBindingClone);
  }

  /**
   * Admit one cloud Skill execution and create a short-lived concurrency lease.
   *
   * All work in this method is synchronous after entering the JS turn.  That is
   * intentional: unlike the ordinary query methods, admission must not yield
   * between checking a limit and recording the reservation in MemoryStore.
   * PgStore provides the equivalent transaction/row-lock guarantee.
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
    const nowMs = now.getTime();
    this.expireCloudSkillExecutionLeases(nowMs);

    const existingId = this.cloudSkillExecutionReservationsByTask.get(params.task_id);
    if (existingId !== undefined) {
      const existing = this.cloudSkillExecutionReservations.get(existingId);
      if (!existing) {
        // A stale reverse index is not a reason to fail closed forever.
        this.cloudSkillExecutionReservationsByTask.delete(params.task_id);
      } else {
        const sameBinding = existing.user_id === params.user_id &&
          existing.tenant_id === params.tenant_id &&
          existing.device_id === params.device_id &&
          existing.agent_id === params.agent_id &&
          existing.skill_id === params.skill_id &&
          existing.plan_id === params.plan_id &&
          (params.subscription_id === undefined || existing.subscription_id === params.subscription_id) &&
          existing.input_digest === params.input_digest;
        if (!sameBinding) return { ok: false, reason: "IDEMPOTENCY_CONFLICT" };
        // A retry returns the exact original lease.  In particular, do not
        // increment included_calls a second time or silently extend expiry.
        return { ok: true, reservation: cloudSkillExecutionReservationClone(existing) };
      }
    }

    const plan = this.cloudSkillPlans.get(params.plan_id);
    if (!plan) return { ok: false, reason: "PLAN_MISMATCH" };
    const subscriptions = [...this.cloudSkillSubscriptions.values()]
      .filter((subscription) =>
        subscription.plan_id === params.plan_id &&
        subscription.user_id === params.user_id &&
        subscription.tenant_id === params.tenant_id &&
        (params.subscription_id === undefined || subscription.subscription_id === params.subscription_id),
      )
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
    if (subscriptions.length === 0) return { ok: false, reason: "PLAN_MISMATCH" };
    const subscription = subscriptions[0]!;
    const subscriptionStarts = Date.parse(subscription.starts_at);
    const subscriptionExpires = Date.parse(subscription.expires_at);
    if (subscription.status !== "active" || !Number.isFinite(subscriptionStarts) ||
      !Number.isFinite(subscriptionExpires) || nowMs < subscriptionStarts || nowMs >= subscriptionExpires) {
      return { ok: false, reason: "SUBSCRIPTION_INACTIVE" };
    }
    if (!plan.skill_ids.includes(params.skill_id)) return { ok: false, reason: "SKILL_NOT_ENTITLED" };
    const entitlement = [...this.cloudSkillEntitlements.values()]
      .filter((candidate) =>
        candidate.subscription_id === subscription.subscription_id &&
        candidate.tenant_id === params.tenant_id &&
        candidate.user_id === params.user_id &&
        candidate.skill_id === params.skill_id &&
        candidate.plan_id === params.plan_id &&
        candidate.status === "active" &&
        Date.parse(candidate.expires_at) > nowMs,
      )
      .sort((left, right) => right.created_at.localeCompare(left.created_at))[0];
    if (!entitlement) return { ok: false, reason: "SKILL_NOT_ENTITLED" };

    const subscriptionRows = [...this.cloudSkillExecutionReservations.values()]
      .filter((reservation) => reservation.subscription_id === subscription.subscription_id);
    // Included calls are a subscription+Skill allowance.  A plan containing
    // two Skills must not let traffic to one Skill consume the other's cycle
    // allowance.
    const cycleCalls = subscriptionRows.filter((reservation) => {
      const reservedAt = Date.parse(reservation.reserved_at);
      return reservation.skill_id === params.skill_id && Number.isFinite(reservedAt) &&
        reservedAt >= subscriptionStarts && reservedAt <= nowMs;
    }).length;
    if (cycleCalls >= plan.included_calls) return { ok: false, reason: "QUOTA_EXCEEDED" };

    const minuteStartMs = Math.floor(nowMs / 60_000) * 60_000;
    // Rate and concurrency are per calling device (within a subscription),
    // shared by all Agents on that device to prevent an Agent fan-out bypass.
    const ownerRows = subscriptionRows.filter((reservation) =>
      reservation.tenant_id === params.tenant_id &&
      reservation.user_id === params.user_id &&
      reservation.device_id === params.device_id,
    );
    const minuteCalls = ownerRows.filter((reservation) => {
      const reservedAt = Date.parse(reservation.reserved_at);
      return Number.isFinite(reservedAt) && reservedAt >= minuteStartMs && reservedAt <= nowMs;
    }).length;
    if (minuteCalls >= plan.requests_per_minute) {
      return {
        ok: false,
        reason: "RATE_LIMITED",
        retry_after_seconds: Math.max(1, Math.ceil((minuteStartMs + 60_000 - nowMs) / 1000)),
      };
    }

    const active = ownerRows.filter((reservation) => {
      const expiresAt = Date.parse(reservation.lease_expires_at);
      return reservation.released_at === undefined && Number.isFinite(expiresAt) && expiresAt > nowMs;
    });
    if (active.length >= plan.max_concurrency) {
      const nextExpiry = Math.min(...active.map((reservation) => Date.parse(reservation.lease_expires_at)));
      return {
        ok: false,
        reason: "CONCURRENCY_LIMIT",
        retry_after_seconds: retryAfterSeconds(nextExpiry, nowMs),
      };
    }

    const reservation: CloudSkillExecutionReservation = {
      reservation_id: `csres-${randomUUID()}`,
      task_id: params.task_id,
      user_id: params.user_id,
      tenant_id: params.tenant_id,
      device_id: params.device_id,
      agent_id: params.agent_id,
      skill_id: params.skill_id,
      plan_id: params.plan_id,
      subscription_id: subscription.subscription_id,
      ...(params.input_digest === undefined ? {} : { input_digest: params.input_digest }),
      period_start: new Date(subscriptionStarts).toISOString(),
      reserved_at: now.toISOString(),
      lease_expires_at: new Date(nowMs + leaseTtlMs).toISOString(),
    };
    this.cloudSkillExecutionReservations.set(reservation.reservation_id, reservation);
    this.cloudSkillExecutionReservationsByTask.set(reservation.task_id, reservation.reservation_id);
    return { ok: true, reservation: cloudSkillExecutionReservationClone(reservation) };
  }

  async releaseCloudSkillExecution(
    params: CloudSkillExecutionReleaseRequest,
  ): Promise<CloudSkillExecutionReleaseResult> {
    const now = parseExecutionNow(params.now);
    if (!now || (!params.reservation_id && !params.task_id)) return { released: false };
    const nowMs = now.getTime();
    this.expireCloudSkillExecutionLeases(nowMs);
    const reservationId = params.reservation_id ?? this.cloudSkillExecutionReservationsByTask.get(params.task_id!);
    if (!reservationId) return { released: false };
    const reservation = this.cloudSkillExecutionReservations.get(reservationId);
    if (!reservation) return { released: false };
    if ((params.task_id !== undefined && reservation.task_id !== params.task_id) ||
      (params.user_id !== undefined && reservation.user_id !== params.user_id) ||
      (params.tenant_id !== undefined && reservation.tenant_id !== params.tenant_id)) {
      return { released: false };
    }
    if (reservation.released_at !== undefined) {
      return { released: false, reservation: cloudSkillExecutionReservationClone(reservation) };
    }
    reservation.released_at = now.toISOString();
    return { released: true, reservation: cloudSkillExecutionReservationClone(reservation) };
  }

  async getCloudSkillOperationalSummary(nowValue?: string): Promise<CloudSkillOperationalSummary> {
    const now = parseExecutionNow(nowValue);
    if (!now) throw new Error("INVALID_CLOUD_SKILL_OPERATIONAL_TIME");
    const nowMs = now.getTime();
    const cutoffMs = nowMs - 24 * 60 * 60_000;
    const activeSubscriptions = new Map<string, number>();
    for (const subscription of this.cloudSkillSubscriptions.values()) {
      if (subscription.status === "active" && Date.parse(subscription.starts_at) <= nowMs &&
        Date.parse(subscription.expires_at) > nowMs) {
        activeSubscriptions.set(subscription.plan_id, (activeSubscriptions.get(subscription.plan_id) ?? 0) + 1);
      }
    }

    const skills: CloudSkillOperationalMetric[] = [];
    for (const plan of [...this.cloudSkillPlans.values()].sort((left, right) => left.plan_id.localeCompare(right.plan_id))) {
      for (const skillId of [...plan.skill_ids].sort()) {
        const rows = [...this.cloudSkillExecutionReservations.values()]
          .filter((reservation) => reservation.plan_id === plan.plan_id && reservation.skill_id === skillId);
        const windowRows = rows.filter((reservation) => {
          const reservedAt = Date.parse(reservation.reserved_at);
          return Number.isFinite(reservedAt) && reservedAt >= cutoffMs && reservedAt <= nowMs;
        });
        const statusCount = (statuses: readonly CloudTaskStatus[]): number => windowRows.filter((reservation) => {
          const task = this.tasks.get(reservation.task_id);
          return task !== undefined && statuses.includes(task.status);
        }).length;
        skills.push({
          plan_id: plan.plan_id,
          skill_id: skillId,
          calls: windowRows.length,
          active_concurrency: rows.filter((reservation) => reservation.released_at === undefined &&
            Date.parse(reservation.lease_expires_at) > nowMs).length,
          succeeded: statusCount(["succeeded"]),
          failed: statusCount(["failed", "timed_out"]),
          cancelled: statusCount(["cancelled"]),
          active_subscriptions: activeSubscriptions.get(plan.plan_id) ?? 0,
          included_calls_per_subscription: plan.included_calls,
        });
      }
    }
    return { window_hours: 24, generated_at: now.toISOString(), skills };
  }

  /** Mark expired leases as no longer consuming concurrency, retaining rows for usage accounting. */
  private expireCloudSkillExecutionLeases(nowMs: number): void {
    const now = new Date(nowMs).toISOString();
    for (const reservation of this.cloudSkillExecutionReservations.values()) {
      if (reservation.released_at !== undefined) continue;
      const expiresAt = Date.parse(reservation.lease_expires_at);
      if (Number.isFinite(expiresAt) && expiresAt <= nowMs) reservation.released_at = now;
    }
  }

  async grantEntitlement(params: {
    tenant_id: string;
    device_id: string;
    pack_id: string;
    scope?: "tenant" | "user" | "device";
    expires_at?: string;
    source_order_id?: string;
  }): Promise<EntitlementRecord> {
    if (params.source_order_id) {
      const existing = [...this.entitlements.values()].find((entitlement) =>
        entitlement.source_order_id === params.source_order_id && entitlement.device_id === params.device_id &&
        entitlement.pack_id === params.pack_id,
      );
      if (existing) {
        Object.assign(existing, {
          tenant_id: params.tenant_id,
          scope: params.scope ?? "device",
          status: "active",
          expires_at: params.expires_at ?? FAR_FUTURE,
        });
        return existing;
      }
    }
    const record: EntitlementRecord = {
      entitlement_id: `ent-${randomUUID()}`,
      tenant_id: params.tenant_id,
      device_id: params.device_id,
      pack_id: params.pack_id,
      scope: params.scope ?? "device",
      status: "active",
      expires_at: params.expires_at ?? FAR_FUTURE,
      source_order_id: params.source_order_id,
      created_at: new Date().toISOString(),
    };
    this.entitlements.set(record.entitlement_id, record);
    return record;
  }

  async revokeEntitlement(entitlementId: string): Promise<EntitlementRecord | undefined> {
    const record = this.entitlements.get(entitlementId);
    if (!record) return undefined;
    record.status = "revoked";
    return record;
  }

  async listEntitlements(deviceId: string): Promise<EntitlementRecord[]> {
    return [...this.entitlements.values()].filter((e) => e.device_id === deviceId);
  }

  async publishRelease(params: {
    pack: PackFile;
    digest: string;
    signature_key_id: string;
  }): Promise<{ release: PackReleaseRecord; existed: boolean }> {
    const { id, version, minManagerVersion } = params.pack.manifest.pack;
    const key = `${id}@${version}`;
    const existing = this.releases.get(key);
    if (existing) return { release: existing, existed: true };
    const release: PackReleaseRecord = {
      pack_id: id,
      version,
      status: "active",
      pack: params.pack,
      digest: params.digest,
      signature_key_id: params.signature_key_id,
      min_desktop_version: minManagerVersion,
      created_at: new Date().toISOString(),
    };
    this.releases.set(key, release);
    return { release, existed: false };
  }

  async getRelease(packId: string, version: string): Promise<PackReleaseRecord | undefined> {
    return this.releases.get(`${packId}@${version}`);
  }

  async listReleases(packId?: string): Promise<PackReleaseRecord[]> {
    return [...this.releases.values()].filter((r) => packId === undefined || r.pack_id === packId);
  }

  async revokeRelease(packId: string, version: string): Promise<PackReleaseRecord | undefined> {
    const release = this.releases.get(`${packId}@${version}`);
    if (!release) return undefined;
    release.status = "revoked";
    return release;
  }

  async publishSkillRelease(params: {
    package: SkillPackage;
    digest: string;
    signature_key_id: string;
  }): Promise<{ release: SkillReleaseRecord; existed: boolean }> {
    const skill = params.package.skill;
    const key = `${skill.id}@${skill.version}`;
    const existing = this.skillReleases.get(key);
    if (existing) return { release: structuredClone(existing), existed: true };
    const release: SkillReleaseRecord = {
      skill_id: skill.id,
      version: skill.version,
      publisher_namespace: skill.publisher.namespace,
      status: "active",
      package: structuredClone(params.package),
      digest: params.digest,
      signature_key_id: params.signature_key_id,
      min_desktop_version: params.package.compatibility.minManagerVersion,
      openclaw_version: params.package.compatibility.openclawVersion,
      runtime_kind: params.package.runtime.kind,
      created_at: new Date().toISOString(),
    };
    this.skillReleases.set(key, release);
    return { release: structuredClone(release), existed: false };
  }

  async getSkillRelease(skillId: string, version: string): Promise<SkillReleaseRecord | undefined> {
    const release = this.skillReleases.get(`${skillId}@${version}`);
    return release ? structuredClone(release) : undefined;
  }

  async listSkillReleases(skillId?: string): Promise<SkillReleaseRecord[]> {
    return [...this.skillReleases.values()]
      .filter((release) => skillId === undefined || release.skill_id === skillId)
      .map((release) => structuredClone(release));
  }

  async revokeSkillRelease(skillId: string, version: string): Promise<SkillReleaseRecord | undefined> {
    const release = this.skillReleases.get(`${skillId}@${version}`);
    if (!release) return undefined;
    release.status = "revoked";
    release.revoked_at = new Date().toISOString();
    return structuredClone(release);
  }

  async publishCloudSkillAdapterRelease(params: {
    manifest: CloudSkillAdapterReleaseRecord["manifest"];
    files: Record<string, string>;
    digest: string;
    signature_key_id: string;
  }): Promise<{ release: CloudSkillAdapterReleaseRecord; existed: boolean }> {
    const skillId = params.manifest.skill_id;
    const version = params.manifest.version;
    const key = `${skillId}@${version}`;
    const existing = this.cloudSkillAdapterReleases.get(key);
    if (existing) return { release: structuredClone(existing), existed: true };
    const release: CloudSkillAdapterReleaseRecord = {
      skill_id: skillId,
      version,
      status: "active",
      manifest: structuredClone(params.manifest),
      files: { ...params.files },
      digest: params.digest,
      signature_key_id: params.signature_key_id,
      min_manager_version: params.manifest.compatibility.manager_min_version,
      openclaw_version: params.manifest.compatibility.openclaw_version,
      created_at: new Date().toISOString(),
    };
    this.cloudSkillAdapterReleases.set(key, release);
    return { release: structuredClone(release), existed: false };
  }

  async getCloudSkillAdapterRelease(skillId: string, version: string): Promise<CloudSkillAdapterReleaseRecord | undefined> {
    const release = this.cloudSkillAdapterReleases.get(`${skillId}@${version}`);
    return release ? structuredClone(release) : undefined;
  }

  async listCloudSkillAdapterReleases(skillId?: string): Promise<CloudSkillAdapterReleaseRecord[]> {
    return [...this.cloudSkillAdapterReleases.values()]
      .filter((release) => skillId === undefined || release.skill_id === skillId)
      .map((release) => structuredClone(release));
  }

  async revokeCloudSkillAdapterRelease(skillId: string, version: string): Promise<CloudSkillAdapterReleaseRecord | undefined> {
    const release = this.cloudSkillAdapterReleases.get(`${skillId}@${version}`);
    if (!release) return undefined;
    release.status = "revoked";
    release.revoked_at = new Date().toISOString();
    return structuredClone(release);
  }

  async getModelGatewayConfig(configId = "default"): Promise<ModelGatewayConfigRecord | undefined> {
    const config = this.modelGatewayConfigs.get(configId);
    return config ? structuredClone(config) : undefined;
  }

  async listModelGatewayConfigs(): Promise<ModelGatewayConfigRecord[]> {
    return [...this.modelGatewayConfigs.values()].map((config) => structuredClone(config));
  }

  async setModelGatewayConfig(config: ModelGatewayConfigRecord): Promise<ModelGatewayConfigRecord> {
    this.modelGatewayConfigs.set(config.config_id, structuredClone(config));
    return structuredClone(config);
  }

  async listFeaturePolicies(): Promise<FeaturePolicyRecord[]> {
    return [...this.featurePolicies.values()]
      .sort((left, right) => left.policy_id.localeCompare(right.policy_id))
      .map((record) => structuredClone(record));
  }

  async upsertFeaturePolicy(policy: FeaturePolicyRecord["policy"]): Promise<FeaturePolicyRecord> {
    const key = [
      policy.feature_id,
      policy.audience,
      policy.scope,
      policy.scope_id ?? "",
    ].join("\u0000");
    const current = this.featurePolicies.get(key);
    if (!current && this.featurePolicies.size >= FEATURE_POLICY_MAX_FEATURES) {
      throw new FeaturePolicyCapacityError();
    }
    const record: FeaturePolicyRecord = {
      policy_id: current?.policy_id ?? "fp-" + randomUUID(),
      policy: structuredClone(policy),
      revision: ++this.featurePolicyRevision,
      updated_at: new Date().toISOString(),
    };
    this.featurePolicies.set(key, record);
    return structuredClone(record);
  }

  async incrementClientTelemetry(records: readonly ClientTelemetryAggregateRecord[]): Promise<void> {
    for (const record of records) {
      const key = [
        record.bucket_start, record.event_type, record.manager_version, record.openclaw_version,
        record.platform, record.architecture, record.value, record.agent_count_bucket,
      ].join("\u0000");
      const existing = this.clientTelemetry.get(key);
      if (existing) existing.count += record.count;
      else this.clientTelemetry.set(key, { ...record });
    }
  }

  async listClientTelemetry(): Promise<ClientTelemetryAggregateRecord[]> {
    return [...this.clientTelemetry.values()].map((record) => ({ ...record }));
  }

  async incrementModelRequestMetrics(records: readonly ModelRequestAggregateRecord[]): Promise<void> {
    for (const record of records) {
      const key = [record.bucket_start, record.api_type, record.outcome, record.latency_bucket].join("\u0000");
      const existing = this.modelRequestMetrics.get(key);
      if (existing) existing.count += record.count;
      else this.modelRequestMetrics.set(key, { ...record });
    }
  }

  async listModelRequestMetrics(): Promise<ModelRequestAggregateRecord[]> {
    return [...this.modelRequestMetrics.values()].map((record) => ({ ...record }));
  }

  async incrementHttpRouteMetrics(records: readonly HttpRouteMetricRecord[]): Promise<void> {
    for (const record of records) {
      const key = [record.bucket_start, record.route_id, record.status_class, record.latency_bucket].join("\u0000");
      const existing = this.httpRouteMetrics.get(key);
      if (existing) existing.count += record.count;
      else this.httpRouteMetrics.set(key, { ...record });
    }
  }

  async listHttpRouteMetrics(): Promise<HttpRouteMetricRecord[]> {
    return [...this.httpRouteMetrics.values()].map((record) => ({ ...record }));
  }

  async recordFeaturePolicyEmergencyObservation(
    record: FeaturePolicyEmergencyObservationRecord,
  ): Promise<boolean> {
    const key = `${record.policy_id}\u0000${record.revision}`;
    if (this.emergencyObservations.has(key)) return false;
    this.emergencyObservations.set(key, { ...record });
    return true;
  }

  async listFeaturePolicyEmergencyObservations(): Promise<FeaturePolicyEmergencyObservationRecord[]> {
    return [...this.emergencyObservations.values()].map((record) => ({ ...record }));
  }

  async incrementModelUsage(records: readonly ModelUsageAggregateRecord[]): Promise<void> {
    for (const record of records) {
      const key = [record.period_start, record.period, record.tenant_id, record.device_id, record.config_id].join("\u0000");
      const current = this.modelUsage.get(key);
      if (!current) this.modelUsage.set(key, { ...record });
      else for (const field of ["request_count", "success_count", "error_count", "input_tokens", "output_tokens", "cache_tokens", "estimated_tokens", "cost_microunits"] as const) current[field] += record[field];
    }
  }

  async listModelUsage(): Promise<ModelUsageAggregateRecord[]> {
    return [...this.modelUsage.values()].map((record) => ({ ...record }));
  }

  async createKnowledgeDocument(params: Omit<KnowledgeDocumentRecord, "document_id" | "created_at">): Promise<KnowledgeDocumentRecord> {
    const record = { ...params, document_id: `doc-${randomUUID()}`, created_at: new Date().toISOString() };
    this.knowledgeDocuments.set(record.document_id, record);
    return { ...record };
  }

  async listKnowledgeDocuments(tenantId: string): Promise<KnowledgeDocumentRecord[]> {
    return [...this.knowledgeDocuments.values()].filter((record) => record.tenant_id === tenantId).map((record) => ({ ...record }));
  }

  async deleteKnowledgeDocument(documentId: string): Promise<KnowledgeDocumentRecord | undefined> {
    const record = this.knowledgeDocuments.get(documentId);
    if (record) this.knowledgeDocuments.delete(documentId);
    return record ? { ...record } : undefined;
  }

  async createPackReview(params: { publisher: string; pack: PackFile; findings: string[] }): Promise<PackReviewRecord> {
    const now = new Date().toISOString();
    const record: PackReviewRecord = { review_id: `review-${randomUUID()}`, publisher: params.publisher, pack: structuredClone(params.pack), status: params.findings.length ? "rejected" : "submitted", findings: [...params.findings], created_at: now, updated_at: now };
    this.packReviews.set(record.review_id, record); return structuredClone(record);
  }
  async getPackReview(reviewId: string): Promise<PackReviewRecord | undefined> { const value = this.packReviews.get(reviewId); return value ? structuredClone(value) : undefined; }
  async listPackReviews(): Promise<PackReviewRecord[]> { return [...this.packReviews.values()].map((value) => structuredClone(value)); }
  async updatePackReview(reviewId: string, patch: Pick<PackReviewRecord, "status" | "findings">): Promise<PackReviewRecord | undefined> { const value = this.packReviews.get(reviewId); if (!value) return undefined; Object.assign(value, patch, { updated_at: new Date().toISOString() }); return structuredClone(value); }

  async close(): Promise<void> {
    // 内存实现无需释放资源
  }

  private emit(taskId: string, type: string, extra?: Record<string, unknown>): void {
    const event: CloudTaskEvent = {
      event_id: String(++this.eventSeq),
      task_id: taskId,
      type,
      ts: new Date().toISOString(),
      ...extra,
    };
    this.eventsByTask.get(taskId)?.push(event);
    this.listeners.get(taskId)?.forEach((l) => l(event));
  }

  private mustGet(taskId: string): CloudTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    return task;
  }
}
