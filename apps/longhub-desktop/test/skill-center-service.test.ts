import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SkillPackage } from "@longhub/pack-schema";
import { agentIdForProfile } from "../src/agent-registry.js";
import { SkillCenterService } from "../src/skill-center-service.js";
import type { SkillCatalogItem } from "../src/skill-catalog-client.js";
import { SkillLifecycleCoordinator, type CoreSkillGrant, type GatewaySkillView } from "../src/skill-lifecycle-coordinator.js";
import { SkillRegistry } from "../src/skill-registry.js";

const roots: string[] = [];
const profileId = "longhub.agent.hr";
const agentId = agentIdForProfile(profileId);
const financeProfileId = "longhub.agent.finance";
const financeAgentId = agentIdForProfile(financeProfileId);

const manifest: SkillPackage = {
  schemaVersion: "longhub/skill-package/v1",
  skill: {
    id: "longhub.skill.resume-screen", version: "1.0.0", type: "tool",
    publisher: { namespace: "longhub", displayName: "龙枢官方" },
    display: { name: "简历初筛", description: "结构化初筛", category: "招聘", examples: [] },
  },
  compatibility: { minManagerVersion: "0.6.0", openclawVersion: "2026.7.1-2", runtimeApiVersion: "1.0" },
  binding: { allowedAgentProfileIds: [profileId], defaultEnabled: false },
  schemas: {}, capabilities: { requiredSkillIds: [], connectorIds: [] },
  permissions: { requested: ["connector:hr-api:read"], confirmationClass: "none" },
  runtime: { kind: "builtin", implementationId: "longhub.worker.resume-screen" },
  limits: { maxPackageBytes: 1024, maxSteps: 1, maxDurationMs: 30_000, maxConcurrency: 1, maxCostMicros: 12_000 },
  integrity: {
    algorithm: "sha256", digest: createHash("sha256").update("1.0.0").digest("hex"),
    signatureKeyId: "skill-test", signature: "A".repeat(86) + "==",
  },
};

const catalogItem: SkillCatalogItem = {
  skillId: manifest.skill.id,
  publisher: manifest.skill.publisher,
  display: manifest.skill.display,
  type: manifest.skill.type,
  latestVersion: manifest.skill.version,
  versions: [manifest.skill.version],
  runtimeKind: "builtin",
  compatibility: manifest.compatibility,
  permissions: manifest.permissions,
  limits: manifest.limits,
  entitled: true,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("能力中心服务", () => {
  it("展示权限/费用/执行位置，失败可重试，且不能跨 Agent 绑定", async () => {
    const root = mkdtempSync(join(tmpdir(), "longhub-skill-center-"));
    roots.push(root);
    const registry = new SkillRegistry(join(root, "registry.json"), "https://cloud.example\0device-1");
    let core: readonly CoreSkillGrant[] = [];
    let gateway: readonly GatewaySkillView[] = [];
    let failGatewayOnce = true;
    const lifecycle = new SkillLifecycleCoordinator({
      registry,
      async verifyPackage() {},
      async verifyEntitlement() { return true; },
      async readCorePolicy() { return structuredClone(core); },
      async replaceCorePolicy(value) { core = structuredClone(value); },
      async readGatewaySkills() { return structuredClone(gateway); },
      async replaceGatewaySkills(value) {
        if (failGatewayOnce) { failGatewayOnce = false; throw new Error("gateway failed"); }
        gateway = structuredClone(value);
      },
    });
    const service = new SkillCenterService({
      catalog: { async list() { return [catalogItem]; }, async reference() { return manifest; } },
      registry,
      lifecycle,
      agents: () => [
        { profileId, agentId, name: "HR 助理" },
        { profileId: financeProfileId, agentId: financeAgentId, name: "财务助理" },
      ],
    });

    expect(await service.read()).toMatchObject({
      schema_version: "longhub/skill-center/v1",
      skills: [{
        skillId: manifest.skill.id,
        actionLabel: "启用",
        executionLabel: "本机内置能力",
        requestedPermissions: ["connector:hr-api:read"],
        confirmationClass: "none",
        entitled: true,
      }],
    });

    await expect(service.perform({ action: "install", skillId: manifest.skill.id, agentId }))
      .rejects.toThrow("生命周期事务失败");
    expect(registry.listSkills()).toEqual([]);
    expect(core).toEqual([]);
    expect(gateway).toEqual([]);

    const installed = await service.perform({ action: "install", skillId: manifest.skill.id, agentId });
    expect(installed.skills[0]).toMatchObject({ installedVersion: "1.0.0", maxCostMicros: 12_000 });
    expect(installed.skills[0]?.bindings).toEqual([{ agentId, enabled: true }]);

    await expect(service.perform({ action: "install", skillId: manifest.skill.id, agentId: financeAgentId }))
      .rejects.toThrow();
    expect(registry.listBindings()).toEqual([expect.objectContaining({ agentId })]);
  });
});
