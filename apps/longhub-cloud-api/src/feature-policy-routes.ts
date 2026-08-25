import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  FEATURE_POLICY_MAX_BYTES,
  FEATURE_POLICY_MAX_FEATURES,
  FEATURE_POLICY_MAX_VALIDITY_MS,
  FEATURE_POLICY_REFRESH_INTERVAL_MS,
  FeaturePolicyValidationError,
  compareSemver,
  decideFeatureAccess,
  parseFeaturePolicyDocument,
  parseFeaturePolicyEntry,
  resolveFeaturePolicy,
  type FeatureId,
  type FeatureAccessDenialReason,
  type FeaturePolicyDocument,
  type FeaturePolicyEntry,
} from "@longhub/feature-policy";
import { requireAdmin, type AdminRouteContext } from "./admin-routes.js";
import { readJson, sendError, sendJson } from "./http-util.js";
import {
  FeaturePolicyCapacityError,
  type CloudStore,
  type DeviceRecord,
  type FeaturePolicyRecord,
} from "./store.js";

const MANAGER_VERSION_HEADER = "x-longhub-manager-version";

export interface FeaturePolicyRouteContext {
  store: CloudStore;
  admin: AdminRouteContext;
  /** Only compatibility fixtures may consult retired Pack entitlements. */
  legacySurfaceEnabled?: boolean;
  authenticateDevice(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<DeviceRecord | undefined>;
}

type DevicePolicyContext = {
  readonly document: FeaturePolicyDocument;
  readonly planIds: readonly string[];
  readonly entitlementIds: readonly string[];
  readonly records: readonly FeaturePolicyRecord[];
};

function recordKey(record: FeaturePolicyRecord): string {
  const policy = record.policy;
  return [
    policy.feature_id,
    policy.audience,
    policy.scope,
    policy.scope_id ?? "",
  ].join("\u0000");
}

function reportedManagerVersion(req: IncomingMessage): string | undefined {
  const value = req.headers[MANAGER_VERSION_HEADER];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 64) {
    throw new FeaturePolicyValidationError("客户端版本请求头无效");
  }
  try {
    compareSemver(value, value);
  } catch {
    throw new FeaturePolicyValidationError("客户端版本请求头无效");
  }
  return value;
}

function isSameTarget(left: FeaturePolicyEntry, right: FeaturePolicyEntry): boolean {
  return left.feature_id === right.feature_id
    && left.audience === right.audience
    && left.scope === right.scope
    && left.scope_id === right.scope_id;
}

async function devicePlans(store: CloudStore, device: DeviceRecord, now = new Date()): Promise<readonly string[]> {
  if (!device.user_id) return [];
  const ids = (await store.listCloudSkillSubscriptions(device.user_id))
    .filter((subscription) => subscription.tenant_id === device.tenant_id &&
      subscription.status === "active" &&
      Date.parse(subscription.starts_at) <= now.getTime() &&
      Date.parse(subscription.expires_at) > now.getTime())
    .map((subscription) => subscription.plan_id);
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right, "en"));
}

async function deviceEntitlements(
  store: CloudStore,
  device: DeviceRecord,
  planIds: readonly string[],
  now: Date,
  includeLegacyEntitlements: boolean,
): Promise<readonly string[]> {
  const packs = includeLegacyEntitlements
    ? (await store.listEntitlements(device.device_id))
      .filter((entry) => entry.status === "active" && Date.parse(entry.expires_at) > now.getTime())
      .map((entry) => "pack:" + entry.pack_id)
    : [];
  const cloud = device.user_id
    ? (await store.listCloudSkillEntitlements({ user_id: device.user_id, tenant_id: device.tenant_id }))
      .filter((entry) => entry.status === "active" && Date.parse(entry.expires_at) > now.getTime())
      .flatMap((entry) => [`plan:${entry.plan_id}`, `skill:${entry.skill_id}`])
    : [];
  return [...new Set([...packs, ...planIds.map((planId) => "plan:" + planId), ...cloud])]
    .sort((left, right) => left.localeCompare(right, "en"));
}

function relevantPolicies(
  records: readonly FeaturePolicyRecord[],
  device: DeviceRecord,
  planIds: readonly string[],
): readonly FeaturePolicyRecord[] {
  const planSet = new Set(planIds);
  return records
    .filter((record) => {
      const policy = record.policy;
      if (policy.audience !== "user") return false;
      if (policy.scope === "global" || policy.scope === "agent") return true;
      if (policy.scope === "tenant") return policy.scope_id === device.tenant_id;
      if (policy.scope === "device") return policy.scope_id === device.device_id;
      return policy.scope_id !== undefined && planSet.has(policy.scope_id);
    })
    .sort((left, right) => recordKey(left).localeCompare(recordKey(right), "en"));
}

export async function buildDeviceFeaturePolicy(
  store: CloudStore,
  device: DeviceRecord,
  now = new Date(),
  includeLegacyEntitlements = true,
): Promise<DevicePolicyContext> {
  const planIds = await devicePlans(store, device, now);
  const records = relevantPolicies(await store.listFeaturePolicies(), device, planIds);
  if (records.length > FEATURE_POLICY_MAX_FEATURES) {
    throw new FeaturePolicyValidationError("适用策略超过客户端契约上限");
  }
  const versionMaterial = records.map((record) => ({
    policy_id: record.policy_id,
    revision: record.revision,
    policy: record.policy,
  }));
  const digest = createHash("sha256")
    .update(JSON.stringify(versionMaterial))
    .digest("base64url")
    .slice(0, 20);
  const highestRevision = records.reduce(
    (highest, record) => Math.max(highest, record.revision),
    0,
  );
  const issuedAtMs =
    Math.floor(now.getTime() / FEATURE_POLICY_REFRESH_INTERVAL_MS)
      * FEATURE_POLICY_REFRESH_INTERVAL_MS;
  const issuedAt = new Date(issuedAtMs).toISOString();
  const document = parseFeaturePolicyDocument({
    schema_version: "longhub/feature-policy/v2",
    policy_version: "fp-" + highestRevision + "-" + digest,
    issued_at: issuedAt,
    expires_at: new Date(issuedAtMs + FEATURE_POLICY_MAX_VALIDITY_MS).toISOString(),
    features: records.map((record) => record.policy),
  });
  return {
    document,
    planIds,
    entitlementIds: await deviceEntitlements(store, device, planIds, now, includeLegacyEntitlements),
    records,
  };
}

export type DeviceFeaturePolicyCheck =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: FeatureAccessDenialReason | "POLICY_UNAVAILABLE" };

/**
 * Evaluate a device policy without writing an HTTP response.  The task
 * runner uses this immediately before crossing into the private Executor so
 * an emergency disable or policy update racing with task creation still
 * fails closed.  `allowWhenMissing` is intentionally explicit: Cloud Skill
 * execution keeps its independent subscription gate when no execution policy
 * has been published yet.
 */
export async function checkDeviceFeaturePolicy(
  ctx: Pick<FeaturePolicyRouteContext, "store" | "legacySurfaceEnabled">,
  device: DeviceRecord,
  featureId: FeatureId,
  options: {
    readonly allowWhenMissing: boolean;
    readonly trustedPermissions?: readonly string[];
  },
): Promise<DeviceFeaturePolicyCheck> {
  try {
    const built = await buildDeviceFeaturePolicy(
      ctx.store,
      device,
      new Date(),
      ctx.legacySurfaceEnabled === true,
    );
    const resolved = resolveFeaturePolicy(built.document, featureId, {
      manager_version: device.app_version,
      audience: "user",
      scope_ids: {
        tenant: device.tenant_id,
        plan: built.planIds,
        device: device.device_id,
      },
    });
    if (resolved === undefined && options.allowWhenMissing) return { allowed: true };
    const decision = decideFeatureAccess(resolved, {
      entitlements: built.entitlementIds,
      permissions: options.trustedPermissions ?? [],
    });
    return decision.allowed ? { allowed: true } : { allowed: false, reason: decision.reason };
  } catch {
    return { allowed: false, reason: "POLICY_UNAVAILABLE" };
  }
}

export async function enforceDeviceFeaturePolicy(
  ctx: Pick<FeaturePolicyRouteContext, "store" | "legacySurfaceEnabled">,
  device: DeviceRecord,
  res: ServerResponse,
  featureId: FeatureId,
  options: {
    readonly allowWhenMissing: boolean;
    readonly trustedPermissions?: readonly string[];
  },
): Promise<boolean> {
  let resolved;
  let entitlementIds: readonly string[];
  let emergencyRecords: readonly FeaturePolicyRecord[] = [];
  try {
    const built = await buildDeviceFeaturePolicy(
      ctx.store,
      device,
      new Date(),
      ctx.legacySurfaceEnabled === true,
    );
    entitlementIds = built.entitlementIds;
    emergencyRecords = built.records.filter((record) => {
      const policy = record.policy;
      return policy.feature_id === featureId
        && policy.emergency_disabled;
    });
    resolved = resolveFeaturePolicy(built.document, featureId, {
      manager_version: device.app_version,
      audience: "user",
      scope_ids: {
        tenant: device.tenant_id,
        plan: built.planIds,
        device: device.device_id,
      },
    });
  } catch (error) {
    sendError(
      res,
      503,
      "FEATURE_POLICY_UNAVAILABLE",
      error instanceof FeaturePolicyValidationError ? "功能策略当前无效" : "功能策略当前不可用",
      true,
    );
    return false;
  }

  if (resolved === undefined && options.allowWhenMissing) return true;
  const decision = decideFeatureAccess(resolved, {
    entitlements: entitlementIds,
    permissions: options.trustedPermissions ?? [],
  });
  if (decision.allowed) return true;
  if (decision.reason === "EMERGENCY_DISABLED") {
    const enforcedAt = new Date();
    for (const record of emergencyRecords) {
      void ctx.store.recordFeaturePolicyEmergencyObservation({
        policy_id: record.policy_id,
        revision: record.revision,
        feature_id: record.policy.feature_id,
        policy_updated_at: record.updated_at,
        first_enforced_at: enforcedAt.toISOString(),
        latency_ms: Math.max(0, enforcedAt.getTime() - Date.parse(record.updated_at)),
      }).catch(() => undefined);
    }
    sendError(res, 503, "FEATURE_EMERGENCY_DISABLED", "该功能已紧急停用", true);
    return false;
  }
  if (decision.reason === "MISSING_ENTITLEMENT" || decision.reason === "MISSING_PERMISSION") {
    sendError(res, 403, "FEATURE_ACCESS_DENIED", "当前设备未满足功能授权条件");
    return false;
  }
  sendError(res, 403, "FEATURE_DISABLED", "该功能当前未开放");
  return false;
}

export async function handleFeaturePolicyRoutes(
  ctx: FeaturePolicyRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/v1/client/feature-policy") {
    let device = await ctx.authenticateDevice(req, res);
    if (!device) return true;
    let managerVersion: string | undefined;
    try {
      managerVersion = reportedManagerVersion(req);
    } catch (error) {
      sendError(
        res,
        422,
        "INVALID_MANAGER_VERSION",
        error instanceof FeaturePolicyValidationError ? error.message : "客户端版本请求头无效",
      );
      return true;
    }
    try {
      if (managerVersion !== undefined && managerVersion !== device.app_version) {
        const updated = await ctx.store.updateDeviceVersion(device.device_id, managerVersion);
        if (!updated) {
          sendError(res, 403, "DEVICE_NOT_FOUND", "设备不存在或已失效");
          return true;
        }
        device = updated;
      }
      const { document } = await buildDeviceFeaturePolicy(
        ctx.store,
        device,
        new Date(),
        ctx.legacySurfaceEnabled === true,
      );
      const etag = "W/\"" + createHash("sha256")
        .update(document.policy_version + "\n" + document.issued_at)
        .digest("base64url") + "\"";
      res.setHeader("cache-control", "private, no-store");
      res.setHeader("etag", etag);
      if (req.headers["if-none-match"] === etag) {
        res.statusCode = 304;
        res.end();
      } else {
        sendJson(res, 200, document);
      }
    } catch {
      sendError(res, 503, "FEATURE_POLICY_UNAVAILABLE", "功能策略当前不可用", true);
    }
    return true;
  }

  if (url.pathname === "/v1/admin/feature-policies" && req.method === "GET") {
    if (!(await requireAdmin(ctx.admin, req, res, { write: false }))) return true;
    sendJson(res, 200, { policies: await ctx.store.listFeaturePolicies() });
    return true;
  }

  if (url.pathname === "/v1/admin/feature-policies" && req.method === "POST") {
    const identity = await requireAdmin(ctx.admin, req, res, { write: true });
    if (!identity) return true;
    const body = await readJson<Record<string, unknown>>(req, res, FEATURE_POLICY_MAX_BYTES);
    if (!body) return true;
    try {
      if (
        typeof body !== "object"
        || body === null
        || Array.isArray(body)
        || Object.keys(body).length !== 1
        || !("policy" in body)
      ) {
        throw new FeaturePolicyValidationError("管理请求只允许 policy 字段");
      }
      const policy = parseFeaturePolicyEntry((body as { policy: unknown }).policy);
      const current = await ctx.store.listFeaturePolicies();
      const existing = current.find((record) => isSameTarget(record.policy, policy));
      if (!existing && current.length >= FEATURE_POLICY_MAX_FEATURES) {
        sendError(res, 409, "FEATURE_POLICY_CAPACITY", "策略数量已达到契约上限");
        return true;
      }
      const saved = await ctx.store.upsertFeaturePolicy(policy);
      await ctx.store.appendAudit(identity.actor, "feature_policy.upsert", {
        policy_id: saved.policy_id,
        feature_id: policy.feature_id,
        audience: policy.audience,
        scope: policy.scope,
        scope_id: policy.scope_id,
        revision: saved.revision,
        emergency_disabled: policy.emergency_disabled,
      });
      sendJson(res, existing ? 200 : 201, { policy: saved });
    } catch (error) {
      if (error instanceof FeaturePolicyCapacityError) {
        sendError(res, 409, error.code, error.message);
        return true;
      }
      sendError(
        res,
        422,
        "FEATURE_POLICY_INVALID",
        error instanceof FeaturePolicyValidationError ? error.message : "策略请求无效",
      );
    }
    return true;
  }

  return false;
}
