import { z } from "zod";
import { agentProfilePathSchema } from "./agent-profile.js";
import { majorMinorSchema, packIdSchema, permissionSchema, semverSchema } from "./primitives.js";

export const executionModeSchema = z.enum(["local", "cloud", "hybrid"]);

export const capabilityRefSchema = z.object({
  id: packIdSchema,
  version: semverSchema,
  required: z.boolean().default(true),
  permissions: z.array(permissionSchema).default([]),
  dependsOn: z.array(packIdSchema).max(32).optional(),
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
    profilePath: agentProfilePathSchema,
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
