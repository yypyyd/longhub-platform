import { createHash } from "node:crypto";

export const CLOUD_SKILL_CALL_SCHEMA = "longhub/cloud-skill-call/v1" as const;
export const LONGHUB_CLOUD_PLUGIN_ID = "longhub-cloud-skill" as const;
export const LONGHUB_CLOUD_SKILL_TOOL = "longhub_cloud_skill" as const;
export const LONGHUB_CLOUD_SKILL_TOOL_NAME = LONGHUB_CLOUD_SKILL_TOOL;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~:-]{0,127}$/;
const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,127}$/;
const SKILL_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const PLAN_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){0,15}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~:-]{0,127}$/;
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/;
const TOOL_CALL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~:-]{0,127}$/;
const MAX_INPUT_BYTES = 1 << 20;
const MAX_INPUT_DEPTH = 32;
const MAX_INPUT_PROPERTIES = 512;

export interface CloudSkillContext {
  agent_id: string;
  session_key: string;
  /** Required locally for runtime-context binding; intentionally not sent on v1 wire. */
  session_id: string;
  tool_call_id: string;
}

/** Runtime context shape used by the OpenClaw factory (camelCase is upstream). */
export interface OpenClawRuntimeContextLike {
  agentId?: unknown;
  sessionKey?: unknown;
  sessionId?: unknown;
}

export interface ValidatedOpenClawContext {
  agent_id: string;
  session_key: string;
  session_id: string;
}

export interface CloudSkillToolParams {
  skill_id: string;
  skill_version: string;
  /** A routing candidate only. The Cloud API is the entitlement authority. */
  plan_id?: string;
  input: Record<string, unknown>;
}

/** Exact strict snake_case request sent directly to POST /v1/tasks. */
export interface CloudSkillRequest {
  schema_version: typeof CLOUD_SKILL_CALL_SCHEMA;
  request_id: string;
  kind: "skill.execute";
  skill_id: string;
  skill_version: string;
  /** Optional candidate re-authorized by Cloud API. */
  plan_id?: string;
  agent_id: string;
  tool_call_id: string;
  session_key_hash: string;
  input: Record<string, unknown>;
  idempotency_key: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unexpected.length > 0) throw new Error(`${name} 包含禁止字段: ${unexpected.join(", ")}`);
}

function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.trim() !== value) {
    throw new Error(`${name} 无效`);
  }
  if (/[^\x20-\x7e]/u.test(value) || /[\r\n\0]/u.test(value)) throw new Error(`${name} 无效`);
  return value;
}

function patternedString(value: unknown, pattern: RegExp, name: string, max: number): string {
  const text = boundedString(value, name, max);
  if (!pattern.test(text)) throw new Error(`${name} 无效`);
  return text;
}

function validateInputValue(value: unknown, depth: number, seen: WeakSet<object>): void {
  if (depth > MAX_INPUT_DEPTH) throw new Error("input 嵌套层级过深");
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("input 包含非有限数字");
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol" || value === undefined) {
    throw new Error("input 包含不可序列化值");
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("input 不能包含循环引用");
    if (value.length > MAX_INPUT_PROPERTIES) throw new Error("input 数组超出限制");
    seen.add(value);
    for (const item of value) validateInputValue(item, depth + 1, seen);
    seen.delete(value);
    return;
  }
  if (!isRecord(value)) return;
  if (seen.has(value)) throw new Error("input 不能包含循环引用");
  seen.add(value);
  let properties = 0;
  for (const [key, child] of Object.entries(value)) {
    properties += 1;
    if (properties > MAX_INPUT_PROPERTIES || key.length > 256 || /[\0\r\n]/u.test(key)) {
      throw new Error("input 字段数量或名称超出限制");
    }
    validateInputValue(child, depth + 1, seen);
  }
  seen.delete(value);
}

function validateInputShape(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("input 必须是对象");
  validateInputValue(value, 0, new WeakSet<object>());
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error("input 无法序列化");
  }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_INPUT_BYTES) {
    throw new Error("input 超出大小限制");
  }
  return value;
}

export function parseCloudSkillContext(value: unknown): CloudSkillContext {
  if (!isRecord(value)) throw new Error("context 必须是对象");
  assertExactKeys(value, ["agent_id", "session_key", "session_id", "tool_call_id"], "context");
  return {
    agent_id: patternedString(value.agent_id, AGENT_ID_PATTERN, "context.agent_id", 128),
    session_key: boundedString(value.session_key, "context.session_key", 512),
    session_id: patternedString(value.session_id, SESSION_ID_PATTERN, "context.session_id", 128),
    tool_call_id: patternedString(value.tool_call_id, TOOL_CALL_ID_PATTERN, "context.tool_call_id", 128),
  };
}

export function parseCloudSkillToolParams(value: unknown): CloudSkillToolParams {
  if (!isRecord(value)) throw new Error("云端 Skill 工具参数必须是对象");
  assertExactKeys(value, ["skill_id", "skill_version", "plan_id", "input"], "云端 Skill 工具参数");
  const planId = value.plan_id === undefined ? undefined : parseCloudSkillPlanId(value.plan_id);
  return {
    skill_id: patternedString(value.skill_id, SKILL_ID_PATTERN, "skill_id", 128),
    skill_version: patternedString(value.skill_version, SKILL_VERSION_PATTERN, "skill_version", 64),
    ...(planId === undefined ? {} : { plan_id: planId }),
    input: validateInputShape(value.input),
  };
}

export function parseCloudSkillPlanId(value: unknown): string {
  return patternedString(value, PLAN_ID_PATTERN, "plan_id", 128);
}

export function parseCloudSkillRequest(value: unknown): CloudSkillRequest {
  if (!isRecord(value)) throw new Error("云端 Skill 请求必须是对象");
  assertExactKeys(
    value,
    ["schema_version", "request_id", "kind", "skill_id", "skill_version", "plan_id", "agent_id", "tool_call_id", "session_key_hash", "input", "idempotency_key"],
    "云端 Skill 请求",
  );
  if (value.schema_version !== CLOUD_SKILL_CALL_SCHEMA) throw new Error("schema_version 无效");
  if (value.kind !== "skill.execute") throw new Error("kind 无效");
  const planId = value.plan_id === undefined ? undefined : parseCloudSkillPlanId(value.plan_id);
  return {
    schema_version: CLOUD_SKILL_CALL_SCHEMA,
    request_id: patternedString(value.request_id, REQUEST_ID_PATTERN, "request_id", 128),
    kind: "skill.execute",
    skill_id: patternedString(value.skill_id, SKILL_ID_PATTERN, "skill_id", 128),
    skill_version: patternedString(value.skill_version, SKILL_VERSION_PATTERN, "skill_version", 64),
    ...(planId === undefined ? {} : { plan_id: planId }),
    agent_id: patternedString(value.agent_id, AGENT_ID_PATTERN, "agent_id", 128),
    tool_call_id: patternedString(value.tool_call_id, TOOL_CALL_ID_PATTERN, "tool_call_id", 128),
    session_key_hash: patternedString(value.session_key_hash, /^[a-f0-9]{64}$/u, "session_key_hash", 64),
    input: validateInputShape(value.input),
    idempotency_key: patternedString(value.idempotency_key, IDEMPOTENCY_KEY_PATTERN, "idempotency_key", 128),
  };
}

export function trustedContextFromOpenClaw(
  context: OpenClawRuntimeContextLike,
  toolCallId: unknown,
): CloudSkillContext {
  const validated = parseOpenClawRuntimeContext(context);
  return parseCloudSkillContext({
    ...validated,
    tool_call_id: toolCallId,
  });
}

export function parseOpenClawRuntimeContext(context: OpenClawRuntimeContextLike): ValidatedOpenClawContext {
  const parsed = parseCloudSkillContext({
    agent_id: context?.agentId,
    session_key: context?.sessionKey,
    session_id: context?.sessionId,
    tool_call_id: "context-validation",
  });
  return {
    agent_id: parsed.agent_id,
    session_key: parsed.session_key,
    session_id: parsed.session_id,
  };
}

function executionIdentity(params: CloudSkillToolParams, context: CloudSkillContext): string {
  // JSON array keeps field order canonical; length-prefixed JSON escaping avoids
  // separator ambiguity. session_id is intentionally local-only but participates
  // in the identity so /new and /reset cannot replay a prior conversation call.
  return JSON.stringify([
    CLOUD_SKILL_CALL_SCHEMA,
    context.agent_id,
    context.session_key,
    context.session_id,
    context.tool_call_id,
    params.skill_id,
    params.skill_version,
    params.plan_id ?? null,
  ]);
}

function deriveExecutionIdentifier(
  domain: "request-id" | "idempotency-key",
  prefix: string,
  params: CloudSkillToolParams,
  context: CloudSkillContext,
): string {
  const parsedParams = parseCloudSkillToolParams(params);
  const parsedContext = parseCloudSkillContext(context);
  const digest = createHash("sha256")
    .update(`longhub-openclaw-cloud-plugin/v1/${domain}\0`)
    .update(executionIdentity(parsedParams, parsedContext))
    .digest("hex")
    .slice(0, 32);
  return `${prefix}${digest}`;
}

/** Deterministic and model-independent request id for one trusted tool call. */
export function deriveRequestId(params: CloudSkillToolParams, context: CloudSkillContext): string {
  return deriveExecutionIdentifier("request-id", "oc-", params, context);
}

/** Deterministic and model-independent idempotency key for one trusted tool call. */
export function deriveIdempotencyKey(params: CloudSkillToolParams, context: CloudSkillContext): string {
  return deriveExecutionIdentifier("idempotency-key", "oc-idem-", params, context);
}

export function toCloudSkillRequest(
  params: CloudSkillToolParams,
  context: CloudSkillContext,
): CloudSkillRequest {
  const parsedParams = parseCloudSkillToolParams(params);
  const parsedContext = parseCloudSkillContext(context);
  const requestId = deriveRequestId(parsedParams, parsedContext);
  const idempotencyKey = deriveIdempotencyKey(parsedParams, parsedContext);
  return parseCloudSkillRequest({
    schema_version: CLOUD_SKILL_CALL_SCHEMA,
    request_id: requestId,
    kind: "skill.execute",
    skill_id: parsedParams.skill_id,
    skill_version: parsedParams.skill_version,
    ...(parsedParams.plan_id === undefined ? {} : { plan_id: parsedParams.plan_id }),
    agent_id: parsedContext.agent_id,
    tool_call_id: parsedContext.tool_call_id,
    session_key_hash: createHash("sha256").update(parsedContext.session_key, "utf8").digest("hex"),
    input: parsedParams.input,
    idempotency_key: idempotencyKey,
  });
}

export const cloudSkillParameters = {
  type: "object",
  properties: {
    skill_id: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{2,127}$", maxLength: 128 },
    skill_version: { type: "string", pattern: "^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$", maxLength: 64 },
    plan_id: {
      type: "string",
      pattern: "^[a-z][a-z0-9-]*(?:\\.[a-z][a-z0-9-]*){0,15}$",
      maxLength: 128,
    },
    input: { type: "object", additionalProperties: true, maxProperties: MAX_INPUT_PROPERTIES },
  },
  required: ["skill_id", "skill_version", "input"],
  additionalProperties: false,
} as const;
