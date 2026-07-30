import { describe, expect, it } from "vitest";
import {
  computePackDigest,
  validateAgentProfile,
  validatePackContent,
  type AgentProfile,
  type PackManifest,
} from "../src/index.js";

const profile: AgentProfile = {
  schemaVersion: "longhub/agent-profile/v1",
  id: "longhub.agent.hr",
  version: "1.0.0",
  display: {
    name: "HR 助理",
    description: "招聘流程助手",
    emoji: "🦞",
    starterPrompts: ["帮我起草前端工程师 JD"],
  },
  workspace: {
    identity: "workspace/IDENTITY.md",
    soul: "workspace/SOUL.md",
  },
  capabilities: [
    {
      id: "longhub.capability.recruitment",
      skillIds: ["longhub.skill.resume-screen", "longhub.skill.offer-letter"],
      permissions: ["connector:hr-api:read", "connector:hr-api:write"],
    },
  ],
  openclaw: {
    skills: ["longhub.skill.resume-screen", "longhub.skill.offer-letter"],
    tools: { allow: ["longhub.resume_screen"], deny: [] },
    sandbox: "workspace-write",
  },
  memory: { mode: "isolated" },
  lifecycle: { defaultSessionTitle: "HR 新会话", entitlementExpiryPolicy: "readonly" },
  compatibility: {
    minDesktopVersion: "1.0.0",
    openclawVersion: "2026.7.1-2",
    profileMigrationVersion: 1,
  },
  modelPolicyId: "longhub.model.default",
};

const manifest: PackManifest = {
  schemaVersion: "longhub/v1",
  pack: { id: "longhub.hr-suite", version: "1.0.0", minDesktopVersion: "1.0.0" },
  agentTemplate: {
    id: "longhub.agent.hr",
    version: "1.0.0",
    profilePath: "agent-profile.json",
  },
  capabilities: [
    {
      id: "longhub.capability.recruitment",
      version: "1.0.0",
      required: true,
      permissions: ["connector:hr-api:read", "connector:hr-api:write"],
    },
  ],
  runtime: { sdkVersion: "1.0", executionMode: "hybrid" },
  limits: { maxConcurrentSkills: 3, maxTaskDepth: 3 },
  integrity: { algorithm: "sha256", digest: "pending", signatureKeyId: "test-key" },
};

const files = {
  "agent-profile.json": JSON.stringify(profile),
  "workspace/IDENTITY.md": "# HR 助理",
  "workspace/SOUL.md": "专注招聘工作。",
};

describe("Agent Profile V1", () => {
  it("接受结构化 Profile 并补齐后台逻辑模型策略", () => {
    const { modelPolicyId: _modelPolicyId, ...withoutDefault } = profile;
    const result = validateAgentProfile(withoutDefault);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.profile.modelPolicyId).toBe("longhub.model.default");
  });

  it("拒绝 Gateway、Provider、插件路径等未声明字段", () => {
    for (const forbidden of [
      { gatewayUrl: "ws://attacker.invalid" },
      { provider: "openai" },
      { apiKey: "secret" },
      { pluginPath: "../../evil.js" },
    ]) {
      const result = validateAgentProfile({ ...profile, ...forbidden });
      expect(result.ok).toBe(false);
    }
  });

  it("拒绝共享记忆和危险 Pack 路径", () => {
    expect(validateAgentProfile({ ...profile, memory: { mode: "shared" } }).ok).toBe(false);
    expect(
      validateAgentProfile({
        ...profile,
        workspace: { ...profile.workspace, identity: "../IDENTITY.md" },
      }).ok,
    ).toBe(false);
    expect(
      validateAgentProfile({
        ...profile,
        workspace: { ...profile.workspace, identity: "C:\\temp\\IDENTITY.md" },
      }).ok,
    ).toBe(false);
    expect(
      validateAgentProfile({
        ...profile,
        openclaw: {
          ...profile.openclaw,
          tools: { allow: ["longhub.hr"], deny: ["longhub.hr"] },
        },
      }).ok,
    ).toBe(false);
  });

  it("联合校验 Profile 引用、身份、版本、能力与权限", () => {
    const result = validatePackContent(manifest, files);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.profile.id).toBe(manifest.agentTemplate.id);

    const mismatched = {
      ...profile,
      capabilities: [{ ...profile.capabilities[0]!, permissions: ["connector:hr-api:read"] }],
    };
    const denied = validatePackContent(manifest, {
      ...files,
      "agent-profile.json": JSON.stringify(mismatched),
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.issues.some((issue) => issue.message.includes("权限"))).toBe(true);
  });

  it("拒绝缺失引用文件和不安全的制品文件名", () => {
    const missing = validatePackContent(manifest, { "agent-profile.json": JSON.stringify(profile) });
    expect(missing.ok).toBe(false);

    const traversal = validatePackContent(manifest, { ...files, "../escape.txt": "bad" });
    expect(traversal.ok).toBe(false);
  });

  it("Pack 摘要同时覆盖 Manifest 和全部 Profile 文件", () => {
    const digest = computePackDigest(manifest, files);
    expect(computePackDigest({ ...manifest, pack: { ...manifest.pack, version: "1.0.1" } }, files)).not.toBe(digest);
    expect(computePackDigest(manifest, { ...files, "workspace/SOUL.md": "被篡改" })).not.toBe(digest);
    expect(
      computePackDigest({ ...manifest, integrity: { ...manifest.integrity, digest: "另一个摘要" } }, files),
    ).toBe(digest);
  });
});

describe("Capability 依赖组合", () => {
  it("接受存在的非循环依赖，拒绝缺失与循环", () => {
    const helper = { id: "longhub.capability.helper", version: "1.0.0", required: false, permissions: [] as string[] };
    const validManifest = { ...manifest, capabilities: [{ ...manifest.capabilities[0]!, dependsOn: [helper.id] }, helper] };
    expect(validatePackContent(validManifest, files).ok).toBe(true);
    const missing = { ...manifest, capabilities: [{ ...manifest.capabilities[0]!, dependsOn: ["longhub.capability.missing"] }] };
    const missingResult = validatePackContent(missing, files);
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) expect(missingResult.issues.some((issue) => issue.message.includes("缺少依赖能力"))).toBe(true);
    const cyclic = { ...manifest, capabilities: [{ ...manifest.capabilities[0]!, dependsOn: [helper.id] }, { ...helper, dependsOn: [manifest.capabilities[0]!.id] }] };
    const cycleResult = validatePackContent(cyclic, files);
    expect(cycleResult.ok).toBe(false);
    if (!cycleResult.ok) expect(cycleResult.issues.some((issue) => issue.message.includes("循环"))).toBe(true);
  });
});
