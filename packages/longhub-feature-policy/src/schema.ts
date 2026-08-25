/**
 * Feature Policy V2 的唯一严格契约。
 *
 * TypeScript 类型不是安全边界。Cloud 和 Manager 都必须通过本模块解析不可信输入，
 * 且 Cloud 在每次受保护调用时仍需重新解析并复验策略。
 */
export const FEATURE_POLICY_SCHEMA = "longhub/feature-policy/v2" as const;
export const FEATURE_POLICY_MAX_VALIDITY_MS = 5 * 60_000;
export const FEATURE_POLICY_REFRESH_INTERVAL_MS = 30_000;
export const FEATURE_POLICY_MAX_FEATURES = 64;
export const FEATURE_POLICY_MAX_BYTES = 64 * 1024;

export const FEATURE_IDS = [
  "chat.core",
  "session.manage",
  "session.local_search",
  "session.export",
  "file.input",
  "image.input",
  "voice.input",
  "voice.output",
  "knowledge.tenant",
  "knowledge.personal",
  "memory.user_controls",
  "web.search_readonly",
  "url.fetch_readonly",
  "image.generate",
  "agent.catalog",
  "agent.custom_nocode",
  "agent.handoff_summary",
  "skill.catalog",
  "skill.execute",
  "skill.user_content",
  "workflow.user_bounded",
  "automation.reminder",
  "automation.scheduled_read",
  "channel.enterprise",
  "data.export_delete",
] as const;

export const FEATURE_POLICY_SCOPES = ["global", "tenant", "plan", "device", "agent"] as const;
export const FEATURE_POLICY_AUDIENCES = ["user", "tenant_admin", "platform_admin"] as const;
export const FEATURE_POLICY_MODES = ["default", "tenant_controlled", "admin_approved"] as const;
export const FEATURE_RISK_LEVELS = ["low", "high"] as const;
export const FEATURE_PROCESSING_LOCATIONS = ["platform_region", "tenant_region", "device_local"] as const;
export const FEATURE_LIMIT_KEYS = ["count", "bytes", "duration_ms", "concurrency", "cost_cents"] as const;

export type FeatureId = (typeof FEATURE_IDS)[number];
export type FeaturePolicyScope = (typeof FEATURE_POLICY_SCOPES)[number];
export type FeaturePolicyAudience = (typeof FEATURE_POLICY_AUDIENCES)[number];
export type FeaturePolicyMode = (typeof FEATURE_POLICY_MODES)[number];
export type FeatureRiskLevel = (typeof FEATURE_RISK_LEVELS)[number];
export type FeatureProcessingLocation = (typeof FEATURE_PROCESSING_LOCATIONS)[number];
export type FeatureLimitKey = (typeof FEATURE_LIMIT_KEYS)[number];
export type FeatureLimits = Readonly<Partial<Record<FeatureLimitKey, number>>>;

export interface FeatureDataPolicy {
  readonly processing_location: FeatureProcessingLocation;
  readonly retention_days: number;
  readonly export_allowed: boolean;
  readonly deletion_allowed: boolean;
}

/**
 * scope_id 标识非全局策略的目标。响应可以同时包含多个 Agent 策略，
 * Manager 只能合并与当前可信上下文匹配的记录。
 */
export interface FeaturePolicyEntry {
  readonly feature_id: FeatureId;
  readonly enabled: boolean;
  readonly scope: FeaturePolicyScope;
  readonly scope_id?: string;
  readonly audience: FeaturePolicyAudience;
  readonly mode: FeaturePolicyMode;
  readonly risk_level: FeatureRiskLevel;
  readonly limits: FeatureLimits;
  readonly data_policy: FeatureDataPolicy;
  readonly required_entitlements: readonly string[];
  readonly required_permissions: readonly string[];
  readonly min_manager_version: string;
  readonly max_manager_version?: string;
  readonly emergency_disabled: boolean;
}

export interface FeaturePolicyDocument {
  readonly schema_version: typeof FEATURE_POLICY_SCHEMA;
  readonly policy_version: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly features: readonly FeaturePolicyEntry[];
}

export class FeaturePolicyValidationError extends Error {
  readonly code = "FEATURE_POLICY_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "FeaturePolicyValidationError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new FeaturePolicyValidationError(label + " 包含未知或缺失字段");
  }
}

function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new FeaturePolicyValidationError(label + " 不在允许枚举中");
  }
  return value as T;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new FeaturePolicyValidationError(label + " 必须是布尔值");
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new FeaturePolicyValidationError(label + " 必须是 0-" + max + " 的整数");
  }
  return value;
}

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const POLICY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SCOPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ENTITLEMENT_PATTERN = /^[a-z][a-z0-9-]*(?::[a-z0-9_.-]+)*$/;
const PERMISSION_PATTERN = /^[a-z][a-z0-9-]*(?::[a-z0-9_.-]+)+$/;

function semver(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 64 || !SEMVER_PATTERN.test(value)) {
    throw new FeaturePolicyValidationError(label + " 必须是受限语义版本");
  }
  return value;
}

function canonicalIsoInstant(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 32) {
    throw new FeaturePolicyValidationError(label + " 必须是 ISO 时间字符串");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new FeaturePolicyValidationError(label + " 必须是规范化 ISO 瞬时值");
  }
  return value;
}

function identifier(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new FeaturePolicyValidationError(label + " 含非法标识符");
  }
  return value;
}

function sortedUniqueStrings(
  value: unknown,
  label: string,
  pattern: RegExp,
  maxItems: number,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new FeaturePolicyValidationError(label + " 必须是数组");
  }
  if (value.length > maxItems) {
    throw new FeaturePolicyValidationError(label + " 最多 " + maxItems + " 项");
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || item.length > 128 || !pattern.test(item)) {
      throw new FeaturePolicyValidationError(label + " 含非法标识符");
    }
    if (seen.has(item)) {
      throw new FeaturePolicyValidationError(label + " 含重复项");
    }
    seen.add(item);
  }
  return [...seen].sort((left, right) => left.localeCompare(right, "en"));
}

function parseLimits(value: unknown, label: string): FeatureLimits {
  if (!isPlainObject(value)) {
    throw new FeaturePolicyValidationError(label + " 必须是对象");
  }
  for (const key of Object.keys(value)) {
    if (!(FEATURE_LIMIT_KEYS as readonly string[]).includes(key)) {
      throw new FeaturePolicyValidationError(label + " 含未知上限字段 " + key);
    }
  }
  const limits: Partial<Record<FeatureLimitKey, number>> = {};
  for (const key of FEATURE_LIMIT_KEYS) {
    const raw = value[key];
    if (raw !== undefined) {
      limits[key] = nonNegativeInteger(raw, label + "." + key, Number.MAX_SAFE_INTEGER);
    }
  }
  return limits;
}

function parseDataPolicy(value: unknown, label: string): FeatureDataPolicy {
  if (!isPlainObject(value)) {
    throw new FeaturePolicyValidationError(label + " 必须是对象");
  }
  assertExactKeys(
    value,
    ["processing_location", "retention_days", "export_allowed", "deletion_allowed"],
    label,
  );
  return {
    processing_location: enumValue(
      value.processing_location,
      FEATURE_PROCESSING_LOCATIONS,
      label + ".processing_location",
    ),
    retention_days: nonNegativeInteger(value.retention_days, label + ".retention_days", 3_650),
    export_allowed: booleanValue(value.export_allowed, label + ".export_allowed"),
    deletion_allowed: booleanValue(value.deletion_allowed, label + ".deletion_allowed"),
  };
}

const ENTRY_REQUIRED_KEYS = [
  "feature_id",
  "enabled",
  "scope",
  "audience",
  "mode",
  "risk_level",
  "limits",
  "data_policy",
  "required_entitlements",
  "required_permissions",
  "min_manager_version",
  "emergency_disabled",
] as const;

export function parseFeaturePolicyEntry(input: unknown, label = "策略"): FeaturePolicyEntry {
  if (!isPlainObject(input)) {
    throw new FeaturePolicyValidationError(label + " 必须是对象");
  }
  const scope = enumValue(input.scope, FEATURE_POLICY_SCOPES, label + ".scope");
  const hasScopeId = "scope_id" in input;
  const hasMax = "max_manager_version" in input;
  assertExactKeys(
    input,
    [
      ...ENTRY_REQUIRED_KEYS,
      ...(hasScopeId ? ["scope_id"] : []),
      ...(hasMax ? ["max_manager_version"] : []),
    ],
    label,
  );
  if (scope === "global" && hasScopeId) {
    throw new FeaturePolicyValidationError(label + ".scope_id 全局策略不得设置");
  }
  if (scope !== "global" && !hasScopeId) {
    throw new FeaturePolicyValidationError(label + ".scope_id 非全局策略必须设置");
  }

  const minManagerVersion = semver(input.min_manager_version, label + ".min_manager_version");
  const maxManagerVersion = hasMax
    ? semver(input.max_manager_version, label + ".max_manager_version")
    : undefined;

  return {
    feature_id: enumValue(input.feature_id, FEATURE_IDS, label + ".feature_id"),
    enabled: booleanValue(input.enabled, label + ".enabled"),
    scope,
    ...(hasScopeId
      ? { scope_id: identifier(input.scope_id, SCOPE_ID_PATTERN, label + ".scope_id") }
      : {}),
    audience: enumValue(input.audience, FEATURE_POLICY_AUDIENCES, label + ".audience"),
    mode: enumValue(input.mode, FEATURE_POLICY_MODES, label + ".mode"),
    risk_level: enumValue(input.risk_level, FEATURE_RISK_LEVELS, label + ".risk_level"),
    limits: parseLimits(input.limits, label + ".limits"),
    data_policy: parseDataPolicy(input.data_policy, label + ".data_policy"),
    required_entitlements: sortedUniqueStrings(
      input.required_entitlements,
      label + ".required_entitlements",
      ENTITLEMENT_PATTERN,
      32,
    ),
    required_permissions: sortedUniqueStrings(
      input.required_permissions,
      label + ".required_permissions",
      PERMISSION_PATTERN,
      32,
    ),
    min_manager_version: minManagerVersion,
    ...(maxManagerVersion === undefined ? {} : { max_manager_version: maxManagerVersion }),
    emergency_disabled: booleanValue(input.emergency_disabled, label + ".emergency_disabled"),
  };
}

export function parseFeaturePolicyDocument(input: unknown): FeaturePolicyDocument {
  if (!isPlainObject(input)) {
    throw new FeaturePolicyValidationError("策略文档必须是对象");
  }
  assertExactKeys(
    input,
    ["schema_version", "policy_version", "issued_at", "expires_at", "features"],
    "策略文档",
  );
  if (input.schema_version !== FEATURE_POLICY_SCHEMA) {
    throw new FeaturePolicyValidationError("策略契约版本不受支持");
  }
  const policyVersion = identifier(input.policy_version, POLICY_VERSION_PATTERN, "policy_version");
  const issuedAt = canonicalIsoInstant(input.issued_at, "issued_at");
  const expiresAt = canonicalIsoInstant(input.expires_at, "expires_at");
  const validityMs = Date.parse(expiresAt) - Date.parse(issuedAt);
  if (validityMs <= 0) {
    throw new FeaturePolicyValidationError("expires_at 必须晚于 issued_at");
  }
  if (validityMs > FEATURE_POLICY_MAX_VALIDITY_MS) {
    throw new FeaturePolicyValidationError(
      "策略有效期不得超过 " + FEATURE_POLICY_MAX_VALIDITY_MS + " 毫秒",
    );
  }
  if (!Array.isArray(input.features) || input.features.length > FEATURE_POLICY_MAX_FEATURES) {
    throw new FeaturePolicyValidationError("features 最多 " + FEATURE_POLICY_MAX_FEATURES + " 项");
  }

  const features = input.features.map((raw, index) =>
    parseFeaturePolicyEntry(raw, "features[" + index + "]"),
  );
  const seen = new Set<string>();
  for (const entry of features) {
    const key = [
      entry.feature_id,
      entry.audience,
      entry.scope,
      entry.scope_id ?? "",
    ].join("\u0000");
    if (seen.has(key)) {
      throw new FeaturePolicyValidationError(
        "features 含重复的 " + entry.feature_id + "@" + entry.scope,
      );
    }
    seen.add(key);
  }

  return {
    schema_version: FEATURE_POLICY_SCHEMA,
    policy_version: policyVersion,
    issued_at: issuedAt,
    expires_at: expiresAt,
    features,
  };
}

export function parseFeaturePolicyJson(input: string): FeaturePolicyDocument {
  if (Buffer.byteLength(input, "utf8") > FEATURE_POLICY_MAX_BYTES) {
    throw new FeaturePolicyValidationError(
      "策略响应不得超过 " + FEATURE_POLICY_MAX_BYTES + " 字节",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new FeaturePolicyValidationError("策略响应不是有效 JSON");
  }
  return parseFeaturePolicyDocument(parsed);
}
