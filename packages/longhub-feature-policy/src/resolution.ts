import {
  FEATURE_LIMIT_KEYS,
  FEATURE_POLICY_MODES,
  FEATURE_PROCESSING_LOCATIONS,
  type FeatureDataPolicy,
  type FeatureId,
  type FeatureLimits,
  type FeaturePolicyAudience,
  type FeaturePolicyDocument,
  type FeaturePolicyEntry,
  type FeaturePolicyMode,
  type FeaturePolicyScope,
  type FeatureProcessingLocation,
  type FeatureRiskLevel,
} from "./schema.js";

type TargetedScope = Exclude<FeaturePolicyScope, "global">;

export interface FeaturePolicyContext {
  readonly manager_version: string;
  readonly audience: FeaturePolicyAudience;
  readonly scope_ids: Readonly<
    Partial<Record<TargetedScope, string | readonly string[]>>
  >;
  readonly now?: Date;
}

export interface ResolvedFeaturePolicy {
  readonly feature_id: FeatureId;
  readonly policy_version: string;
  readonly enabled: boolean;
  readonly emergency_disabled: boolean;
  readonly mode: FeaturePolicyMode;
  readonly risk_level: FeatureRiskLevel;
  readonly limits: FeatureLimits;
  readonly data_policy: FeatureDataPolicy;
  readonly required_entitlements: readonly string[];
  readonly required_permissions: readonly string[];
  readonly applied_scopes: readonly string[];
}

export type FeatureAccessDenialReason =
  | "POLICY_NOT_FOUND"
  | "FEATURE_DISABLED"
  | "EMERGENCY_DISABLED"
  | "MISSING_ENTITLEMENT"
  | "MISSING_PERMISSION";

export type FeatureAccessDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: FeatureAccessDenialReason;
      readonly missing?: readonly string[];
    };

export class FeaturePolicyUnavailableError extends Error {
  readonly code = "FEATURE_POLICY_UNAVAILABLE";

  constructor(message: string) {
    super(message);
    this.name = "FeaturePolicyUnavailableError";
  }
}

type ParsedSemver = {
  readonly core: readonly [number, number, number];
  readonly prerelease: readonly string[];
};

function parseSemver(version: string): ParsedSemver {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!match) {
    throw new FeaturePolicyUnavailableError("Manager 版本不是受支持的语义版本");
  }
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".") ?? [],
  };
}

function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function compareSemver(left: string, right: string): number {
  const leftVersion = parseSemver(left);
  const rightVersion = parseSemver(right);
  for (let index = 0; index < leftVersion.core.length; index += 1) {
    const difference = leftVersion.core[index]! - rightVersion.core[index]!;
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return comparePrerelease(leftVersion.prerelease, rightVersion.prerelease);
}

function isEntryApplicable(entry: FeaturePolicyEntry, context: FeaturePolicyContext): boolean {
  if (entry.audience !== context.audience) return false;
  if (compareSemver(context.manager_version, entry.min_manager_version) < 0) return false;
  if (
    entry.max_manager_version !== undefined
    && compareSemver(context.manager_version, entry.max_manager_version) > 0
  ) {
    return false;
  }
  if (entry.scope === "global") return true;
  const scopeIds = context.scope_ids[entry.scope];
  return typeof scopeIds === "string"
    ? scopeIds === entry.scope_id
    : scopeIds?.includes(entry.scope_id ?? "") === true;
}

function mergeLimits(entries: readonly FeaturePolicyEntry[]): FeatureLimits {
  const result: Partial<Record<(typeof FEATURE_LIMIT_KEYS)[number], number>> = {};
  for (const key of FEATURE_LIMIT_KEYS) {
    const values = entries.flatMap((entry) =>
      entry.limits[key] === undefined ? [] : [entry.limits[key]],
    );
    if (values.length > 0) result[key] = Math.min(...values);
  }
  return result;
}

function maxByOrder<T extends string>(values: readonly T[], order: readonly T[]): T {
  return values.reduce((highest, value) =>
    order.indexOf(value) > order.indexOf(highest) ? value : highest,
  );
}

function mergeDataPolicy(entries: readonly FeaturePolicyEntry[]): FeatureDataPolicy {
  return {
    processing_location: maxByOrder<FeatureProcessingLocation>(
      entries.map((entry) => entry.data_policy.processing_location),
      FEATURE_PROCESSING_LOCATIONS,
    ),
    retention_days: Math.min(...entries.map((entry) => entry.data_policy.retention_days)),
    export_allowed: entries.every((entry) => entry.data_policy.export_allowed),
    deletion_allowed: entries.every((entry) => entry.data_policy.deletion_allowed),
  };
}

function unionSorted(values: readonly (readonly string[])[]): readonly string[] {
  return [...new Set(values.flat())].sort((left, right) => left.localeCompare(right, "en"));
}

function assertDocumentFresh(document: FeaturePolicyDocument, now: Date): void {
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp)) {
    throw new FeaturePolicyUnavailableError("策略校验时间无效");
  }
  if (Date.parse(document.issued_at) > timestamp) {
    throw new FeaturePolicyUnavailableError("策略尚未生效");
  }
  if (Date.parse(document.expires_at) <= timestamp) {
    throw new FeaturePolicyUnavailableError("策略已过期");
  }
}

export function resolveFeaturePolicy(
  document: FeaturePolicyDocument,
  featureId: FeatureId,
  context: FeaturePolicyContext,
): ResolvedFeaturePolicy | undefined {
  assertDocumentFresh(document, context.now ?? new Date());
  const entries = document.features.filter(
    (entry) => entry.feature_id === featureId && isEntryApplicable(entry, context),
  );
  if (entries.length === 0) return undefined;

  const emergencyDisabled = entries.some((entry) => entry.emergency_disabled);
  return {
    feature_id: featureId,
    policy_version: document.policy_version,
    enabled: !emergencyDisabled && entries.every((entry) => entry.enabled),
    emergency_disabled: emergencyDisabled,
    mode: maxByOrder(
      entries.map((entry) => entry.mode),
      FEATURE_POLICY_MODES,
    ),
    risk_level: entries.some((entry) => entry.risk_level === "high") ? "high" : "low",
    limits: mergeLimits(entries),
    data_policy: mergeDataPolicy(entries),
    required_entitlements: unionSorted(entries.map((entry) => entry.required_entitlements)),
    required_permissions: unionSorted(entries.map((entry) => entry.required_permissions)),
    applied_scopes: entries.map((entry) =>
      entry.scope === "global" ? "global" : entry.scope + ":" + entry.scope_id,
    ),
  };
}

export function decideFeatureAccess(
  policy: ResolvedFeaturePolicy | undefined,
  grants: {
    readonly entitlements: readonly string[];
    readonly permissions: readonly string[];
  },
): FeatureAccessDecision {
  if (policy === undefined) return { allowed: false, reason: "POLICY_NOT_FOUND" };
  if (policy.emergency_disabled) return { allowed: false, reason: "EMERGENCY_DISABLED" };
  if (!policy.enabled) return { allowed: false, reason: "FEATURE_DISABLED" };

  const entitlementSet = new Set(grants.entitlements);
  const missingEntitlements = policy.required_entitlements.filter(
    (entitlement) => !entitlementSet.has(entitlement),
  );
  if (missingEntitlements.length > 0) {
    return {
      allowed: false,
      reason: "MISSING_ENTITLEMENT",
      missing: missingEntitlements,
    };
  }

  const permissionSet = new Set(grants.permissions);
  const missingPermissions = policy.required_permissions.filter(
    (permission) => !permissionSet.has(permission),
  );
  if (missingPermissions.length > 0) {
    return {
      allowed: false,
      reason: "MISSING_PERMISSION",
      missing: missingPermissions,
    };
  }
  return { allowed: true };
}
