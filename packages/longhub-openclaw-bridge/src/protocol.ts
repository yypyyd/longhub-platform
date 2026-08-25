export const LONGHUB_BRIDGE_PLUGIN_ID = "longhub-tool-bridge";
export const LONGHUB_RESUME_SCREEN_TOOL = "longhub_resume_screen";
export const LONGHUB_RESUME_SCREEN_SKILL = "longhub.skill.resume-screen";
export const LONGHUB_OFFER_LETTER_TOOL = "longhub_offer_letter";
export const LONGHUB_OFFER_LETTER_SKILL = "longhub.skill.offer-letter";
export const LONGHUB_BRIDGE_SKILL_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  [LONGHUB_RESUME_SCREEN_SKILL]: ["connector:hr-api:read"],
  [LONGHUB_OFFER_LETTER_SKILL]: ["connector:hr-api:write"],
};
export const LONGHUB_BRIDGE_CONFIRMATION_DESCRIPTORS = {
  [LONGHUB_OFFER_LETTER_SKILL]: {
    action: "生成录用通知书",
    object: "候选人录用通知",
    recipientField: "candidateName",
    dataFields: [
      { label: "岗位", field: "position" },
      { label: "月薪（人民币元）", field: "monthlySalaryCny" },
      { label: "入职日期", field: "startDate" },
    ],
    estimatedCostCents: 0,
  },
} as const;

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

export interface OfferLetterInput {
  candidateName: string;
  position: string;
  monthlySalaryCny: number;
  startDate: string;
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

export function parseOfferLetterInput(value: unknown): OfferLetterInput {
  if (!isRecord(value)) throw new Error("录用通知参数必须是对象");
  assertExactKeys(
    value,
    ["candidateName", "position", "monthlySalaryCny", "startDate"],
    "录用通知参数",
  );
  if (
    typeof value.monthlySalaryCny !== "number"
    || !Number.isSafeInteger(value.monthlySalaryCny)
    || value.monthlySalaryCny < 1
    || value.monthlySalaryCny > 10_000_000
  ) {
    throw new Error("monthlySalaryCny 必须是 1-10000000 的整数");
  }
  const startDate = nonEmptyString(value.startDate, "startDate", 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !Number.isFinite(Date.parse(startDate + "T00:00:00.000Z"))) {
    throw new Error("startDate 必须是有效 YYYY-MM-DD 日期");
  }
  return {
    candidateName: nonEmptyString(value.candidateName, "candidateName", 128),
    position: nonEmptyString(value.position, "position", 128),
    monthlySalaryCny: value.monthlySalaryCny,
    startDate,
  };
}
