import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { buildHrPackSource } from "@longhub/hr-suite";
import {
  OPENCLAW_COMPAT_CONTRACT,
  openClawCompatibilityDigest,
} from "@longhub/openclaw-compat";
import { computePackDigest, signPackDigest } from "@longhub/pack-schema";
import { composeOpenClawAgentConfig } from "../src/agent-config-composer.js";
import { activateInstalledAgentProfiles, BUNDLED_OPENCLAW_VERSION } from "../src/agent-runtime-activation.js";
import { AgentRegistry } from "../src/agent-registry.js";
import { OpenClawCliGatewayTransport } from "../src/openclaw-gateway-client.js";
import { openClawSelectorPolicyScript } from "../src/openclaw-selector-policy.js";
import { openClawAgentSessionUrl, openClawControlUiUrl } from "../src/openclaw-webui.js";
import { OPENCLAW_PRODUCT_CSS } from "../src/openclaw-product-policy.js";
import { openClawProductUiScript } from "../src/openclaw-product-ui.js";
import { buildOpenClawConfig, initializeOpenClawWorkspace } from "../src/openclaw-runtime.js";
import { PackInstaller } from "../src/pack-installer.js";

const root = mkdtempSync(join(tmpdir(), "longhub-selector-e2e-"));
const VALID_PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl+X8sAAAAASUVORK5CYII=";
let gateway: ChildProcess | undefined;

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

afterAll(async () => {
  if (gateway && gateway.exitCode === null) {
    gateway.kill();
    await Promise.race([once(gateway, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("锁定版 OpenClaw 原生 Agent Selector E2E", () => {
  it("点击恢复最近会话，执行中先停止再切换，撤销后真实 UI 回退 main", async () => {
    const stateDir = join(root, "openclaw");
    const workspaceDir = join(stateDir, "workspace");
    const configPath = join(stateDir, "openclaw.json");
    initializeOpenClawWorkspace(workspaceDir);
    const source = buildHrPackSource("1.0.0");
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    source.manifest.integrity.signatureKeyId = "selector-e2e";
    source.manifest.integrity.digest = computePackDigest(source.manifest, source.files);
    const installer = new PackInstaller(join(root, "packs"));
    expect(installer.install({
      manifest: source.manifest,
      files: source.files,
      signature: signPackDigest(
        source.manifest.integrity.digest,
        privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      ),
    }, {
      trustedKeys: new Map([[
        "selector-e2e",
        publicKey.export({ type: "spki", format: "pem" }).toString(),
      ]]),
      desktopVersion: "0.3.6",
    }).ok).toBe(true);
    const profiles = activateInstalledAgentProfiles({
      installer,
      registry: new AgentRegistry(join(root, "agent-registry.json")),
      stateDir,
    });
    const hrAgentId = profiles[0]!.registry.agentId;
    const runtime = {
      provider_id: "longhub",
      base_path: "/v1/model",
      model_id: "longhub-default",
      display_name: "龙枢默认模型",
      api_type: "openai-completions" as const,
      context_window: 128_000,
      max_tokens: 8_192,
      allow_user_model_selection: false as const,
    };
    const config = composeOpenClawAgentConfig(
      buildOpenClawConfig("https://cloud.example", runtime, workspaceDir),
      {
        stateDir,
        mainWorkspaceDir: workspaceDir,
        mainAvatarDataUrl: VALID_PNG_DATA_URL,
        desktopVersion: "0.3.6",
        openclawVersion: BUNDLED_OPENCLAW_VERSION,
        modelPolicies: { "longhub.model.default": "longhub/longhub-default" },
        profiles,
      },
    );
    writeFileSync(configPath, JSON.stringify(config), "utf8");

    const port = await freePort();
    const token = "selector-e2e-token";
    const entry = fileURLToPath(new URL("../node_modules/openclaw/openclaw.mjs", import.meta.url));
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_GATEWAY_TOKEN: token,
      LONGHUB_MODEL_TOKEN: "selector-model-token",
      OPENCLAW_DISABLE_BONJOUR: "1",
      OPENCLAW_EXEC_SHELL_SNAPSHOT: "0",
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
    };
    const errors: string[] = [];
    gateway = spawn(process.execPath, [entry, "gateway", "--port", String(port), "--auth", "token"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    gateway.stderr?.on("data", (chunk) => errors.push(String(chunk)));
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (gateway.exitCode !== null) throw new Error(`Gateway 提前退出: ${errors.join("")}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/chat`);
        if (response.ok) break;
      } catch {
        // 等待首次状态迁移。
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const transport = new OpenClawCliGatewayTransport({
      nodeExecutable: process.execPath,
      entryScript: entry,
      wsUrl: `ws://127.0.0.1:${port}`,
      token,
      env,
      timeoutMs: 20_000,
    });
    const older = await transport.call("sessions.create", { agentId: hrAgentId }) as { key: string };
    await transport.call("sessions.patch", { key: older.key, agentId: hrAgentId, label: "HR 较早会话" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const latest = await transport.call("sessions.create", { agentId: hrAgentId }) as { key: string };
    await transport.call("sessions.patch", { key: latest.key, agentId: hrAgentId, label: "HR 最近会话" });
    const listedAgents = await transport.call("agents.list", {}) as { agents: Array<{ id: string }> };
    expect(listedAgents.agents.map((agent) => agent.id)).toEqual(["main", hrAgentId]);
    const listedSessions = await transport.call("sessions.list", {}) as { sessions: Array<{ key: string }> };
    expect(listedSessions.sessions.map((session) => session.key)).toEqual(expect.arrayContaining([older.key, latest.key]));

    await transport.call("sessions.patch", {
      key: latest.key,
      agentId: hrAgentId,
      label: "HR 可搜索会话",
      category: "longhub-spike",
      pinned: true,
    });
    const searchedSessions = await transport.call("sessions.list", {
      agentId: hrAgentId,
      search: "可搜索",
      limit: 10,
      offset: 0,
    }) as { sessions: Array<{ key: string; label?: string }> };
    expect(searchedSessions.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: latest.key, label: "HR 可搜索会话" }),
    ]));
    const described = await transport.call("sessions.describe", {
      key: latest.key,
      includeDerivedTitles: true,
      includeLastMessage: true,
    });
    expect(JSON.stringify(described)).toContain(latest.key);
    const history = await transport.call("chat.history", {
      sessionKey: latest.key,
      agentId: hrAgentId,
      limit: 20,
      offset: 0,
      maxChars: 20_000,
    }) as { messages: unknown[] };
    expect(history.messages).toEqual([]);
    await expect(transport.call("sessions.list", {
      agentId: hrAgentId,
      unexpected: true,
    })).rejects.toThrow(/invalid sessions\.list params/i);

    await transport.call("sessions.patch", { key: older.key, agentId: hrAgentId, archived: true });
    const archivedSessions = await transport.call("sessions.list", {
      agentId: hrAgentId,
      archived: true,
    }) as { sessions: Array<{ key: string }> };
    expect(archivedSessions.sessions.map((session) => session.key)).toContain(older.key);
    await transport.call("sessions.delete", {
      key: older.key,
      agentId: hrAgentId,
      archivedOnly: true,
      deleteTranscript: true,
    });
    const afterDelete = await transport.call("sessions.list", {
      agentId: hrAgentId,
      archived: true,
    }) as { sessions: Array<{ key: string }> };
    expect(afterDelete.sessions.map((session) => session.key)).not.toContain(older.key);

    const resultPath = join(root, "selector-result.json");
    const inputPath = join(root, "selector-input.json");
    const controlUiUrl = openClawControlUiUrl(`ws://127.0.0.1:${port}`, { token });
    writeFileSync(inputPath, JSON.stringify({
      controlUiUrl,
      hrAgentId,
      latestHrSessionKey: latest.key,
      mainFallbackUrl: openClawAgentSessionUrl(controlUiUrl, "main"),
      viewport: OPENCLAW_COMPAT_CONTRACT.visual.viewport,
      stableCaptureRect: OPENCLAW_COMPAT_CONTRACT.visual.stableCaptureRect,
      contractDigest: openClawCompatibilityDigest(),
      productCss: OPENCLAW_PRODUCT_CSS,
      modelControlSelectors: OPENCLAW_COMPAT_CONTRACT.selectors.modelControls,
      restrictedNavigationSelectors: OPENCLAW_COMPAT_CONTRACT.selectors.restrictedNavigationLinks,
      ordinaryUserHiddenSelectors: OPENCLAW_COMPAT_CONTRACT.selectors.ordinaryUserHidden,
      ordinaryUserRestrictedControls: OPENCLAW_COMPAT_CONTRACT.selectors.ordinaryUserRestrictedControls,
      ordinaryUserPathSuffixes: OPENCLAW_COMPAT_CONTRACT.routes.ordinaryUserPathSuffixes,
      agentsPage: OPENCLAW_COMPAT_CONTRACT.selectors.agentsPage,
      agentsPanelProperty: OPENCLAW_COMPAT_CONTRACT.selectors.agentsPanelProperty,
      selectAgentMethod: OPENCLAW_COMPAT_CONTRACT.selectors.selectAgentMethod,
      productUiScript: openClawProductUiScript({
        assistant_name: "龙枢助手",
        welcome_message: "你好，我是龙枢助手。",
        assistant_avatar_data_url: VALID_PNG_DATA_URL,
      }),
      policyScript: openClawSelectorPolicyScript({
        allowedAgentIds: ["main", hrAgentId],
        agentLabels: { main: "龙枢助手", [hrAgentId]: "HR 助理" },
      }),
      removalPolicyScript: openClawSelectorPolicyScript({
        allowedAgentIds: ["main"],
        agentLabels: { main: "龙枢助手" },
      }),
      resultPath,
    }), "utf8");
    const electronPath = createRequire(import.meta.url)("electron") as string;
    const runner = fileURLToPath(new URL("./fixtures/openclaw-selector-runner.cjs", import.meta.url));
    const electron = spawn(electronPath, [runner, inputPath], {
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const output: string[] = [];
    electron.stdout?.on("data", (chunk) => output.push(String(chunk)));
    electron.stderr?.on("data", (chunk) => output.push(String(chunk)));
    const [exitCode] = await once(electron, "exit") as [number | null];
    expect(existsSync(resultPath), output.join("")).toBe(true);
    const result = JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, any>;
    expect(exitCode, result.error ?? output.join("")).toBe(0);
    expect(result.initial, JSON.stringify(result)).toBeTruthy();
    expect(result.initial.options.map((option: { value: string }) => option.value)).toEqual(["main", hrAgentId]);
    expect(result.initial.policy).toBe("v1");
    expect(result.uiContract).toEqual({
      contractDigest: openClawCompatibilityDigest(),
      agentSelectorVisible: true,
      agentLabels: ["龙枢助手", "HR 助理"],
      brandHostCount: 1,
      brandText: "龙枢",
      htmlLang: "zh-CN",
      documentTitle: "龙枢",
      productPolicy: "v1",
      brandedLogo: true,
      recentSessionTitleVisible: false,
      internalSessionKeyVisible: false,
      visibleInfrastructureTerms: [],
      defaultSessionTitleVisible: true,
      visibleEnglishTerms: [],
      visibleAdminWelcomeSuggestions: 0,
      selectAgentHost: true,
      visibleModelControls: 0,
      visibleRestrictedNavigation: 0,
      visibleOrdinaryUserHidden: 0,
      officialSidebarVisible: true,
      officialNativeRoutes: ["activity", "agents", "sessions", "usage", "tasks", "skills"],
      productEntries: [],
      visibleRestrictedControls: 0,
      brokenVisibleImages: 0,
      hasNode: false,
    });
    expect(result.nativePages).toEqual({
      agentsPanel: "overview",
      agentsRestrictedControls: 0,
      skillsPageVisible: true,
      skillsRestrictedControls: 0,
    });
    expect(result.visualBaseline).toMatchObject({
      viewport: { width: 1200, height: 800 },
      capture: { width: 420, height: 220 },
    });
    const visualSignature = result.visualBaseline.signature as {
      meanRgb: [number, number, number];
      darkRatio: number;
      lightRatio: number;
      edgeDensity: number;
    };
    const baseline = { meanRgb: [245, 242, 239], darkRatio: 0.0011, lightRatio: 0.9619, edgeDensity: 0.0223 };
    visualSignature.meanRgb.forEach((value, index) => {
      expect(Math.abs(value - baseline.meanRgb[index]!)).toBeLessThanOrEqual(4);
    });
    expect(Math.abs(visualSignature.darkRatio - baseline.darkRatio)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(visualSignature.lightRatio - baseline.lightRatio)).toBeLessThanOrEqual(0.06);
    expect(Math.abs(visualSignature.edgeDensity - baseline.edgeDensity)).toBeLessThanOrEqual(0.03);
    expect(result.restoredHr.session).toBe(latest.key);
    expect(result.blockedImmediately).toEqual({ selected: "main", stopClicked: true });
    expect(result.switchedAfterStop.session).toBe(latest.key);
    expect(result.afterRemoval).toMatchObject({ value: "main", session: "agent:main:main" });
    expect(result.afterRemoval.options.map((option: { value: string }) => option.value)).toEqual(["main"]);
  }, 240_000);
});
