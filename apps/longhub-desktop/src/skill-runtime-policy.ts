import { validateSkillPackage, type SkillPackage } from "@longhub/pack-schema";

/** 随受信 Desktop Worker 构建的实现；Catalog 不能扩展这张表。 */
export const BUILTIN_WORKER_IMPLEMENTATIONS = Object.freeze({
  "longhub.worker.echo-upper": "longhub.skill.echo-upper",
  "longhub.worker.jd-draft": "longhub.skill.jd-draft",
  "longhub.worker.chat": "longhub.skill.chat",
  "longhub.worker.resume-screen": "longhub.skill.resume-screen",
  "longhub.worker.offer-letter": "longhub.skill.offer-letter",
} as const);

export type SkillRuntimePlan =
  | {
      readonly kind: "builtin";
      readonly operation: "enable";
      readonly actionLabel: "启用";
      readonly executionLabel: "本机内置能力";
      readonly downloadsCode: false;
      readonly skillId: string;
      readonly implementationId: string;
    }
  | {
      readonly kind: "declarative";
      readonly operation: "install";
      readonly actionLabel: "安装";
      readonly executionLabel: "本机声明式内容";
      readonly downloadsCode: false;
      readonly format: "content-v1" | "workflow-v1";
      readonly entrypoint: string;
    }
  | {
      readonly kind: "cloudRef";
      readonly operation: "install-reference";
      readonly actionLabel: "安装引用";
      readonly executionLabel: "龙枢云端执行";
      readonly downloadsCode: false;
      readonly serviceId: string;
      readonly apiVersion: string;
    };

export class SkillRuntimePolicyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SkillRuntimePolicyError";
  }
}

export interface SkillRuntimePolicyOptions {
  /** Cloud Executor 中另行登记的逻辑 service ID；不是 URL。 */
  readonly cloudServiceIds?: ReadonlySet<string>;
}

/**
 * 把签名 Package 解析为产品安装语义。所有分支都明确 `downloadsCode=false`；
 * builtin 只能启用现有 Worker 实现，CloudRef 只能引用调用方给定的逻辑 allowlist。
 */
export function resolveSkillRuntimePlan(
  input: unknown,
  options: SkillRuntimePolicyOptions = {},
): { readonly manifest: SkillPackage; readonly plan: SkillRuntimePlan } {
  const parsed = validateSkillPackage(input);
  if (!parsed.ok) {
    throw new SkillRuntimePolicyError("SKILL_PACKAGE_INVALID", "Skill Package 严格校验失败");
  }
  const manifest = parsed.manifest;
  const runtime = manifest.runtime;
  if (runtime.kind === "builtin") {
    const skillId = BUILTIN_WORKER_IMPLEMENTATIONS[
      runtime.implementationId as keyof typeof BUILTIN_WORKER_IMPLEMENTATIONS
    ];
    if (!skillId || skillId !== manifest.skill.id) {
      throw new SkillRuntimePolicyError(
        "BUILTIN_IMPLEMENTATION_NOT_ALLOWED",
        "builtin 实现不在当前 Desktop Worker allowlist，或与 Skill ID 不匹配",
      );
    }
    return {
      manifest,
      plan: {
        kind: "builtin",
        operation: "enable",
        actionLabel: "启用",
        executionLabel: "本机内置能力",
        downloadsCode: false,
        skillId,
        implementationId: runtime.implementationId,
      },
    };
  }
  if (runtime.kind === "declarative") {
    return {
      manifest,
      plan: {
        kind: "declarative",
        operation: "install",
        actionLabel: "安装",
        executionLabel: "本机声明式内容",
        downloadsCode: false,
        format: runtime.format,
        entrypoint: runtime.entrypoint,
      },
    };
  }
  if (!options.cloudServiceIds?.has(runtime.serviceId)) {
    throw new SkillRuntimePolicyError(
      "CLOUD_SERVICE_NOT_ALLOWED",
      "CloudRef serviceId 不在当前 Cloud Executor allowlist",
    );
  }
  return {
    manifest,
    plan: {
      kind: "cloudRef",
      operation: "install-reference",
      actionLabel: "安装引用",
      executionLabel: "龙枢云端执行",
      downloadsCode: false,
      serviceId: runtime.serviceId,
      apiVersion: runtime.apiVersion,
    },
  };
}
