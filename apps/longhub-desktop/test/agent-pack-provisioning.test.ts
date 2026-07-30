import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCloudApiServer } from "longhub-cloud-api";
import { PackPublisher } from "longhub-console";
import type { BridgeExecutionPolicy } from "@longhub/core";
import { buildHrPackSource, HR_PACK_ID } from "@longhub/hr-suite";
import { AgentLifecycleCoordinator } from "../src/agent-lifecycle-coordinator.js";
import { discoverInstallableAgentPacks } from "../src/agent-pack-catalog.js";
import { composeOpenClawAgentConfig } from "../src/agent-config-composer.js";
import { BUNDLED_OPENCLAW_VERSION } from "../src/agent-runtime-activation.js";
import { AgentRegistry } from "../src/agent-registry.js";
import { CoreClient } from "../src/core-client.js";
import { DesktopApp } from "../src/desktop-app.js";
import { OpenClawCliGatewayTransport, OpenClawGatewayConfigClient } from "../src/openclaw-gateway-client.js";
import { CloudPackClient } from "../src/pack-distribution.js";
import { CloudPackEligibilitySource } from "../src/pack-eligibility.js";
import { buildOpenClawConfig, initializeOpenClawWorkspace } from "../src/openclaw-runtime.js";
import { PackInstaller } from "../src/pack-installer.js";
import { activateCloudDevice } from "./helpers/activate-cloud-device.js";

const ADMIN_TOKEN = "provision-admin";
const root = mkdtempSync(join(tmpdir(), "longhub-agent-provision-"));
let api: ReturnType<typeof createCloudApiServer>;
let baseUrl: string;
let gatewayProcess: ChildProcess | undefined;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

beforeAll(async () => {
  api = createCloudApiServer({ executorUrl: "http://127.0.0.1:1", adminToken: ADMIN_TOKEN }).listen(0);
  await once(api, "listening");
  baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (gatewayProcess && gatewayProcess.exitCode === null) {
    gatewayProcess.kill();
    await Promise.race([once(gatewayProcess, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
  api.close();
  rmSync(root, { recursive: true, force: true });
});

describe("全新 userData：云端授权 → 一键安装 → Agent 激活", () => {
  it("发现 HR 入口，下载验签并直接写入 main + HR 运行时", async () => {
    expect((await new PackPublisher(baseUrl, ADMIN_TOKEN).publish(buildHrPackSource("1.0.0"))).ok).toBe(true);
    const cloud = new CloudPackClient(baseUrl);
    const credentials = await cloud.registerDevice({
      appVersion: "0.3.6",
      deviceFingerprint: "fresh-provision-device",
    });
    await activateCloudDevice(baseUrl, ADMIN_TOKEN, credentials.deviceToken);
    const grant = await fetch(`${baseUrl}/v1/admin/entitlements`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ device_id: credentials.deviceId, pack_id: HR_PACK_ID }),
    });
    expect(grant.status).toBe(201);

    const installRoot = join(root, "packs");
    const stateDir = join(root, "openclaw");
    const mainWorkspaceDir = join(stateDir, "workspace");
    initializeOpenClawWorkspace(mainWorkspaceDir);
    const installer = new PackInstaller(installRoot);
    const registryPath = join(root, "agent-registry.json");
    const registry = new AgentRegistry(registryPath);
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
    const baseConfig = buildOpenClawConfig(baseUrl, runtime, mainWorkspaceDir);
    const composer = {
      stateDir,
      mainWorkspaceDir,
      desktopVersion: "0.3.6",
      openclawVersion: BUNDLED_OPENCLAW_VERSION,
      modelPolicies: { "longhub.model.default": "longhub/longhub-default" },
    };
    const configPath = join(stateDir, "openclaw.json");
    writeFileSync(
      configPath,
      JSON.stringify(composeOpenClawAgentConfig(baseConfig, { ...composer, profiles: [] })),
      "utf8",
    );
    const port = await freePort();
    const token = "agent-provision-gateway-token";
    const entryScript = fileURLToPath(new URL("../node_modules/openclaw/openclaw.mjs", import.meta.url));
    const gatewayEnv = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_GATEWAY_TOKEN: token,
      LONGHUB_MODEL_TOKEN: "provision-model-token",
      OPENCLAW_DISABLE_BONJOUR: "1",
      OPENCLAW_EXEC_SHELL_SNAPSHOT: "0",
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
    };
    const gatewayErrors: string[] = [];
    gatewayProcess = spawn(
      process.execPath,
      [entryScript, "gateway", "--port", String(port), "--auth", "token"],
      { env: gatewayEnv, stdio: ["ignore", "pipe", "pipe"] },
    );
    gatewayProcess.stderr?.on("data", (chunk) => gatewayErrors.push(String(chunk)));
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (gatewayProcess.exitCode !== null) {
        throw new Error(`Gateway 提前退出 (${gatewayProcess.exitCode}): ${gatewayErrors.join("")}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/chat`);
        if (response.ok) break;
      } catch {
        // 等待首次 SQLite 状态迁移。
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const gateway = new OpenClawGatewayConfigClient(new OpenClawCliGatewayTransport({
      nodeExecutable: process.execPath,
      entryScript,
      wsUrl: `ws://127.0.0.1:${port}`,
      token,
      env: gatewayEnv,
      timeoutMs: 20_000,
    }));
    let bridgePolicy: BridgeExecutionPolicy = {};
    const lifecycle = new AgentLifecycleCoordinator({
      installer,
      registry,
      installContext: { trustedKeys: new Map(), desktopVersion: "0.3.6" },
      stateDir,
      baseConfig,
      composer,
      gateway,
      eligibility: new CloudPackEligibilitySource({
        baseUrl,
        deviceToken: credentials.deviceToken,
        desktopVersion: "0.3.6",
      }),
      initialBridgePolicy: bridgePolicy,
      async replaceBridgePolicy(policy) {
        bridgePolicy = policy;
      },
    });
    const persistedKeys = new Map<string, string>();
    const app = new DesktopApp(
      new CoreClient({ corePath: "unused.js" }),
      installer,
      { trustedKeys: new Map(), desktopVersion: "0.3.6" },
      lifecycle,
      { persistTrustedKey: (key) => persistedKeys.set(key.keyId, key.publicKeyPem) },
    );

    const installable = await discoverInstallableAgentPacks({
      client: cloud,
      deviceToken: credentials.deviceToken,
      installedPackIds: new Set(),
    });
    expect(installable).toEqual([expect.objectContaining({
      packId: HR_PACK_ID,
      version: "1.0.0",
      label: "HR 助理",
      state: "ready",
    })]);

    const result = await app.provisionAgentPackFromCloud({
      baseUrl,
      deviceToken: credentials.deviceToken,
      packId: HR_PACK_ID,
      version: installable[0]!.version,
    });
    expect(result).toMatchObject({ ok: true, packId: HR_PACK_ID, version: "1.0.0" });
    const agentId = installable[0]!.agentId;
    await expect(gateway.listAgents()).resolves.toMatchObject({
      defaultId: "main",
      agents: [{ id: "main" }, { id: agentId }],
    });
    expect(new AgentRegistry(registryPath).findByProfile("longhub.agent.hr")).toMatchObject({
      agentId,
      enabled: true,
    });
    expect(existsSync(join(stateDir, "workspaces", agentId, "IDENTITY.md"))).toBe(true);
    expect(persistedKeys.size).toBe(1);
    expect(Object.keys(bridgePolicy)).toEqual([agentId]);
    expect(await discoverInstallableAgentPacks({
      client: cloud,
      deviceToken: credentials.deviceToken,
      installedPackIds: new Set([HR_PACK_ID]),
    })).toEqual([]);
  }, 160_000);
});
