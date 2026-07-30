import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CoreRuntime, type BridgeExecutionPolicy } from "@longhub/core";
import { buildHrPackSource, HR_PACK_ID } from "@longhub/hr-suite";
import { computePackDigest, signPackDigest } from "@longhub/pack-schema";
import { AgentLifecycleCoordinator } from "../src/agent-lifecycle-coordinator.js";
import { composeOpenClawAgentConfig } from "../src/agent-config-composer.js";
import { activateInstalledAgentProfiles, BUNDLED_OPENCLAW_VERSION } from "../src/agent-runtime-activation.js";
import { AgentRegistry } from "../src/agent-registry.js";
import type {
  GatewayAgentsResult,
  GatewayConfigSnapshot,
  OpenClawGatewayClient,
} from "../src/openclaw-gateway-client.js";
import type { PackEligibilitySource } from "../src/pack-eligibility.js";
import { buildOpenClawConfig, initializeOpenClawWorkspace } from "../src/openclaw-runtime.js";
import { PackInstaller } from "../src/pack-installer.js";
import { buildToolBridgePolicy } from "../src/tool-bridge-policy.js";

const temporaryDirectories: string[] = [];
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const KEY_ID = "longhub-lifecycle-test";

class MemoryEligibility implements PackEligibilitySource {
  eligible = new Set([HR_PACK_ID]);
  error: Error | undefined;

  async eligiblePackIds(): Promise<ReadonlySet<string>> {
    if (this.error) throw this.error;
    return new Set(this.eligible);
  }
}

class MemoryGateway implements OpenClawGatewayClient {
  revision = 1;
  failNextReplace = false;

  constructor(public config: Record<string, unknown>) {}

  async getConfig(): Promise<GatewayConfigSnapshot> {
    return { hash: `h-${this.revision}`, config: structuredClone(this.config) };
  }

  async replaceAgents(agents: readonly unknown[], baseHash: string): Promise<void> {
    if (baseHash !== `h-${this.revision}`) throw new Error("baseHash conflict");
    if (this.failNextReplace) {
      this.failNextReplace = false;
      throw new Error("injected config.patch failure");
    }
    const currentAgents = this.config.agents as Record<string, unknown>;
    this.config = {
      ...this.config,
      agents: { ...currentAgents, list: structuredClone(agents) },
    };
    this.revision += 1;
  }

  async listAgents(): Promise<GatewayAgentsResult> {
    const list = ((this.config.agents as { list: Array<{ id: string }> }).list);
    return { defaultId: "main", agents: list.map((agent) => ({ id: agent.id })) };
  }
}

function agentIds(config: Record<string, unknown>): string[] {
  return (config.agents as { list: Array<{ id: string }> }).list.map((agent) => agent.id);
}

function fixture(onPolicyReplace?: (policy: BridgeExecutionPolicy) => void) {
  const root = mkdtempSync(join(tmpdir(), "longhub-agent-lifecycle-"));
  temporaryDirectories.push(root);
  const stateDir = join(root, "openclaw");
  const mainWorkspaceDir = join(stateDir, "workspace");
  initializeOpenClawWorkspace(mainWorkspaceDir);
  const source = buildHrPackSource("1.0.0");
  source.manifest.integrity.signatureKeyId = KEY_ID;
  source.manifest.integrity.digest = computePackDigest(source.manifest, source.files);
  const installer = new PackInstaller(join(root, "packs"));
  expect(installer.install({
    manifest: source.manifest,
    files: source.files,
    signature: signPackDigest(source.manifest.integrity.digest, privatePem),
  }, {
    trustedKeys: new Map([[KEY_ID, publicPem]]),
    desktopVersion: "0.3.6",
  }).ok).toBe(true);
  const registry = new AgentRegistry(join(root, "agent-registry.json"));
  const profiles = activateInstalledAgentProfiles({ installer, registry, stateDir });
  const runtime = {
    provider_id: "longhub" as const,
    base_path: "/v1/model",
    model_id: "longhub-default" as const,
    display_name: "龙枢默认模型",
    api_type: "openai-completions" as const,
    context_window: 128_000,
    max_tokens: 8_192,
    allow_user_model_selection: false as const,
  };
  const baseConfig = buildOpenClawConfig("https://cloud.example", runtime, mainWorkspaceDir);
  const composer = {
    stateDir,
    mainWorkspaceDir,
    desktopVersion: "0.3.6",
    openclawVersion: BUNDLED_OPENCLAW_VERSION,
    modelPolicies: { "longhub.model.default": "longhub/longhub-default" },
  };
  const config = composeOpenClawAgentConfig(baseConfig, { ...composer, profiles });
  const gateway = new MemoryGateway(config);
  const eligibility = new MemoryEligibility();
  let bridgePolicy: BridgeExecutionPolicy = buildToolBridgePolicy(profiles);
  const removed: string[][] = [];
  const changed: Array<Array<{ id: string; label: string }>> = [];
  const coordinator = new AgentLifecycleCoordinator({
    installer,
    registry,
    installContext: { trustedKeys: new Map([[KEY_ID, publicPem]]), desktopVersion: "0.3.6" },
    stateDir,
    baseConfig,
    composer,
    gateway,
    eligibility,
    initialBridgePolicy: bridgePolicy,
    async replaceBridgePolicy(policy) {
      bridgePolicy = policy;
      onPolicyReplace?.(policy);
    },
    onAgentsRemoved(ids) {
      removed.push([...ids]);
    },
    onAgentsChanged(agents) {
      changed.push(agents.map((agent) => ({ ...agent })));
    },
  });
  return {
    root,
    stateDir,
    installer,
    registry,
    profiles,
    gateway,
    eligibility,
    coordinator,
    removed,
    changed,
    getBridgePolicy: () => bridgePolicy,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Pack 运行时生命周期", () => {
  it("一键停用/启用会热更新 Selector，保留 workspace、session 与稳定 agentId", async () => {
    const f = fixture();
    const hr = f.profiles[0]!.registry;
    const sessionFile = join(f.stateDir, "agents", hr.agentId, "sessions", "existing.jsonl");
    writeFileSync(sessionFile, "历史会话", "utf8");

    const disabled = await f.coordinator.disablePack(HR_PACK_ID);
    expect(disabled).toMatchObject({ enabled: false, fallbackAgentId: "main" });
    expect(agentIds(f.gateway.config)).toEqual(["main"]);
    expect(f.registry.findByProfile(hr.profileId)?.enabled).toBe(false);
    expect(readFileSync(sessionFile, "utf8")).toBe("历史会话");
    expect(f.removed).toEqual([[hr.agentId]]);
    expect(f.changed[0]).toEqual([{ id: "main", label: "龙枢助手" }]);

    const enabled = await f.coordinator.enablePack(HR_PACK_ID);
    expect(enabled.enabled).toBe(true);
    expect(agentIds(f.gateway.config)).toEqual(["main", hr.agentId]);
    expect(f.changed[1]).toEqual([
      { id: "main", label: "龙枢助手" },
      { id: hr.agentId, label: "HR 助理" },
    ]);
    expect(f.registry.findByProfile(hr.profileId)?.agentId).toBe(hr.agentId);
    expect(existsSync(sessionFile)).toBe(true);
  });

  it("config.patch 失败时恢复旧 Registry、Core policy 与 Gateway 配置", async () => {
    const f = fixture();
    const beforeRegistry = f.registry.list();
    const beforeConfig = structuredClone(f.gateway.config);
    const beforePolicy = f.getBridgePolicy();
    f.gateway.failNextReplace = true;

    await expect(f.coordinator.disablePack(HR_PACK_ID)).rejects.toMatchObject({ code: "PACK_DISABLE_FAILED" });
    expect(f.registry.list()).toEqual(beforeRegistry);
    expect(f.gateway.config).toEqual(beforeConfig);
    expect(f.getBridgePolicy()).toEqual(beforePolicy);
  });

  it("授权撤销后移除 Selector；已打开会话历史保留，但同一上下文不能再执行工具", async () => {
    let runtime: CoreRuntime | undefined;
    const f = fixture((policy) => runtime?.replaceBridgePolicy(policy));
    const hr = f.profiles[0]!.registry;
    const sessionFile = join(f.stateDir, "agents", hr.agentId, "sessions", "open-session.jsonl");
    writeFileSync(sessionFile, "仍可查看的聊天历史", "utf8");
    runtime = new CoreRuntime({
      bridgePolicy: f.getBridgePolicy(),
      verifyBridgeEntitlement: async () => ({ active: true, expiresAt: "2999-01-01T00:00:00.000Z" }),
      executor: { execute: async () => ({ ok: true }), abort() {} },
      onEvent() {},
    });
    const request = {
      skillId: "longhub.skill.resume-screen",
      input: { candidate: "A" },
      context: {
        agentId: hr.agentId,
        sessionKey: `agent:${hr.agentId}:main`,
        sessionId: "open-session",
        toolCallId: "tool-before-revoke",
      },
    };
    await expect(runtime.executeBridgeSkill(request)).resolves.toEqual({ ok: true });

    f.eligibility.eligible.clear();
    await expect(f.coordinator.syncEntitlements()).resolves.toEqual({
      status: "fresh",
      revokedPackIds: [HR_PACK_ID],
    });
    expect(agentIds(f.gateway.config)).toEqual(["main"]);
    expect(readFileSync(sessionFile, "utf8")).toBe("仍可查看的聊天历史");
    await expect(runtime.executeBridgeSkill({
      ...request,
      context: { ...request.context, toolCallId: "tool-after-revoke" },
    })).rejects.toMatchObject({ code: "BRIDGE_FORBIDDEN" });
  });

  it("云端暂时不可达时不误删 Selector，Core 在线复验仍独立 fail-closed", async () => {
    const f = fixture();
    f.eligibility.error = new Error("offline");
    await expect(f.coordinator.syncEntitlements()).resolves.toMatchObject({ status: "stale" });
    expect(agentIds(f.gateway.config)).toHaveLength(2);
    expect(f.registry.enabled()).toHaveLength(1);
  });
});
