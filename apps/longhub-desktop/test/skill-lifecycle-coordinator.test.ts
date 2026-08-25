import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SkillPackage } from "@longhub/pack-schema";
import { agentIdForProfile } from "../src/agent-registry.js";
import {
  SkillLifecycleCoordinator,
  SkillLifecycleError,
  type CoreSkillGrant,
  type GatewaySkillView,
} from "../src/skill-lifecycle-coordinator.js";
import { SkillRegistry } from "../src/skill-registry.js";

const roots: string[] = [];
const profileId = "longhub.agent.hr";
const agentId = agentIdForProfile(profileId);

function manifest(version: string): SkillPackage {
  return {
    schemaVersion: "longhub/skill-package/v1",
    skill: {
      id: "longhub.skill.resume-screen",
      version,
      type: "tool",
      publisher: { namespace: "longhub", displayName: "龙枢官方" },
      display: { name: "简历初筛", description: "结构化初筛", category: "招聘", examples: [] },
    },
    compatibility: { minManagerVersion: "0.6.0", openclawVersion: "2026.7.1-2", runtimeApiVersion: "1.0" },
    binding: { allowedAgentProfileIds: [profileId], defaultEnabled: false },
    schemas: {},
    capabilities: { requiredSkillIds: [], connectorIds: [] },
    permissions: { requested: ["connector:hr-api:read"], confirmationClass: "none" },
    runtime: { kind: "builtin", implementationId: "longhub.worker.resume-screen" },
    limits: { maxPackageBytes: 1024, maxSteps: 1, maxDurationMs: 30_000, maxConcurrency: 1, maxCostMicros: 0 },
    integrity: {
      algorithm: "sha256",
      digest: createHash("sha256").update(version).digest("hex"),
      signatureKeyId: "longhub-skill-test",
      signature: "A".repeat(86) + "==",
    },
  };
}

function fixture(options: { entitled?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "longhub-skill-lifecycle-"));
  roots.push(root);
  const registry = new SkillRegistry(join(root, "skill-registry.json"), "https://cloud.example\0device-001");
  let core: readonly CoreSkillGrant[] = [];
  let gateway: readonly GatewaySkillView[] = [];
  let failGatewayOnce = false;
  const writes: string[] = [];
  const coordinator = new SkillLifecycleCoordinator({
    registry,
    async verifyPackage() {},
    async verifyEntitlement() { return options.entitled ?? true; },
    async readCorePolicy() { return structuredClone(core); },
    async replaceCorePolicy(value) {
      writes.push("core:" + value.length);
      core = structuredClone(value);
    },
    async readGatewaySkills() { return structuredClone(gateway); },
    async replaceGatewaySkills(value) {
      writes.push("gateway:" + value.length);
      if (failGatewayOnce) {
        failGatewayOnce = false;
        throw new Error("gateway write failed");
      }
      gateway = structuredClone(value);
    },
  });
  return {
    registry,
    coordinator,
    writes,
    state: () => ({ core, gateway }),
    failNextGateway: () => { failGatewayOnce = true; },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Skill Core/Gateway/Registry 补偿事务", () => {
  it("安装绑定、启用、升级、回滚、停用和卸载保持三方一致", async () => {
    const ctx = fixture();
    await ctx.coordinator.install({ package: manifest("1.0.0"), profileId, agentId });
    expect(ctx.registry.listBindings()).toEqual([expect.objectContaining({ agentId, enabled: false })]);
    expect(ctx.state()).toEqual({ core: [], gateway: [] });

    await ctx.coordinator.setEnabled("longhub.skill.resume-screen", agentId, true);
    expect(ctx.state().core).toEqual([
      expect.objectContaining({ agentId, skillId: "longhub.skill.resume-screen", version: "1.0.0" }),
    ]);
    expect(ctx.state().gateway).toEqual([
      expect.objectContaining({ agentId, skillId: "longhub.skill.resume-screen", runtimeKind: "builtin" }),
    ]);

    await ctx.coordinator.upgrade(manifest("1.1.0"));
    expect(ctx.registry.findSkill("longhub.skill.resume-screen")).toMatchObject({
      activeVersion: "1.1.0",
      previousVersion: "1.0.0",
    });
    expect(ctx.state().core[0]?.version).toBe("1.1.0");

    await ctx.coordinator.rollback("longhub.skill.resume-screen");
    expect(ctx.registry.findSkill("longhub.skill.resume-screen")).toMatchObject({
      activeVersion: "1.0.0",
      previousVersion: "1.1.0",
    });
    expect(ctx.state().core[0]?.version).toBe("1.0.0");

    await ctx.coordinator.setEnabled("longhub.skill.resume-screen", agentId, false);
    expect(ctx.state()).toEqual({ core: [], gateway: [] });
    await ctx.coordinator.uninstall("longhub.skill.resume-screen");
    expect(ctx.registry.listSkills()).toEqual([]);
    expect(ctx.registry.listBindings()).toEqual([]);
  });

  it("Gateway 写失败时补偿恢复 Core、Gateway 和 Registry", async () => {
    const ctx = fixture();
    await ctx.coordinator.install({ package: manifest("1.0.0"), profileId, agentId });
    const before = ctx.registry.snapshot();
    ctx.failNextGateway();
    await expect(ctx.coordinator.setEnabled("longhub.skill.resume-screen", agentId, true))
      .rejects.toBeInstanceOf(SkillLifecycleError);
    expect(ctx.registry.listSkills()).toEqual(before.skills);
    expect(ctx.registry.listBindings()).toEqual(before.bindings);
    expect(ctx.state()).toEqual({ core: [], gateway: [] });
    expect(ctx.writes.slice(-4)).toEqual(["core:1", "gateway:1", "gateway:0", "core:0"]);
  });

  it("撤销先从 Core 移除再隐藏 Gateway，并禁止重新启用", async () => {
    const ctx = fixture();
    await ctx.coordinator.install({ package: manifest("1.0.0"), profileId, agentId, enabled: true });
    ctx.writes.length = 0;
    await ctx.coordinator.revoke("longhub.skill.resume-screen");
    expect(ctx.writes).toEqual(["core:0", "gateway:0"]);
    expect(ctx.state()).toEqual({ core: [], gateway: [] });
    expect(ctx.registry.findSkill("longhub.skill.resume-screen")?.status).toBe("revoked");
    expect(ctx.registry.listBindings()[0]?.enabled).toBe(false);
    await expect(ctx.coordinator.setEnabled("longhub.skill.resume-screen", agentId, true)).rejects.toThrow();
  });

  it("无有效 entitlement 时在任何 Registry 写入前失败", async () => {
    const ctx = fixture({ entitled: false });
    await expect(ctx.coordinator.install({ package: manifest("1.0.0"), profileId, agentId, enabled: true }))
      .rejects.toMatchObject({ code: "SKILL_NOT_ENTITLED" });
    expect(ctx.registry.listSkills()).toEqual([]);
    expect(ctx.writes).toEqual([]);
  });
});
