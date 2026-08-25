import { describe, expect, it } from "vitest";
import type { SkillPackage } from "@longhub/pack-schema";
import {
  BUILTIN_WORKER_IMPLEMENTATIONS,
  resolveSkillRuntimePlan,
  SkillRuntimePolicyError,
} from "../src/skill-runtime-policy.js";

const builtin: SkillPackage = {
  schemaVersion: "longhub/skill-package/v1",
  skill: {
    id: "longhub.skill.resume-screen",
    version: "1.0.0",
    type: "tool",
    publisher: { namespace: "longhub", displayName: "龙枢官方" },
    display: { name: "简历初筛", description: "生成结构化初筛结果", category: "招聘", examples: [] },
  },
  compatibility: { minManagerVersion: "0.6.0", openclawVersion: "2026.7.1-2", runtimeApiVersion: "1.0" },
  binding: { allowedAgentProfileIds: ["longhub.agent.hr"], defaultEnabled: false },
  schemas: {},
  capabilities: { requiredSkillIds: [], connectorIds: [] },
  permissions: { requested: ["connector:hr-api:read"], confirmationClass: "none" },
  runtime: { kind: "builtin", implementationId: "longhub.worker.resume-screen" },
  limits: { maxPackageBytes: 1024, maxSteps: 1, maxDurationMs: 30_000, maxConcurrency: 1, maxCostMicros: 0 },
  integrity: {
    algorithm: "sha256",
    digest: "a".repeat(64),
    signatureKeyId: "longhub-skill-test",
    signature: "A".repeat(86) + "==",
  },
};

describe("Skill 三态运行语义", () => {
  it("builtin 只显示启用，且映射到随 Worker 构建的同 ID 实现", () => {
    const result = resolveSkillRuntimePlan(builtin);
    expect(result.plan).toMatchObject({
      kind: "builtin",
      operation: "enable",
      actionLabel: "启用",
      executionLabel: "本机内置能力",
      downloadsCode: false,
      skillId: builtin.skill.id,
    });
    expect(BUILTIN_WORKER_IMPLEMENTATIONS).toHaveProperty("longhub.worker.resume-screen", builtin.skill.id);
  });

  it("builtin 未知实现或实现与 Skill ID 错配时拒绝", () => {
    for (const implementationId of ["longhub.worker.unknown", "longhub.worker.offer-letter"]) {
      expect(() => resolveSkillRuntimePlan({
        ...builtin,
        runtime: { kind: "builtin", implementationId },
      })).toThrow(SkillRuntimePolicyError);
    }
  });

  it("声明式内容使用安装语义，但明确不下载代码", () => {
    const result = resolveSkillRuntimePlan({
      ...builtin,
      skill: { ...builtin.skill, id: "acme.skill.guide", type: "content", publisher: { namespace: "acme", displayName: "Acme" } },
      permissions: { requested: [], confirmationClass: "none" },
      runtime: { kind: "declarative", format: "content-v1", entrypoint: "content/SKILL.md" },
    });
    expect(result.plan).toMatchObject({
      kind: "declarative",
      operation: "install",
      actionLabel: "安装",
      executionLabel: "本机声明式内容",
      downloadsCode: false,
    });
  });

  it("CloudRef 只安装 allowlist 中的逻辑引用，不接受任意服务", () => {
    const cloud = {
      ...builtin,
      skill: { ...builtin.skill, id: "longhub.skill.cloud-screen" },
      runtime: { kind: "cloudRef", serviceId: "longhub.cloud.resume-screen", apiVersion: "1.0" },
    };
    expect(() => resolveSkillRuntimePlan(cloud)).toThrowError("CloudRef serviceId 不在");
    expect(resolveSkillRuntimePlan(cloud, {
      cloudServiceIds: new Set(["longhub.cloud.resume-screen"]),
    }).plan).toMatchObject({
      kind: "cloudRef",
      operation: "install-reference",
      actionLabel: "安装引用",
      executionLabel: "龙枢云端执行",
      downloadsCode: false,
    });
  });

  it("未知 runtime 在进入语义分派前由严格 Package 拒绝", () => {
    expect(() => resolveSkillRuntimePlan({
      ...builtin,
      runtime: { kind: "native", executable: "evil.exe" },
    })).toThrowError("Skill Package 严格校验失败");
  });
});
