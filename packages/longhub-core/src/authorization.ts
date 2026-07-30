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
  agentId: string;
  profileVersion: string;
  sessionId: string;
  toolCallId: string;
  permissions: readonly string[];
  payloadDigest: string;
  expiresAt: string;
}

export interface BridgeConfirmationResponse {
  confirmationId: string;
  approved: boolean;
}

export interface BridgeConfirmationRecord extends BridgeConfirmationRequest {
  status: "pending" | "approved" | "denied" | "consumed";
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

export function bridgeConfirmationBinding(
  request: Omit<BridgeConfirmationRequest, "confirmationId" | "expiresAt">,
): string {
  return createHash("sha256")
    .update(canonicalJson({
      agentId: request.agentId,
      profileVersion: request.profileVersion,
      sessionId: request.sessionId,
      toolCallId: request.toolCallId,
      permissions: [...request.permissions].sort(),
      payloadDigest: request.payloadDigest,
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
