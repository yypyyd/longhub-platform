export const LONGHUB_BRIDGE_PLUGIN_ID = "longhub-tool-bridge";
export const LONGHUB_RESUME_SCREEN_TOOL = "longhub_resume_screen";
export const LONGHUB_RESUME_SCREEN_SKILL = "longhub.skill.resume-screen";
export const LONGHUB_BRIDGE_SKILL_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  [LONGHUB_RESUME_SCREEN_SKILL]: ["connector:hr-api:read"],
};

export interface TrustedToolContext {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  toolCallId: string;
}

export interface BridgeExecuteRequest {
  skillId: string;
  input: unknown;
  context: TrustedToolContext;
}

export type BridgeExecuteResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } };

export interface ResumeScreenInput {
  requiredKeywords: string[];
  resumeText: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unexpected.length > 0) throw new Error(`${name} 包含禁止字段: ${unexpected.join(", ")}`);
}

function nonEmptyString(value: unknown, name: string, maxLength = 512): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(`${name} 必须是长度不超过 ${maxLength} 的非空字符串`);
  }
  return value;
}

export function parseTrustedToolContext(value: unknown): TrustedToolContext {
  if (!isRecord(value)) throw new Error("缺少可信 OpenClaw 工具上下文");
  assertExactKeys(value, ["agentId", "sessionKey", "sessionId", "toolCallId"], "context");
  return {
    agentId: nonEmptyString(value.agentId, "context.agentId", 128),
    sessionKey: nonEmptyString(value.sessionKey, "context.sessionKey", 512),
    sessionId: nonEmptyString(value.sessionId, "context.sessionId", 128),
    toolCallId: nonEmptyString(value.toolCallId, "context.toolCallId", 128),
  };
}

export function parseBridgeExecuteRequest(value: unknown): BridgeExecuteRequest {
  if (!isRecord(value)) throw new Error("Bridge 请求必须是对象");
  assertExactKeys(value, ["skillId", "input", "context"], "Bridge 请求");
  return {
    skillId: nonEmptyString(value.skillId, "skillId", 128),
    input: value.input,
    context: parseTrustedToolContext(value.context),
  };
}

/** 即使绕过 OpenClaw 的 TypeBox 校验，也拒绝身份、权限及其他额外参数。 */
export function parseResumeScreenInput(value: unknown): ResumeScreenInput {
  if (!isRecord(value)) throw new Error("简历初筛参数必须是对象");
  assertExactKeys(value, ["requiredKeywords", "resumeText"], "简历初筛参数");
  if (
    !Array.isArray(value.requiredKeywords) ||
    value.requiredKeywords.length === 0 ||
    value.requiredKeywords.length > 100 ||
    !value.requiredKeywords.every((item) => typeof item === "string" && item.length <= 200)
  ) {
    throw new Error("requiredKeywords 必须包含 1-100 个字符串");
  }
  return {
    requiredKeywords: [...value.requiredKeywords],
    resumeText: nonEmptyString(value.resumeText, "resumeText", 200_000),
  };
}
