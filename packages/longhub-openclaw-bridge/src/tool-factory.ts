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
