import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildHrAgentProfile, buildHrPackSource } from "@longhub/hr-suite";
import { AgentRegistry, AgentRegistryError, agentIdForProfile } from "../src/agent-registry.js";

const temporaryDirectories: string[] = [];

function registryFixture(): { registry: AgentRegistry; filePath: string } {
  const directory = mkdtempSync(join(tmpdir(), "longhub-agent-registry-"));
  temporaryDirectories.push(directory);
  const filePath = join(directory, "agent-registry.json");
  return { registry: new AgentRegistry(filePath), filePath };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Agent Registry", () => {
  it("为 Profile 创建稳定且持久化的 OpenClaw agentId", () => {
    const { registry, filePath } = registryFixture();
    const source = buildHrPackSource("1.0.0");
    const first = registry.register({ manifest: source.manifest, files: source.files });

    expect(first.agentId).toBe(agentIdForProfile("longhub.agent.hr"));
    expect(first.agentId).not.toBe("main");
    expect(readFileSync(filePath, "utf8")).toContain(first.agentId);
    expect(new AgentRegistry(filePath).findByProfile("longhub.agent.hr")).toEqual(first);
    expect(() => readFileSync(`${filePath}.tmp`, "utf8")).toThrow();
  });

  it("升级和回滚 Profile 时保持 agentId 不变", () => {
    const { registry } = registryFixture();
    const firstSource = buildHrPackSource("1.0.0");
    const first = registry.register({ manifest: firstSource.manifest, files: firstSource.files });
    const nextProfile = { ...buildHrAgentProfile(), version: "1.1.0" };
    const nextManifest = {
      ...buildHrPackSource("1.1.0").manifest,
      agentTemplate: { ...firstSource.manifest.agentTemplate, version: nextProfile.version },
    };
    const upgraded = registry.register({
      manifest: nextManifest,
      files: { ...firstSource.files, "agent-profile.json": JSON.stringify(nextProfile) },
    });

    expect(upgraded.agentId).toBe(first.agentId);
    expect(upgraded).toMatchObject({ packVersion: "1.1.0", profileVersion: "1.1.0" });
  });

  it("支持停用和重新启用，未知 Profile 安全失败", () => {
    const { registry } = registryFixture();
    const source = buildHrPackSource("1.0.0");
    registry.register({ manifest: source.manifest, files: source.files });

    expect(registry.setEnabled("longhub.agent.hr", false).enabled).toBe(false);
    expect(registry.enabled()).toHaveLength(0);
    expect(registry.setEnabled("longhub.agent.hr", true).enabled).toBe(true);
    expect(() => registry.setEnabled("longhub.agent.missing", false)).toThrow(AgentRegistryError);
  });

  it("拒绝其他 Pack 劫持已注册 Profile", () => {
    const { registry } = registryFixture();
    const source = buildHrPackSource("1.0.0");
    registry.register({ manifest: source.manifest, files: source.files });
    const hijacked = { ...source.manifest, pack: { ...source.manifest.pack, id: "evil.fake-pack" } };
    expect(() => registry.register({ manifest: hijacked, files: source.files })).toThrow(
      "已归属于",
    );
  });

  it("Registry 损坏、未知字段或伪造 main 映射时拒绝加载", () => {
    const { filePath } = registryFixture();
    writeFileSync(filePath, "{bad json", "utf8");
    expect(() => new AgentRegistry(filePath)).toThrow(AgentRegistryError);

    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: "longhub/agent-registry/v1",
        revision: 1,
        entries: [
          {
            profileId: "longhub.agent.hr",
            agentId: "main",
            packId: "longhub.hr-suite",
            profileVersion: "1.0.0",
            packVersion: "1.0.0",
            enabled: true,
          },
        ],
      }),
      "utf8",
    );
    expect(() => new AgentRegistry(filePath)).toThrow(AgentRegistryError);
  });
});
