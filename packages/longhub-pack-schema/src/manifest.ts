import { z } from "zod";

/** 语义化版本，如 1.3.0 */
export const semverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, "必须是语义化版本号，如 1.3.0");

/** 主次版本，如 1.0 */
export const majorMinorSchema = z
  .string()
  .regex(/^\d+\.\d+$/, "必须是主次版本号，如 1.0");

/** 权限声明，如 connector:hr-api:read */
export const permissionSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*(:[a-z0-9_.-]+)+$/, "权限格式：<类别>:<资源>[:<动作>]");

export const packIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/, "ID 使用点分小写命名，如 longhub.hr-suite");

export const executionModeSchema = z.enum(["local", "cloud", "hybrid"]);

export const capabilityRefSchema = z.object({
  id: packIdSchema,
  version: semverSchema,
  required: z.boolean().default(true),
  permissions: z.array(permissionSchema).default([]),
});

/** LongHub Pack Manifest V1（冻结契约） */
export const packManifestSchema = z.object({
  schemaVersion: z.literal("longhub/v1"),
  pack: z.object({
    id: packIdSchema,
    version: semverSchema,
    minDesktopVersion: semverSchema,
  }),
  agentTemplate: z.object({
    id: packIdSchema,
    version: semverSchema,
  }),
  capabilities: z.array(capabilityRefSchema).min(1),
  runtime: z.object({
    sdkVersion: majorMinorSchema,
    executionMode: executionModeSchema,
  }),
  limits: z.object({
    maxConcurrentSkills: z.number().int().min(1).max(16),
    maxTaskDepth: z.number().int().min(1).max(8),
  }),
  integrity: z.object({
    algorithm: z.literal("sha256"),
    digest: z.string().min(1),
    signatureKeyId: z.string().min(1),
  }),
});

export type PackManifest = z.infer<typeof packManifestSchema>;
export type CapabilityRef = z.infer<typeof capabilityRefSchema>;
export type ExecutionMode = z.infer<typeof executionModeSchema>;
