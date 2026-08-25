import { Type } from "typebox";
import type {
  AnyAgentTool,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  createCloudSkillClientFromEnv,
  type CloudSkillClient,
} from "./client.js";
import {
  parseOpenClawRuntimeContext,
  parseCloudSkillPlanId,
  toCloudSkillRequest,
  trustedContextFromOpenClaw,
  parseCloudSkillToolParams,
  type CloudSkillToolParams,
} from "./protocol.js";

const inputSchema = Type.Record(Type.String({ maxLength: 256 }), Type.Unknown(), { maxProperties: 512 });

/** The generic tool deliberately exposes only snake_case public metadata and business input. */
export const cloudSkillParametersSchema = Type.Object(
  {
    skill_id: Type.String({ maxLength: 128, pattern: "^[a-z0-9][a-z0-9._-]{2,127}$" }),
    skill_version: Type.String({ maxLength: 64, pattern: "^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$" }),
    plan_id: Type.Optional(Type.String({
      maxLength: 128,
      pattern: "^[a-z][a-z0-9-]*(?:\\.[a-z][a-z0-9-]*){0,15}$",
      description: "可选的订阅计划候选；最终授权由 LongHub Cloud 决定。",
    })),
    input: inputSchema,
  },
  { additionalProperties: false },
);

export interface CloudSkillToolFactoryOptions {
  /** A test seam; production defaults to a fresh Credential Manager-backed client per call. */
  client?: CloudSkillClient;
  clientProvider?: () => CloudSkillClient | undefined;
  /** Optional signed catalog projection. The Cloud API remains the final authority. */
  allowedSkills?: ReadonlyMap<string, readonly string[]> | Readonly<Record<string, readonly string[]>>;
  /** Optional first-party adapter binding. A model-supplied plan must match it. */
  fixedPlanId?: string;
}

function isAllowedSkill(
  skillId: string,
  skillVersion: string,
  allowedSkills: CloudSkillToolFactoryOptions["allowedSkills"],
): boolean {
  if (!allowedSkills) return true;
  const record = allowedSkills as Readonly<Record<string, readonly string[]>>;
  const versions = allowedSkills instanceof Map
    ? allowedSkills.get(skillId)
    : Object.prototype.hasOwnProperty.call(record, skillId)
      ? record[skillId]
      : undefined;
  return Array.isArray(versions) && versions.includes(skillVersion);
}

function jsonText(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "null" : encoded;
  } catch {
    return "null";
  }
}

/**
 * Creates one generic tool whose runtime identity is captured from OpenClaw's
 * factory context.  The client provider is called inside execute, so a rotated
 * or revoked execution token is observed without reloading the plugin module.
 */
export function createCloudSkillToolFactory(
  options: CloudSkillToolFactoryOptions = {},
): OpenClawPluginToolFactory {
  const fixedPlanId = options.fixedPlanId === undefined ? undefined : parseCloudSkillPlanId(options.fixedPlanId);
  const clientProvider = options.clientProvider ?? (() => createCloudSkillClientFromEnv(process.env));
  return (runtimeContext: OpenClawPluginToolContext): AnyAgentTool | null => {
    try {
      // Validate all three runtime fields, including sessionId, before exposing
      // a tool. The sessionId is local binding metadata and is not sent on wire.
      parseOpenClawRuntimeContext(runtimeContext);
    } catch {
      return null;
    }

    return {
      name: "longhub_cloud_skill",
      label: "LongHub 云端 Skill",
      description: "调用已安装且已授权的 LongHub 云端 Skill；业务实现和凭据保留在云端。",
      parameters: cloudSkillParametersSchema,
      async execute(toolCallId, rawParams, signal) {
        let params: CloudSkillToolParams;
        try {
          params = parseCloudSkillToolParams(rawParams);
        } catch (error) {
          const message = error instanceof Error ? error.message : "云端 Skill 参数无效";
          throw new Error(`INVALID_CLOUD_SKILL_REQUEST: ${message}`);
        }
        if (!isAllowedSkill(params.skill_id, params.skill_version, options.allowedSkills)) {
          throw new Error("CLOUD_SKILL_NOT_IN_CATALOG: 当前 Skill 版本不在受信目录中");
        }
        if (fixedPlanId !== undefined && params.plan_id !== undefined && params.plan_id !== fixedPlanId) {
          throw new Error("INVALID_CLOUD_SKILL_REQUEST: plan_id 与固定适配器计划不匹配");
        }
        const effectiveParams = fixedPlanId === undefined || params.plan_id !== undefined
          ? params
          : { ...params, plan_id: fixedPlanId };
        const context = trustedContextFromOpenClaw(runtimeContext, toolCallId);
        const request = toCloudSkillRequest(effectiveParams, context);
        const client = options.client ?? clientProvider();
        if (!client) throw new Error("DEVICE_CREDENTIAL_REQUIRED: LongHub Cloud 插件尚未完成设备配对");
        const result = await client.execute(request, signal);
        return {
          content: [{ type: "text", text: jsonText(result) }],
          details: result,
        };
      },
    };
  };
}

export function trustedContextIsAvailable(context: OpenClawPluginToolContext): boolean {
  try {
    parseOpenClawRuntimeContext(context);
    return true;
  } catch {
    return false;
  }
}
