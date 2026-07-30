import { z } from "zod";
import { packIdSchema, packRelativePathSchema, permissionSchema, semverSchema } from "./primitives.js";

function uniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export { packRelativePathSchema } from "./primitives.js";

export const agentProfilePathSchema = packRelativePathSchema.refine(
  (value) => value.endsWith(".json"),
  "Agent Profile 必须使用 JSON 文件",
);

const skillIdSchema = packIdSchema;
const toolIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_.-]*$/, "工具 ID 只能使用小写字母、数字、点、下划线和短横线");
const modelPolicyIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_.-]*$/, "模型策略 ID 格式不合法");

const uniqueStringArray = (item: z.ZodType<string>, min: number, max: number) =>
  z.array(item).min(min).max(max).refine(uniqueValues, "列表中不能有重复项");

export const agentCapabilitySchema = z
  .object({
    id: packIdSchema,
    skillIds: uniqueStringArray(skillIdSchema, 1, 64),
    permissions: uniqueStringArray(permissionSchema, 0, 64).default([]),
  })
  .strict();

/** LongHub Agent Profile V1：面向用户的一键切换单位。 */
export const agentProfileSchema = z
  .object({
    schemaVersion: z.literal("longhub/agent-profile/v1"),
    id: packIdSchema,
    version: semverSchema,
    display: z
      .object({
        name: z.string().trim().min(1).max(64),
        description: z.string().trim().min(1).max(500).optional(),
        emoji: z.string().trim().min(1).max(16).optional(),
        avatar: packRelativePathSchema.optional(),
        category: z.string().trim().min(1).max(40).optional(),
        starterPrompts: uniqueStringArray(z.string().trim().min(1).max(300), 0, 8).default([]),
      })
      .strict(),
    workspace: z
      .object({
        identity: packRelativePathSchema,
        soul: packRelativePathSchema.optional(),
        agents: packRelativePathSchema.optional(),
        user: packRelativePathSchema.optional(),
      })
      .strict(),
    capabilities: z
      .array(agentCapabilitySchema)
      .min(1)
      .max(32)
      .refine((items) => uniqueValues(items.map((item) => item.id)), "Capability ID 不能重复"),
    openclaw: z
      .object({
        skills: uniqueStringArray(skillIdSchema, 0, 128).default([]),
        tools: z
          .object({
            allow: uniqueStringArray(toolIdSchema, 0, 128).default([]),
            deny: uniqueStringArray(toolIdSchema, 0, 128).default([]),
          })
          .strict()
          .refine(
            (tools) => tools.allow.every((tool) => !tools.deny.includes(tool)),
            "同一个工具不能同时出现在 allow 和 deny",
          ),
        sandbox: z.enum(["strict", "workspace-read", "workspace-write"]),
      })
      .strict(),
    memory: z.object({ mode: z.literal("isolated") }).strict(),
    lifecycle: z
      .object({
        defaultSessionTitle: z.string().trim().min(1).max(80),
        entitlementExpiryPolicy: z.enum(["readonly", "hidden", "delete"]),
      })
      .strict(),
    compatibility: z
      .object({
        minDesktopVersion: semverSchema,
        openclawVersion: semverSchema,
        profileMigrationVersion: z.number().int().min(1).max(1),
      })
      .strict(),
    modelPolicyId: modelPolicyIdSchema.default("longhub.model.default"),
  })
  .strict();

export type AgentProfile = z.infer<typeof agentProfileSchema>;
export type AgentCapability = z.infer<typeof agentCapabilitySchema>;
