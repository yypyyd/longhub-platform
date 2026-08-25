import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SkillPackage } from "@longhub/pack-schema";
import { agentIdForProfile } from "../src/agent-registry.js";
import { SkillRegistry, SkillRegistryError } from "../src/skill-registry.js";

const roots: string[] = [];
const OWNER = "https://cloud.example\0device-001";
const ownerHash = createHash("sha256").update(OWNER, "utf8").digest("hex");

function manifest(version = "1.0.0", overrides: Partial<SkillPackage> = {}): SkillPackage {
  return {
    schemaVersion: "longhub/skill-package/v1",
    skill: {
      id: "longhub.skill.resume-screen",
      version,
      type: "tool",
      publisher: { namespace: "longhub", displayName: "龙枢官方" },
      display: { name: "简历初筛", description: "结构化初筛", category: "招聘", examples: [] },
    },
    compatibility: {
      minManagerVersion: "0.6.0",
      openclawVersion: "2026.7.1-2",
      runtimeApiVersion: "1.0",
    },
    binding: { allowedAgentProfileIds: ["longhub.agent.hr"], defaultEnabled: false },
    schemas: {},
    capabilities: { requiredSkillIds: [], connectorIds: [] },
    permissions: { requested: ["connector:hr-api:read"], confirmationClass: "none" },
    runtime: { kind: "builtin", implementationId: "longhub.worker.resume-screen" },
    limits: { maxPackageBytes: 1024, maxSteps: 1, maxDurationMs: 30_000, maxConcurrency: 1, maxCostMicros: 0 },
    integrity: {
      algorithm: "sha256",
      digest: createHash("sha256").update(version).digest("hex"),
      signatureKeyId: "longhub-skill-test",
      signature: "Y".repeat(86) + "==",
    },
    ...overrides,
  };
}

function fixture(clock?: () => Date): { registry: SkillRegistry; path: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "longhub-skill-registry-"));
  roots.push(root);
  const path = join(root, "skill-registry.json");
  return { registry: new SkillRegistry(path, OWNER, clock), path, root };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Skill Registry 与 Agent-Skill Binding", () => {
  it("原子安装并持久化严格 Skill 身份", () => {
    const { registry, path } = fixture();
    const installed = registry.install(manifest());
    expect(installed).toMatchObject({
      skillId: "longhub.skill.resume-screen",
      publisherNamespace: "longhub",
      activeVersion: "1.0.0",
      status: "installed",
    });
    expect(new SkillRegistry(path, OWNER).findSkill(installed.skillId)).toEqual(installed);
    expect(() => readFileSync(`${path}.tmp`, "utf8")).toThrow();
  });

  it("升级保持发布方所有权、记录上一版本且同版本内容不可变", () => {
    const { registry } = fixture();
    registry.install(manifest("1.0.0"));
    const upgraded = registry.install(manifest("1.1.0"));
    expect(upgraded).toMatchObject({ activeVersion: "1.1.0", previousVersion: "1.0.0" });
    expect(upgraded.versions).toHaveLength(2);
    expect(() => registry.install({
      ...manifest("1.1.0"),
      integrity: { ...manifest("1.1.0").integrity, digest: "f".repeat(64) },
    })).toThrow("同一 Skill 版本");
  });

  it("每个 Agent 独立绑定，拒绝 Profile/agentId 错配和未允许 Profile", () => {
    const { registry } = fixture();
    registry.install(manifest());
    const agentId = agentIdForProfile("longhub.agent.hr");
    expect(registry.bind({ skillId: "longhub.skill.resume-screen", profileId: "longhub.agent.hr", agentId })).toMatchObject({
      enabled: false,
      profileId: "longhub.agent.hr",
      agentId,
    });
    expect(registry.listBindings(agentId)).toHaveLength(1);
    expect(() => registry.bind({
      skillId: "longhub.skill.resume-screen",
      profileId: "longhub.agent.hr",
      agentId: "attacker",
    })).toThrow("不匹配");
    expect(() => registry.bind({
      skillId: "longhub.skill.resume-screen",
      profileId: "longhub.agent.finance",
      agentId: agentIdForProfile("longhub.agent.finance"),
    })).toThrow("不允许");
  });

  it("owner scope 不匹配时拒绝复用其他设备/Cloud 的 Registry", () => {
    const { registry, path } = fixture();
    registry.install(manifest());
    expect(() => new SkillRegistry(path, "https://other.example\0device-002")).toThrowError(
      expect.objectContaining({ code: "SKILL_REGISTRY_OWNER_MISMATCH" }),
    );
  });

  it("把严格 v0 状态一次性迁移到 v1 并补齐时间/版本记录", () => {
    const { path } = fixture(() => new Date("2026-07-30T12:00:00.000Z"));
    const agentId = agentIdForProfile("longhub.agent.hr");
    writeFileSync(path, JSON.stringify({
      schemaVersion: "longhub/skill-registry/v0",
      ownerHash,
      revision: 4,
      skills: [manifest()],
      bindings: [{ skillId: "longhub.skill.resume-screen", profileId: "longhub.agent.hr", agentId, enabled: true }],
    }), "utf8");
    const migrated = new SkillRegistry(path, OWNER, () => new Date("2026-07-30T12:00:00.000Z"));
    expect(migrated.findSkill("longhub.skill.resume-screen")).toMatchObject({ activeVersion: "1.0.0" });
    expect(migrated.listBindings()).toMatchObject([{ createdAt: "2026-07-30T12:00:00.000Z" }]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      schemaVersion: "longhub/skill-registry/v1",
      revision: 5,
    });
  });

  it("当前文件损坏时从上一个原子备份恢复，不信任损坏的新状态", () => {
    const { registry, path } = fixture();
    registry.install(manifest());
    registry.bind({
      skillId: "longhub.skill.resume-screen",
      profileId: "longhub.agent.hr",
      agentId: agentIdForProfile("longhub.agent.hr"),
      enabled: true,
    });
    writeFileSync(path, "{corrupt", "utf8");
    const recovered = new SkillRegistry(path, OWNER);
    expect(recovered.findSkill("longhub.skill.resume-screen")).toBeDefined();
    expect(recovered.listBindings()).toHaveLength(0);
    expect(JSON.parse(readFileSync(path, "utf8")).schemaVersion).toBe("longhub/skill-registry/v1");
  });

  it("当前与备份均损坏或出现未知字段时安全失败", () => {
    const { registry, path } = fixture();
    registry.install(manifest());
    registry.bind({
      skillId: "longhub.skill.resume-screen",
      profileId: "longhub.agent.hr",
      agentId: agentIdForProfile("longhub.agent.hr"),
    });
    writeFileSync(path, JSON.stringify({ schemaVersion: "longhub/skill-registry/v1", ownerHash, revision: 2, skills: [], bindings: [], extra: true }), "utf8");
    writeFileSync(`${path}.bak`, "{bad", "utf8");
    expect(() => new SkillRegistry(path, OWNER)).toThrow(SkillRegistryError);
  });

  it("快照恢复以新 revision 原子提交，不回拨状态版本", () => {
    const { registry, path } = fixture();
    registry.install(manifest());
    const snapshot = registry.snapshot();
    registry.install(manifest("1.1.0"));
    registry.restore(snapshot);
    expect(registry.findSkill("longhub.skill.resume-screen")?.activeVersion).toBe("1.0.0");
    expect(JSON.parse(readFileSync(path, "utf8")).revision).toBeGreaterThan(snapshot.revision);
  });
});
