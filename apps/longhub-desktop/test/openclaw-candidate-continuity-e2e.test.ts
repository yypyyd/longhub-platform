import { generateKeyPairSync } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { resolveGatewayPort } from "../src/gateway-supervisor.js";
import {
  OpenClawCliGatewayTransport,
  OpenClawGatewayConfigClient,
} from "../src/openclaw-gateway-client.js";
import {
  buildOpenClawConfig,
  initializeOpenClawWorkspace,
  type ClientRuntimeConfig,
} from "../src/openclaw-runtime.js";
import { PackInstaller } from "../src/pack-installer.js";

const temporaryDirectories: string[] = [];
const children = new Set<ChildProcess>();
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const KEY_ID = "longhub-candidate-continuity";
const OPENCLAW_ENTRY = fileURLToPath(new URL("../node_modules/openclaw/openclaw.mjs", import.meta.url));

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

function signedHrPack(version: string, identity: string): PackFile {
  const source = buildHrPackSource(version);
  source.files["workspace/IDENTITY.md"] = identity;
  source.manifest.integrity.signatureKeyId = KEY_ID;
  source.manifest.integrity.digest = computePackDigest(source.manifest, source.files);
  return {
    manifest: source.manifest,
    files: source.files,
    signature: signPackDigest(source.manifest.integrity.digest, privatePem),
  };
}

function composeConfig(
  stateDir: string,
  profiles: ReturnType<typeof activateInstalledAgentProfiles>,
): Record<string, unknown> {
  const mainWorkspaceDir = join(stateDir, "workspace");
  initializeOpenClawWorkspace(mainWorkspaceDir);
  return composeOpenClawAgentConfig(
    buildOpenClawConfig("https://cloud.example", runtime, mainWorkspaceDir),
    {
      stateDir,
      mainWorkspaceDir,
      desktopVersion: "0.3.6",
      openclawVersion: BUNDLED_OPENCLAW_VERSION,
      modelPolicies: { "longhub.model.default": "longhub/longhub-default" },
      profiles,
    },
  );
}

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

interface RunningGateway {
  child: ChildProcess;
  port: number;
  token: string;
  env: NodeJS.ProcessEnv;
  errors: string[];
}

async function startGateway(stateDir: string, configPath: string, port: number, token: string): Promise<RunningGateway> {
  const errors: string[] = [];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_GATEWAY_TOKEN: token,
    LONGHUB_MODEL_TOKEN: "candidate-device-token",
    OPENCLAW_DISABLE_BONJOUR: "1",
    OPENCLAW_EXEC_SHELL_SNAPSHOT: "0",
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_SKIP_CHANNELS: "1",
  };
  const child = spawn(
    process.execPath,
    [OPENCLAW_ENTRY, "gateway", "--port", String(port), "--auth", "token"],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  children.add(child);
  child.stderr?.on("data", (chunk) => errors.push(String(chunk)));
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Gateway 提前退出 (${child.exitCode}): ${errors.join("")}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/chat`);
      if (response.ok) return { child, port, token, env, errors };
    } catch {
      // 首次启动可能仍在执行 SQLite 状态迁移。
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Gateway 启动超时: ${errors.join("")}`);
}

async function stopGateway(gateway: RunningGateway): Promise<void> {
  if (gateway.child.exitCode === null) {
    gateway.child.kill();
    await Promise.race([
      once(gateway.child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  children.delete(gateway.child);
}

function gatewayClient(gateway: RunningGateway): OpenClawGatewayConfigClient {
  return new OpenClawGatewayConfigClient(new OpenClawCliGatewayTransport({
    nodeExecutable: process.execPath,
    entryScript: OPENCLAW_ENTRY,
    wsUrl: `ws://127.0.0.1:${gateway.port}`,
    token: gateway.token,
    env: gateway.env,
    timeoutMs: 20_000,
  }));
}

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
  await Promise.all([...children].map((child) =>
    child.exitCode === null
      ? Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))])
      : Promise.resolve(),
  ));
  children.clear();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

describe("LongHub Desktop 0.3.6 候选版状态连续性", () => {
  it("保留 0.3.5 状态，并在 Pack 升级、重启和回滚后保持稳定映射与历史", () => {
    const root = mkdtempSync(join(tmpdir(), "longhub-candidate-state-"));
    temporaryDirectories.push(root);
    const userOpenClawDir = join(root, "user-home", ".openclaw");
    const userSentinel = join(userOpenClawDir, "workspace", "IDENTITY.md");
    mkdirSync(join(userOpenClawDir, "workspace"), { recursive: true });
    writeFileSync(userSentinel, "用户原有 OpenClaw 身份", "utf8");

    const userData = join(root, "longhub-user-data");
    const stateDir = join(userData, "openclaw");
    const installRoot = join(userData, "packs");
    const registryPath = join(userData, "agent-registry.json");
    const mainSession = join(stateDir, "agents", "main", "sessions", "legacy-0.3.5.jsonl");
    mkdirSync(join(stateDir, "agents", "main", "sessions"), { recursive: true });
    writeFileSync(mainSession, "0.3.5 主助手历史", "utf8");
    initializeOpenClawWorkspace(join(stateDir, "workspace"));

    const installContext = {
      trustedKeys: new Map([[KEY_ID, publicPem]]),
      desktopVersion: "0.3.6",
    };
    let installer = new PackInstaller(installRoot);
    expect(installer.install(signedHrPack("1.0.0", "# HR v1 身份"), installContext).ok).toBe(true);
    let registry = new AgentRegistry(registryPath);
    let profiles = activateInstalledAgentProfiles({ installer, registry, stateDir });
    const agentId = profiles[0]!.registry.agentId;
    const hrWorkspace = join(stateDir, "workspaces", agentId);
    const hrSession = join(stateDir, "agents", agentId, "sessions", "hr-history.jsonl");
    writeFileSync(join(hrWorkspace, "USER.md"), "HR 用户长期偏好", "utf8");
    writeFileSync(hrSession, "HR 历史会话", "utf8");

    // 模拟 Desktop/Gateway 完整退出后使用同一 userData 再启动。
    installer = new PackInstaller(installRoot);
    registry = new AgentRegistry(registryPath);
    profiles = activateInstalledAgentProfiles({ installer, registry, stateDir });
    expect(profiles[0]!.registry.agentId).toBe(agentId);
    expect(readFileSync(mainSession, "utf8")).toBe("0.3.5 主助手历史");
    expect(readFileSync(hrSession, "utf8")).toBe("HR 历史会话");
    expect(readFileSync(join(hrWorkspace, "USER.md"), "utf8")).toBe("HR 用户长期偏好");

    expect(installer.install(signedHrPack("2.0.0", "# HR v2 身份"), installContext)).toMatchObject({
      ok: true,
      version: "2.0.0",
      previousVersion: "1.0.0",
    });
    profiles = activateInstalledAgentProfiles({ installer, registry, stateDir });
    expect(profiles[0]!.registry).toMatchObject({ agentId, packVersion: "2.0.0" });
    expect(readFileSync(join(hrWorkspace, "IDENTITY.md"), "utf8")).toBe("# HR v2 身份");
    expect(readFileSync(join(hrWorkspace, "USER.md"), "utf8")).toBe("HR 用户长期偏好");
    expect(readFileSync(hrSession, "utf8")).toBe("HR 历史会话");

    expect(installer.rollback("longhub.hr-suite")).toMatchObject({ ok: true, version: "1.0.0" });
    installer = new PackInstaller(installRoot);
    registry = new AgentRegistry(registryPath);
    profiles = activateInstalledAgentProfiles({ installer, registry, stateDir });
    expect(profiles[0]!.registry).toMatchObject({ agentId, packVersion: "1.0.0" });
    expect(readFileSync(join(hrWorkspace, "IDENTITY.md"), "utf8")).toBe("# HR v1 身份");
    expect(readFileSync(join(hrWorkspace, "USER.md"), "utf8")).toBe("HR 用户长期偏好");
    expect(readFileSync(hrSession, "utf8")).toBe("HR 历史会话");
    expect(readFileSync(userSentinel, "utf8")).toBe("用户原有 OpenClaw 身份");
    expect(JSON.stringify(composeConfig(stateDir, profiles))).not.toContain(userOpenClawDir);
  });

  it("与已运行的用户 OpenClaw 共存，并在真实 Gateway 重启后保留双 Agent", async () => {
    const root = mkdtempSync(join(tmpdir(), "longhub-candidate-gateway-"));
    temporaryDirectories.push(root);
    const userStateDir = join(root, "user-openclaw");
    const userConfigPath = join(userStateDir, "openclaw.json");
    mkdirSync(userStateDir, { recursive: true });
    writeFileSync(userConfigPath, JSON.stringify(composeConfig(userStateDir, [])), "utf8");
    const preferredPort = await freePort();
    const userGateway = await startGateway(userStateDir, userConfigPath, preferredPort, "user-token");

    const userData = join(root, "longhub-user-data");
    const stateDir = join(userData, "openclaw");
    const installer = new PackInstaller(join(userData, "packs"));
    expect(installer.install(signedHrPack("1.0.0", "# HR 候选版身份"), {
      trustedKeys: new Map([[KEY_ID, publicPem]]),
      desktopVersion: "0.3.6",
    }).ok).toBe(true);
    const profiles = activateInstalledAgentProfiles({
      installer,
      registry: new AgentRegistry(join(userData, "agent-registry.json")),
      stateDir,
    });
    const agentId = profiles[0]!.registry.agentId;
    const sessionFile = join(stateDir, "agents", agentId, "sessions", "persistent.jsonl");
    writeFileSync(sessionFile, "重启后必须保留", "utf8");
    const configPath = join(stateDir, "openclaw.json");
    writeFileSync(configPath, JSON.stringify(composeConfig(stateDir, profiles)), "utf8");

    const longHubPort = await resolveGatewayPort(preferredPort);
    expect(longHubPort).not.toBe(preferredPort);
    let longHubGateway = await startGateway(stateDir, configPath, longHubPort, "longhub-token");
    await expect(gatewayClient(userGateway).listAgents()).resolves.toMatchObject({
      defaultId: "main",
      agents: [{ id: "main" }],
    });
    await expect(gatewayClient(longHubGateway).listAgents()).resolves.toMatchObject({
      defaultId: "main",
      agents: [{ id: "main" }, { id: agentId }],
    });

    await stopGateway(longHubGateway);
    expect((await fetch(`http://127.0.0.1:${preferredPort}/chat`)).status).toBe(200);
    longHubGateway = await startGateway(stateDir, configPath, longHubPort, "longhub-token");
    await expect(gatewayClient(longHubGateway).listAgents()).resolves.toMatchObject({
      defaultId: "main",
      agents: [{ id: "main" }, { id: agentId }],
    });
    expect(readFileSync(sessionFile, "utf8")).toBe("重启后必须保留");
    expect(existsSync(join(userStateDir, "workspace", "IDENTITY.md"))).toBe(true);

    await stopGateway(longHubGateway);
    await stopGateway(userGateway);
  }, 180_000);
});
