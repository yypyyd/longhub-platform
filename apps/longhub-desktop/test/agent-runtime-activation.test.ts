import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildHrPackSource } from "@longhub/hr-suite";
import { computePackDigest, signPackDigest, type PackFile } from "@longhub/pack-schema";
import { composeOpenClawAgentConfig } from "../src/agent-config-composer.js";
import {
  activateInstalledAgentProfiles,
  BUNDLED_OPENCLAW_VERSION,
} from "../src/agent-runtime-activation.js";
import { AgentRegistry } from "../src/agent-registry.js";
import { buildOpenClawConfig, initializeOpenClawWorkspace } from "../src/openclaw-runtime.js";
import { PackInstaller } from "../src/pack-installer.js";

const temporaryDirectories: string[] = [];
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const KEY_ID = "longhub-runtime-activation-test";

function signedHrPack(): PackFile {
  const source = buildHrPackSource("1.0.0");
  source.manifest.integrity.signatureKeyId = KEY_ID;
  source.manifest.integrity.digest = computePackDigest(source.manifest, source.files);
  return {
    manifest: source.manifest,
    files: source.files,
    signature: signPackDigest(source.manifest.integrity.digest, privatePem),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("active Pack → main + HR Gateway 启动配置", () => {
  it("注册 HR、落盘隔离 workspace/agentDir/session，并通过真实 OpenClaw 读取", () => {
    const root = mkdtempSync(join(tmpdir(), "longhub-agent-activation-"));
    temporaryDirectories.push(root);
    const installRoot = join(root, "packs");
    const stateDir = join(root, "openclaw");
    const mainWorkspaceDir = join(stateDir, "workspace");
    const registryPath = join(root, "agent-registry.json");
    const installer = new PackInstaller(installRoot);
    const installed = installer.install(signedHrPack(), {
      trustedKeys: new Map([[KEY_ID, publicPem]]),
      desktopVersion: "0.3.6",
    });
    expect(installed.ok).toBe(true);

    const registry = new AgentRegistry(registryPath);
    const profiles = activateInstalledAgentProfiles({ installer, registry, stateDir });
    expect(profiles).toHaveLength(1);
    const hr = profiles[0]!;
    const hrWorkspace = join(stateDir, "workspaces", hr.registry.agentId);
    expect(readFileSync(join(hrWorkspace, "IDENTITY.md"), "utf8")).toContain("HR 助理");
    expect(existsSync(join(stateDir, "agents", hr.registry.agentId, "agent"))).toBe(true);
    expect(existsSync(join(stateDir, "agents", hr.registry.agentId, "sessions"))).toBe(true);

    // USER.md 属于智能体自己的长期偏好；重复启动不应被 Pack 默认模板覆盖，Registry 也不空转写 revision。
    writeFileSync(join(hrWorkspace, "USER.md"), "HR 用户自己的偏好", "utf8");
    const registryBefore = readFileSync(registryPath, "utf8");
    expect(activateInstalledAgentProfiles({ installer, registry, stateDir })).toHaveLength(1);
    expect(readFileSync(join(hrWorkspace, "USER.md"), "utf8")).toBe("HR 用户自己的偏好");
    expect(readFileSync(registryPath, "utf8")).toBe(registryBefore);

    initializeOpenClawWorkspace(mainWorkspaceDir);
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
    const config = composeOpenClawAgentConfig(
      buildOpenClawConfig("https://cloud.example", runtime, mainWorkspaceDir),
      {
        stateDir,
        mainWorkspaceDir,
        desktopVersion: "0.3.6",
        openclawVersion: BUNDLED_OPENCLAW_VERSION,
        modelPolicies: { "longhub.model.default": "longhub/longhub-default" },
        profiles,
      },
    ) as { agents: { list: Array<{ id: string; workspace: string; agentDir: string }> } };
    expect(config.agents.list.map((agent) => agent.id)).toEqual(["main", hr.registry.agentId]);
    expect(new Set(config.agents.list.map((agent) => agent.workspace)).size).toBe(2);
    expect(new Set(config.agents.list.map((agent) => agent.agentDir)).size).toBe(2);

    const configPath = join(stateDir, "openclaw.json");
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
    const openclawEntry = fileURLToPath(new URL("../node_modules/openclaw/openclaw.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [openclawEntry, "config", "validate"], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: stateDir,
        LONGHUB_MODEL_TOKEN: "test-device-token",
        OPENCLAW_NO_RESPAWN: "1",
      },
      // Full-workspace runs start several real OpenClaw processes concurrently.
      // Keep the integration assertion, but allow for Windows process contention.
      timeout: 60_000,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  }, 70_000);
});
