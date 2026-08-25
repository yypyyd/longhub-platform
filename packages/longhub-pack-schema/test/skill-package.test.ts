import { describe, expect, it } from "vitest";
import {
  assertSkillIdOwnership,
  computeSkillPackageDigest,
  publisherOwnsSkillId,
  signSkillPackageDigest,
  validateSkillPackage,
  verifySkillPackageSignature,
  type SkillPackage,
} from "../src/index.js";
import { generateKeyPairSync } from "node:crypto";

const valid: SkillPackage = {
  schemaVersion: "longhub/skill-package/v1",
  skill: {
    id: "longhub.skill.resume-screen",
    version: "1.0.0",
    type: "tool",
    publisher: { namespace: "longhub", displayName: "龙枢官方" },
    display: {
      name: "简历初筛",
      description: "按岗位条件生成结构化初筛结果",
      category: "招聘",
      examples: ["筛选这份前端工程师简历"],
    },
  },
  compatibility: {
    minManagerVersion: "0.6.0",
    openclawVersion: "2026.7.1-2",
    runtimeApiVersion: "1.0",
  },
  binding: { allowedAgentProfileIds: ["longhub.agent.hr"], defaultEnabled: false },
  schemas: { input: "schemas/resume-screen.input.json", output: "schemas/resume-screen.output.json" },
  capabilities: { requiredSkillIds: [], connectorIds: [] },
  permissions: { requested: ["connector:hr-api:read"], confirmationClass: "none" },
  runtime: { kind: "builtin", implementationId: "longhub.worker.resume-screen" },
  limits: {
    maxPackageBytes: 1_048_576,
    maxSteps: 1,
    maxDurationMs: 30_000,
    maxConcurrency: 2,
    maxCostMicros: 0,
  },
  integrity: {
    algorithm: "sha256",
    digest: "a".repeat(64),
    signatureKeyId: "longhub-skill-2026-01",
    signature: "Y".repeat(86) + "==",
  },
};

describe("Skill Package V1", () => {
  it("接受严格的官方 builtin 声明", () => {
    const result = validateSkillPackage(valid);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.runtime.kind).toBe("builtin");
  });

  it("接受声明式和 CloudRef，但不接受未知 runtime", () => {
    expect(validateSkillPackage({
      ...valid,
      skill: { ...valid.skill, type: "content" },
      runtime: { kind: "declarative", format: "content-v1", entrypoint: "content/SKILL.md" },
    }).ok).toBe(true);
    expect(validateSkillPackage({
      ...valid,
      skill: {
        ...valid.skill,
        id: "acme.skill.lookup",
        publisher: { namespace: "acme", displayName: "Acme" },
      },
      runtime: { kind: "cloudRef", serviceId: "acme.cloud.lookup", apiVersion: "1.0" },
    }).ok).toBe(true);
    expect(validateSkillPackage({ ...valid, runtime: { kind: "native", executable: "evil.exe" } }).ok).toBe(false);
  });

  it("逐层拒绝未知字段和本地代码/基础设施入口", () => {
    for (const candidate of [
      { ...valid, script: "run.js" },
      { ...valid, skill: { ...valid.skill, apiKey: "secret" } },
      { ...valid, runtime: { ...valid.runtime, command: "powershell.exe" } },
      { ...valid, runtime: { ...valid.runtime, pluginPath: "plugins/evil.js" } },
      { ...valid, compatibility: { ...valid.compatibility, gatewayUrl: "https://attacker.invalid" } },
    ]) {
      expect(validateSkillPackage(candidate).ok).toBe(false);
    }
  });

  it("拒绝脚本入口、路径穿越、绝对路径和非 JSON Workflow", () => {
    for (const entrypoint of ["content/run.js", "../workflow.json", "C:\\evil.json", "flow/workflow.yaml"]) {
      expect(validateSkillPackage({
        ...valid,
        skill: { ...valid.skill, type: "workflow" },
        runtime: { kind: "declarative", format: "workflow-v1", entrypoint },
      }).ok).toBe(false);
    }
  });

  it("发布方只能声明自己命名空间下的 Skill ID", () => {
    expect(publisherOwnsSkillId("longhub", "longhub.skill.resume-screen")).toBe(true);
    expect(publisherOwnsSkillId("acme", "longhub.skill.resume-screen")).toBe(false);
    const result = validateSkillPackage({
      ...valid,
      skill: { ...valid.skill, publisher: { namespace: "acme", displayName: "Acme" } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((issue) => issue.path === "skill.id")).toBe(true);
  });

  it("同一 Skill ID 不能被另一个发布方接管", () => {
    expect(() => assertSkillIdOwnership({
      skillId: "longhub.skill.resume-screen",
      publisherNamespace: "longhub",
      existingPublisherNamespace: "longhub",
    })).not.toThrow();
    expect(() => assertSkillIdOwnership({
      skillId: "acme.skill.resume-screen",
      publisherNamespace: "acme",
      existingPublisherNamespace: "longhub",
    })).toThrow("SKILL_ID_OWNERSHIP_CONFLICT");
  });

  it("非官方发布方不能声明 builtin 实现", () => {
    const result = validateSkillPackage({
      ...valid,
      skill: {
        ...valid.skill,
        id: "acme.skill.resume-screen",
        publisher: { namespace: "acme", displayName: "Acme" },
      },
    });
    expect(result.ok).toBe(false);
  });

  it("所有写入和未知动作必须逐次确认", () => {
    expect(validateSkillPackage({
      ...valid,
      permissions: { requested: ["connector:hr-api:write"], confirmationClass: "none" },
    }).ok).toBe(false);
    expect(validateSkillPackage({
      ...valid,
      permissions: { requested: ["connector:hr-api:write"], confirmationClass: "per_execution" },
    }).ok).toBe(true);
  });

  it("拒绝重复绑定、自依赖、越界限制和非规范摘要", () => {
    expect(validateSkillPackage({
      ...valid,
      binding: { ...valid.binding, allowedAgentProfileIds: ["longhub.agent.hr", "longhub.agent.hr"] },
    }).ok).toBe(false);
    expect(validateSkillPackage({
      ...valid,
      capabilities: { ...valid.capabilities, requiredSkillIds: [valid.skill.id] },
    }).ok).toBe(false);
    expect(validateSkillPackage({ ...valid, limits: { ...valid.limits, maxSteps: 21 } }).ok).toBe(false);
    expect(validateSkillPackage({ ...valid, integrity: { ...valid.integrity, digest: "ABC" } }).ok).toBe(false);
  });

  it("签名覆盖引用、runtime、权限和发布方，排除自引用签名字段", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const digest = computeSkillPackageDigest(valid);
    const signed: SkillPackage = {
      ...valid,
      integrity: {
        ...valid.integrity,
        digest,
        signature: signSkillPackageDigest(
          digest,
          privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        ),
      },
    };
    const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(verifySkillPackageSignature(signed, publicPem)).toBe(true);
    expect(verifySkillPackageSignature({
      ...signed,
      permissions: { requested: ["connector:hr-api:write"], confirmationClass: "per_execution" },
    }, publicPem)).toBe(false);
    expect(computeSkillPackageDigest({
      ...signed,
      integrity: { ...signed.integrity, digest: "f".repeat(64), signature: "Z".repeat(86) + "==" },
    })).toBe(digest);
  });
});
