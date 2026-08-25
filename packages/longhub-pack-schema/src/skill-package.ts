import { createHash } from "node:crypto";
import { z } from "zod";
import {
  majorMinorSchema,
  packIdSchema,
  packRelativePathSchema,
  permissionSchema,
  semverSchema,
} from "./primitives.js";
import type { ValidationIssue } from "./validate.js";
import { canonicalStringify, signPackDigest, verifyPackSignature } from "./integrity.js";

const uniqueValues = <T>(values: readonly T[]): boolean => new Set(values).size === values.length;
const uniqueArray = <T extends z.ZodTypeAny>(item: T, max: number, min = 0) =>
  z.array(item).min(min).max(max).refine(uniqueValues, "列表中不能有重复项");

export const publisherNamespaceSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){0,4}$/,
    "发布方命名空间使用最多五段点分小写名称",
  );

export const skillPackageIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*\.skill\.[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/,
    "Skill ID 格式为 <publisher>.skill.<name>",
  );

const connectorIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*\.connector\.[a-z][a-z0-9-]*$/, "Connector ID 格式不合法");

const signatureKeyIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_.-]*$/, "签名密钥 ID 格式不合法");

const schemaReferenceSchema = packRelativePathSchema.refine(
  (value) => value.endsWith(".json"),
  "输入输出 Schema 必须引用 JSON 文件",
);

const builtinRuntimeSchema = z
  .object({
    kind: z.literal("builtin"),
    implementationId: packIdSchema,
  })
  .strict();

const declarativeRuntimeSchema = z
  .object({
    kind: z.literal("declarative"),
    format: z.enum(["content-v1", "workflow-v1"]),
    entrypoint: packRelativePathSchema,
  })
  .strict();

const cloudRefRuntimeSchema = z
  .object({
    kind: z.literal("cloudRef"),
    serviceId: packIdSchema,
    apiVersion: majorMinorSchema,
  })
  .strict();

export const skillRuntimeSchema = z.discriminatedUnion("kind", [
  builtinRuntimeSchema,
  declarativeRuntimeSchema,
  cloudRefRuntimeSchema,
]);

export function publisherOwnsSkillId(namespace: string, skillId: string): boolean {
  return skillId.startsWith(`${namespace}.skill.`) && skillId.length > namespace.length + ".skill.".length;
}

function requiresPerExecutionConfirmation(permission: string): boolean {
  const action = permission.split(":").at(-1);
  return action !== "read" && action !== "list" && action !== "search";
}

/** LongHub Skill Package V1：只描述内置、声明式或 CloudRef，不包含本地代码入口。 */
export const skillPackageSchema = z
  .object({
    schemaVersion: z.literal("longhub/skill-package/v1"),
    skill: z
      .object({
        id: skillPackageIdSchema,
        version: semverSchema,
        type: z.enum(["content", "workflow", "tool"]),
        publisher: z
          .object({
            namespace: publisherNamespaceSchema,
            displayName: z.string().trim().min(1).max(80),
          })
          .strict(),
        display: z
          .object({
            name: z.string().trim().min(1).max(80),
            description: z.string().trim().min(1).max(500),
            category: z.string().trim().min(1).max(40),
            examples: uniqueArray(z.string().trim().min(1).max(300), 8).default([]),
          })
          .strict(),
      })
      .strict(),
    compatibility: z
      .object({
        minManagerVersion: semverSchema,
        openclawVersion: semverSchema,
        runtimeApiVersion: majorMinorSchema,
      })
      .strict(),
    binding: z
      .object({
        allowedAgentProfileIds: uniqueArray(packIdSchema, 64, 1),
        defaultEnabled: z.boolean(),
      })
      .strict(),
    schemas: z
      .object({
        input: schemaReferenceSchema.optional(),
        output: schemaReferenceSchema.optional(),
      })
      .strict(),
    capabilities: z
      .object({
        requiredSkillIds: uniqueArray(skillPackageIdSchema, 32).default([]),
        connectorIds: uniqueArray(connectorIdSchema, 16).default([]),
      })
      .strict(),
    permissions: z
      .object({
        requested: uniqueArray(permissionSchema, 64).default([]),
        confirmationClass: z.enum(["none", "per_execution"]),
      })
      .strict(),
    runtime: skillRuntimeSchema,
    limits: z
      .object({
        maxPackageBytes: z.number().int().min(1).max(64 * 1024 * 1024),
        maxSteps: z.number().int().min(1).max(20),
        maxDurationMs: z.number().int().min(1_000).max(10 * 60_000),
        maxConcurrency: z.number().int().min(1).max(16),
        maxCostMicros: z.number().int().min(0).max(100_000_000),
      })
      .strict(),
    integrity: z
      .object({
        algorithm: z.literal("sha256"),
        digest: z.string().regex(/^[a-f0-9]{64}$/, "摘要必须是 64 位小写 SHA-256"),
        signatureKeyId: signatureKeyIdSchema,
        signature: z.string().min(64).max(1024).regex(/^[A-Za-z0-9+/]+={0,2}$/, "签名必须是 Base64"),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const namespace = manifest.skill.publisher.namespace;
    if (!publisherOwnsSkillId(namespace, manifest.skill.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["skill", "id"],
        message: "Skill ID 不属于声明的发布方命名空间",
      });
    }
    if (manifest.runtime.kind === "builtin" && namespace !== "longhub") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runtime", "kind"],
        message: "builtin 运行时只允许 longhub 官方命名空间",
      });
    }
    if (manifest.runtime.kind === "declarative") {
      const valid = manifest.runtime.format === "content-v1"
        ? manifest.runtime.entrypoint.endsWith(".md") || manifest.runtime.entrypoint.endsWith(".json")
        : manifest.runtime.entrypoint.endsWith(".json");
      if (!valid) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["runtime", "entrypoint"],
          message: manifest.runtime.format === "content-v1"
            ? "Content 入口必须是 Markdown 或 JSON"
            : "Workflow 入口必须是 JSON",
        });
      }
    }
    if (
      manifest.permissions.confirmationClass === "none" &&
      manifest.permissions.requested.some(requiresPerExecutionConfirmation)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["permissions", "confirmationClass"],
        message: "写入、发送、删除、支付及未知动作必须逐次确认",
      });
    }
    if (manifest.capabilities.requiredSkillIds.includes(manifest.skill.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities", "requiredSkillIds"],
        message: "Skill 不能依赖自身",
      });
    }
  });

export type SkillPackage = z.infer<typeof skillPackageSchema>;
export type SkillRuntime = z.infer<typeof skillRuntimeSchema>;

export type SkillPackageValidationResult =
  | { ok: true; manifest: SkillPackage }
  | { ok: false; issues: ValidationIssue[] };

export function validateSkillPackage(input: unknown): SkillPackageValidationResult {
  const parsed = skillPackageSchema.safeParse(input);
  if (parsed.success) return { ok: true, manifest: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  };
}

/** 摘要覆盖完整 Skill 引用，仅排除自引用 digest/signature。 */
export function computeSkillPackageDigest(manifest: SkillPackage): string {
  const { digest: _digest, signature: _signature, ...integrity } = manifest.integrity;
  return createHash("sha256")
    .update(canonicalStringify({ ...manifest, integrity }), "utf8")
    .digest("hex");
}

export function signSkillPackageDigest(digest: string, privateKeyPem: string): string {
  return signPackDigest(digest, privateKeyPem);
}

export function verifySkillPackageSignature(
  manifest: SkillPackage,
  publicKeyPem: string,
): boolean {
  const digest = computeSkillPackageDigest(manifest);
  return digest === manifest.integrity.digest &&
    verifyPackSignature(digest, manifest.integrity.signature, publicKeyPem);
}

export function assertSkillIdOwnership(params: {
  skillId: string;
  publisherNamespace: string;
  existingPublisherNamespace?: string;
}): void {
  if (!publisherOwnsSkillId(params.publisherNamespace, params.skillId)) {
    throw new Error("SKILL_ID_NAMESPACE_MISMATCH");
  }
  if (
    params.existingPublisherNamespace !== undefined &&
    params.existingPublisherNamespace !== params.publisherNamespace
  ) {
    throw new Error("SKILL_ID_OWNERSHIP_CONFLICT");
  }
}
