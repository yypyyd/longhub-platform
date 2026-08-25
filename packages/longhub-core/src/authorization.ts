import { createHash, randomUUID } from "node:crypto";
import type { CoreBudget } from "./index.js";

export interface BridgeSkillGrant {
  skillId: string;
  packId: string;
  packVersion: string;
  profileVersion: string;
  requiredPermissions: readonly string[];
  profilePermissions: readonly string[];
  packPermissions: readonly string[];
  tenantPermissions: readonly string[];
  devicePermissions: readonly string[];
  budget: CoreBudget;
  confirmation?: BridgeConfirmationDescriptor;
}

export type BridgeExecutionPolicy = Readonly<Record<string, readonly BridgeSkillGrant[]>>;

export interface BridgeEntitlementQuery {
  agentId: string;
  packId: string;
  packVersion: string;
  skillId: string;
}

export interface BridgeEntitlementStatus {
  active: boolean;
  expiresAt?: string;
  reason?: string;
}

export type BridgeEntitlementVerifier = (
  query: BridgeEntitlementQuery,
) => Promise<BridgeEntitlementStatus>;

export interface BridgeConfirmationRequest {
  confirmationId: string;
  skillId: string;
  agentId: string;
  profileVersion: string;
  sessionId: string;
  toolCallId: string;
  permissions: readonly string[];
  payloadDigest: string;
  display: BridgeConfirmationDisplay;
  expiresAt: string;
}

export interface BridgeConfirmationDescriptor {
  readonly action: string;
  readonly object: string;
  readonly recipientField?: string;
  readonly dataFields: readonly {
    readonly label: string;
    readonly field: string;
  }[];
  readonly estimatedCostCents: number;
}

export interface BridgeConfirmationDisplay {
  readonly action: string;
  readonly object: string;
  readonly recipient: string;
  readonly dataScope: readonly string[];
  readonly estimatedCostCents: number;
}

export interface BridgeConfirmationResponse {
  confirmationId: string;
  approved: boolean;
}

export interface BridgeConfirmationRecord extends BridgeConfirmationRequest {
  status: "pending" | "approved" | "denied" | "consumed";
}

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(label + " 必须是对象");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("|") !== [...keys].sort().join("|")) {
    throw new Error(label + " 字段无效");
  }
  return record;
}

function boundedText(value: unknown, label: string, max = 256): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > max
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(label + " 文本无效");
  }
  return value;
}

export function parseBridgeConfirmationRequest(input: unknown): BridgeConfirmationRequest {
  const record = exactObject(input, [
    "confirmationId",
    "skillId",
    "agentId",
    "profileVersion",
    "sessionId",
    "toolCallId",
    "permissions",
    "payloadDigest",
    "display",
    "expiresAt",
  ], "确认请求");
  const display = exactObject(
    record.display,
    ["action", "object", "recipient", "dataScope", "estimatedCostCents"],
    "确认展示",
  );
  if (
    typeof record.confirmationId !== "string"
    || !/^confirm-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(record.confirmationId)
    || typeof record.payloadDigest !== "string"
    || !/^[a-f0-9]{64}$/.test(record.payloadDigest)
    || !Array.isArray(record.permissions)
    || record.permissions.length < 1
    || record.permissions.length > 32
    || !record.permissions.every((permission) =>
      typeof permission === "string" && /^[a-z][a-z0-9-]*(?::[a-z0-9_.-]+)+$/.test(permission)
    )
    || new Set(record.permissions).size !== record.permissions.length
    || !Array.isArray(display.dataScope)
    || display.dataScope.length < 1
    || display.dataScope.length > 16
    || !display.dataScope.every((item) =>
      typeof item === "string" && item.length <= 512 && !/[\u0000-\u001f\u007f]/.test(item)
    )
    || typeof display.estimatedCostCents !== "number"
    || !Number.isSafeInteger(display.estimatedCostCents)
    || display.estimatedCostCents < 0
    || display.estimatedCostCents > 100_000_000
    || typeof record.expiresAt !== "string"
    || !Number.isFinite(Date.parse(record.expiresAt))
    || new Date(Date.parse(record.expiresAt)).toISOString() !== record.expiresAt
  ) {
    throw new Error("确认请求值无效");
  }
  return {
    confirmationId: record.confirmationId,
    skillId: boundedText(record.skillId, "skillId", 128),
    agentId: boundedText(record.agentId, "agentId", 128),
    profileVersion: boundedText(record.profileVersion, "profileVersion", 64),
    sessionId: boundedText(record.sessionId, "sessionId", 128),
    toolCallId: boundedText(record.toolCallId, "toolCallId", 128),
    permissions: [...record.permissions] as string[],
    payloadDigest: record.payloadDigest,
    display: {
      action: boundedText(display.action, "display.action"),
      object: boundedText(display.object, "display.object"),
      recipient: boundedText(display.recipient, "display.recipient"),
      dataScope: [...display.dataScope] as string[],
      estimatedCostCents: display.estimatedCostCents,
    },
    expiresAt: record.expiresAt,
  };
}

const READ_ONLY_ACTIONS = new Set(["read", "list", "get", "query", "search"]);

export function permissionRequiresConfirmation(permission: string): boolean {
  const segments = permission.split(":");
  return !READ_ONLY_ACTIONS.has(segments[segments.length - 1] ?? "");
}

export function intersectBridgePermissions(grant: BridgeSkillGrant): string[] {
  const sources = [
    new Set(grant.profilePermissions),
    new Set(grant.packPermissions),
    new Set(grant.tenantPermissions),
    new Set(grant.devicePermissions),
  ];
  return [...new Set(grant.requiredPermissions)]
    .filter((permission) => sources.every((source) => source.has(permission)))
    .sort((left, right) => left.localeCompare(right, "en"));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("确认摘要不接受非有限数字");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort((left, right) => left.localeCompare(right, "en"))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("确认摘要只接受 JSON 值");
}

export function bridgePayloadDigest(skillId: string, input: unknown): string {
  return createHash("sha256")
    .update(canonicalJson({ skillId, input }), "utf8")
    .digest("hex");
}

function displayText(value: unknown, label: string): string {
  if (
    (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
    || (typeof value === "number" && !Number.isFinite(value))
  ) {
    throw new Error("确认展示字段 " + label + " 类型无效");
  }
  const text = String(value).trim();
  if (text.length === 0 || text.length > 256 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error("确认展示字段 " + label + " 内容无效");
  }
  return text;
}

/** 展示标签来自受信声明，值由 Core 从已绑定 input 中提取，模型不能另行提供展示文案。 */
export function buildBridgeConfirmationDisplay(
  descriptor: BridgeConfirmationDescriptor,
  input: unknown,
): BridgeConfirmationDisplay {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("确认展示要求结构化输入");
  }
  const record = input as Record<string, unknown>;
  const action = displayText(descriptor.action, "action");
  const object = displayText(descriptor.object, "object");
  if (
    !Number.isSafeInteger(descriptor.estimatedCostCents)
    || descriptor.estimatedCostCents < 0
    || descriptor.estimatedCostCents > 100_000_000
    || descriptor.dataFields.length < 1
    || descriptor.dataFields.length > 16
  ) {
    throw new Error("确认展示声明无效");
  }
  return {
    action,
    object,
    recipient: descriptor.recipientField
      ? displayText(record[descriptor.recipientField], "recipient")
      : "当前设备",
    dataScope: descriptor.dataFields.map((item) =>
      displayText(item.label, "data label") + "：" + displayText(record[item.field], item.field),
    ),
    estimatedCostCents: descriptor.estimatedCostCents,
  };
}

export function bridgeConfirmationBinding(
  request: Omit<BridgeConfirmationRequest, "confirmationId" | "expiresAt">,
): string {
  return createHash("sha256")
    .update(canonicalJson({
      agentId: request.agentId,
      skillId: request.skillId,
      profileVersion: request.profileVersion,
      sessionId: request.sessionId,
      toolCallId: request.toolCallId,
      permissions: [...request.permissions].sort(),
      payloadDigest: request.payloadDigest,
      display: request.display,
    }), "utf8")
    .digest("hex");
}

export function createBridgeConfirmationRequest(
  binding: Omit<BridgeConfirmationRequest, "confirmationId" | "expiresAt">,
  nowMs: number,
  ttlMs: number,
): BridgeConfirmationRecord {
  return {
    ...binding,
    confirmationId: `confirm-${randomUUID()}`,
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
    status: "pending",
  };
}

export function clampBudget(requested: CoreBudget | undefined, ceiling: CoreBudget): CoreBudget {
  const source = requested ?? ceiling;
  for (const [name, value] of Object.entries(source)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`预算 ${name} 必须是正整数`);
  }
  return {
    maxTokens: Math.min(source.maxTokens, ceiling.maxTokens),
    maxCostCents: Math.min(source.maxCostCents, ceiling.maxCostCents),
    maxDurationMs: Math.min(source.maxDurationMs, ceiling.maxDurationMs),
  };
}
