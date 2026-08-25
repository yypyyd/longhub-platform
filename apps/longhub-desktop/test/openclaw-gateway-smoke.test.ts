import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { buildHrPackSource } from "@longhub/hr-suite";
import { computePackDigest, signPackDigest } from "@longhub/pack-schema";
import { composeOpenClawAgentConfig } from "../src/agent-config-composer.js";
import {
  activateInstalledAgentProfiles,
  BUNDLED_OPENCLAW_VERSION,
} from "../src/agent-runtime-activation.js";
import { AgentRegistry } from "../src/agent-registry.js";
import { OpenClawCliGatewayTransport, OpenClawGatewayConfigClient } from "../src/openclaw-gateway-client.js";
import {
  buildOpenClawConfig,
  initializeOpenClawWorkspace,
  type ClientRuntimeConfig,
} from "../src/openclaw-runtime.js";
import { PackInstaller } from "../src/pack-installer.js";

let child: ChildProcess | undefined;
const stateDir = mkdtempSync(join(tmpdir(), "longhub-openclaw-smoke-"));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((err) => err ? reject(err) : resolve(port));
    });
  });
}

afterAll(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
  rmSync(stateDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("打包 OpenClaw Gateway 冒烟", () => {
  it("接受龙枢固定模型配置，并能直接提供 /chat Control UI", async () => {
    const runtime: ClientRuntimeConfig = {
      schema_version: "longhub/runtime-config/v1",
      config_version: "2026-07-30T00:00:00.000Z",
      issued_at: "2026-07-30T00:00:00.000Z",
      expires_at: "2026-07-30T00:10:00.000Z",
      provider_id: "longhub",
      base_path: "/v1/model",
      model_id: "longhub-default",
      display_name: "龙枢默认模型",
      api_type: "openai-completions",
      context_window: 128_000,
      max_tokens: 8_192,
      allow_user_model_selection: false,
      compatible_manager: { min_version: "0.0.0" },
      product: { assistant_name: "龙枢助手", assistant_avatar_path: "/assets/longhub-avatar.png", welcome_message: "你好，我是龙枢助手。", quick_tasks: [] },
      features: { agent_catalog: true, file_upload: true, tool_execution: true },
    };
    const configPath = join(stateDir, "openclaw.json");
    const workspaceDir = join(stateDir, "workspace");
    initializeOpenClawWorkspace(workspaceDir);
    const source = buildHrPackSource("1.0.0");
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const keyId = "longhub-gateway-smoke";
    source.manifest.integrity.signatureKeyId = keyId;
    source.manifest.integrity.digest = computePackDigest(source.manifest, source.files);
    const installer = new PackInstaller(join(stateDir, "test-packs"));
    expect(installer.install({
      manifest: source.manifest,
      files: source.files,
      signature: signPackDigest(
        source.manifest.integrity.digest,
        privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      ),
    }, {
      trustedKeys: new Map([[
        keyId,
        publicKey.export({ type: "spki", format: "pem" }).toString(),
      ]]),
      desktopVersion: "0.3.6",
    }).ok).toBe(true);
    const profiles = activateInstalledAgentProfiles({
      installer,
      registry: new AgentRegistry(join(stateDir, "agent-registry.json")),
      stateDir,
    });
    const config = composeOpenClawAgentConfig(
      buildOpenClawConfig("https://cloud.example", runtime, workspaceDir),
      {
        stateDir,
        mainWorkspaceDir: workspaceDir,
        desktopVersion: "0.3.6",
        openclawVersion: BUNDLED_OPENCLAW_VERSION,
        modelPolicies: { "longhub.model.default": "longhub/longhub-default" },
        profiles,
      },
    ) as { agents: { list: unknown[] } };
    expect(config.agents.list).toHaveLength(2);
    writeFileSync(configPath, JSON.stringify(config), "utf8");
    const port = await freePort();
    const entry = fileURLToPath(new URL("../node_modules/openclaw/openclaw.mjs", import.meta.url));
    const errors: string[] = [];
    const gatewayEnv = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_GATEWAY_TOKEN: "gateway-smoke-token",
      LONGHUB_MODEL_TOKEN: "device-smoke-token",
      OPENCLAW_DISABLE_BONJOUR: "1",
      OPENCLAW_EXEC_SHELL_SNAPSHOT: "0",
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
    };
    child = spawn(process.execPath, [entry, "gateway", "--port", String(port), "--auth", "token"], {
      env: gatewayEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr?.on("data", (chunk) => errors.push(String(chunk)));

    // 与产品首次 SQLite 迁移窗口一致；繁忙 Windows 主机上首次迁移可能超过 30 秒。
    const deadline = Date.now() + 120_000;
    let response: Response | undefined;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Gateway 提前退出 (${child.exitCode}): ${errors.join("")}`);
      try {
        response = await fetch(`http://127.0.0.1:${port}/chat`);
        if (response.ok) break;
      } catch {
        // Gateway 正在完成首次状态迁移。
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(response?.status, errors.join("")).toBe(200);
    expect(await response!.text()).toContain("openclaw");

    const client = new OpenClawGatewayConfigClient(new OpenClawCliGatewayTransport({
      nodeExecutable: process.execPath,
      entryScript: entry,
      wsUrl: `ws://127.0.0.1:${port}`,
      token: "gateway-smoke-token",
      env: gatewayEnv,
      timeoutMs: 20_000,
    }));
    const snapshot = await client.getConfig();
    const originalAgents = (snapshot.config.agents as { list: unknown[] }).list;
    expect(originalAgents).toHaveLength(2);
    await client.replaceAgents([originalAgents[0]], snapshot.hash);
    await expect(client.listAgents()).resolves.toMatchObject({
      defaultId: "main",
      agents: [{ id: "main" }],
    });
    const disabledSnapshot = await client.getConfig();
    await client.replaceAgents(originalAgents, disabledSnapshot.hash);
    expect((await client.listAgents()).agents).toHaveLength(2);
  }, 140_000);
});
