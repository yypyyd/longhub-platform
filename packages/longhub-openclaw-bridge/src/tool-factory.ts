import { Type } from "typebox";
import type {
  AnyAgentTool,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/plugin-entry";
import type { LongHubBridgeClient } from "./client.js";
import {
  LONGHUB_RESUME_SCREEN_SKILL,
  LONGHUB_RESUME_SCREEN_TOOL,
  LONGHUB_OFFER_LETTER_SKILL,
  LONGHUB_OFFER_LETTER_TOOL,
  parseOfferLetterInput,
  parseResumeScreenInput,
  parseTrustedToolContext,
} from "./protocol.js";

export const resumeScreenParameters = Type.Object(
  {
    requiredKeywords: Type.Array(Type.String({ maxLength: 200 }), {
      minItems: 1,
      maxItems: 100,
      description: "岗位必备关键词，例如 TypeScript、React。",
    }),
    resumeText: Type.String({
      minLength: 1,
      maxLength: 200_000,
      description: "候选人简历全文。",
    }),
  },
  { additionalProperties: false },
);

export const offerLetterParameters = Type.Object(
  {
    candidateName: Type.String({ minLength: 1, maxLength: 128, description: "候选人姓名。" }),
    position: Type.String({ minLength: 1, maxLength: 128, description: "录用岗位。" }),
    monthlySalaryCny: Type.Integer({ minimum: 1, maximum: 10_000_000, description: "人民币月薪。" }),
    startDate: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "入职日期 YYYY-MM-DD。" }),
  },
  { additionalProperties: false },
);

export function trustedContextFromOpenClaw(context: OpenClawPluginToolContext) {
  return parseTrustedToolContext({
    agentId: context.agentId,
    sessionKey: context.sessionKey,
    sessionId: context.sessionId,
    toolCallId: "factory-pending",
  });
}

export function createLongHubToolFactory(
  client: LongHubBridgeClient | undefined,
): OpenClawPluginToolFactory {
  return (runtimeContext): AnyAgentTool | null => {
    if (!client) return null;
    let trustedContext;
    try {
      trustedContext = trustedContextFromOpenClaw(runtimeContext);
    } catch {
      return null;
    }

    return {
      name: LONGHUB_RESUME_SCREEN_TOOL,
      label: "简历初筛",
      description: "按照岗位必备关键词对候选人简历进行初筛并给出命中率和建议。",
      parameters: resumeScreenParameters,
      async execute(toolCallId, rawParams) {
        const input = parseResumeScreenInput(rawParams);
        const result = await client.execute({
          skillId: LONGHUB_RESUME_SCREEN_SKILL,
          input,
          context: parseTrustedToolContext({ ...trustedContext, toolCallId }),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
    };
  };
}

export function createOfferLetterToolFactory(
  client: LongHubBridgeClient | undefined,
): OpenClawPluginToolFactory {
  return (runtimeContext): AnyAgentTool | null => {
    if (!client) return null;
    let trustedContext;
    try {
      trustedContext = trustedContextFromOpenClaw(runtimeContext);
    } catch {
      return null;
    }
    return {
      name: LONGHUB_OFFER_LETTER_TOOL,
      label: "生成录用通知书",
      description: "根据候选人、岗位、薪资和入职日期生成录用通知；执行前必须由用户确认。",
      parameters: offerLetterParameters,
      async execute(toolCallId, rawParams) {
        const input = parseOfferLetterInput(rawParams);
        const result = await client.execute({
          skillId: LONGHUB_OFFER_LETTER_SKILL,
          input,
          context: parseTrustedToolContext({ ...trustedContext, toolCallId }),
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
    };
  };
}
