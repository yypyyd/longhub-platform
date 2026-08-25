import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildHrAgentProfile, buildHrPackSource } from "@longhub/hr-suite";
import { composeOpenClawAgentConfig } from "../src/agent-config-composer.js";
import { AgentRegistry } from "../src/agent-registry.js";
import { buildOpenClawConfig } from "../src/openclaw-runtime.js";

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
const temporaryDirectories: string[] = [];

function composerFixture() {
  const root = mkdtempSync(join(tmpdir(), "longhub-agent-composer-"));
  temporaryDirectories.push(root);
  const stateDir = join(root, "openclaw");
  const mainWorkspaceDir = join(stateDir, "workspace");
  const source = buildHrPackSource("1.0.0");
  const profile = buildHrAgentProfile();
  const registry = new AgentRegistry(join(root, "agent-registry.json"));
  const entry = registry.register({ manifest: source.manifest, files: source.files });
  const base = buildOpenClawConfig("https://cloud.example", runtime, mainWorkspaceDir);
  return {
    base,
    options: {
      stateDir,
      mainWorkspaceDir,
      mainAvatarDataUrl: "data:image/png;base64,bG9uZ2h1Yg==",
      desktopVersion: "1.0.0",
      openclawVersion: "2026.7.1-2",
      modelPolicies: { "longhub.model.default": "longhub/longhub-default" },
      profiles: [{ registry: entry, manifest: source.manifest, profile }],
    },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Profile → OpenClaw agents.list Config Composer", () => {
  it("生成 main + HR 的独立 workspace、agentDir、模型和身份", () => {
    const { base, options } = composerFixture();
    const config = composeOpenClawAgentConfig(base, options) as any;

    expect(config.agents.list).toHaveLength(2);
    expect(config.agents.list[0]).toMatchObject({
      id: "main",
      default: true,
      name: "龙枢助手",
      workspace: options.mainWorkspaceDir,
      model: { primary: "longhub/longhub-default" },
      identity: { avatar: options.mainAvatarDataUrl },
    });
    const hr = config.agents.list[1];
    expect(hr.id).toBe(options.profiles[0]!.registry.agentId);
    expect(hr.workspace).toBe(join(options.stateDir, "workspaces", hr.id));
    expect(hr.agentDir).toBe(join(options.stateDir, "agents", hr.id, "agent"));
    expect(hr.identity).toMatchObject({ name: "HR 助理", emoji: "🦞" });
    expect(hr.skills).toContain("longhub.skill.resume-screen");
  });

  it("强制隔离会话工具、跨 Agent 调用、记忆和 elevated 权限", () => {
    const { base, options } = composerFixture();
    const config = composeOpenClawAgentConfig(base, options) as any;
    const hr = config.agents.list[1];

    expect(config.tools.agentToAgent).toEqual({ enabled: false, allow: [] });
    expect(hr.memorySearch).toEqual({ enabled: true, sources: ["memory"] });
    expect(hr.subagents).toEqual({ allowAgents: [], requireAgentId: true });
    expect(hr.tools.deny).toEqual(
      expect.arrayContaining(["sessions_history", "sessions_send", "sessions_spawn"]),
    );
    expect(hr.tools.elevated.enabled).toBe(false);
    expect(hr.sandbox).toEqual({ mode: "all", scope: "agent", workspaceAccess: "rw" });
  });

  it("拒绝非 PNG、超大或畸形的主头像 data URI", () => {
    const { base, options } = composerFixture();
    expect(() => composeOpenClawAgentConfig(base, {
      ...options,
      mainAvatarDataUrl: "https://evil.example/avatar.png",
    })).toThrow("有界 PNG data URI");
    expect(() => composeOpenClawAgentConfig(base, {
      ...options,
      mainAvatarDataUrl: "data:image/png;base64,not base64",
    })).toThrow("有界 PNG data URI");
  });

  it("相同输入生成确定配置且不修改基础配置", () => {
    const { base, options } = composerFixture();
    const before = JSON.stringify(base);
    const first = composeOpenClawAgentConfig(base, options);
    const second = composeOpenClawAgentConfig(base, options);
    expect(first).toEqual(second);
    expect(JSON.stringify(base)).toBe(before);
  });

  it("只为 HR 开放 Bridge 工具，并确定性注入受信插件路径", () => {
    const { base, options } = composerFixture();
    const pluginPath = join(options.stateDir, "product-plugins", "longhub-tool-bridge");
    const config = composeOpenClawAgentConfig(base, {
      ...options,
      toolBridgePluginPath: pluginPath,
    }) as any;
    const [main, hr] = config.agents.list;
    expect(main.tools.allow).toBeUndefined();
    expect(hr.tools.allow).toEqual([
      "longhub_offer_letter",
      "longhub_resume_screen",
    ]);
    expect(config.plugins).toMatchObject({
      enabled: true,
      allow: ["longhub-tool-bridge"],
      load: { paths: [pluginPath] },
      entries: { "longhub-tool-bridge": { enabled: true } },
    });
  });

  it("拒绝失配 Registry、未知模型策略和不兼容 OpenClaw", () => {
    const { base, options } = composerFixture();
    expect(() =>
      composeOpenClawAgentConfig(base, {
        ...options,
        profiles: [
          {
            ...options.profiles[0]!,
            registry: { ...options.profiles[0]!.registry, packVersion: "9.9.9" },
          },
        ],
      }),
    ).toThrow("不一致");
    expect(() =>
      composeOpenClawAgentConfig(base, { ...options, modelPolicies: {} }),
    ).toThrow("longhub.model.default");
    expect(() =>
      composeOpenClawAgentConfig(base, { ...options, openclawVersion: "2026.8.0" }),
    ).toThrow("OpenClaw 版本不兼容");
  });

  it("拒绝 stateDir 外的 main workspace", () => {
    const { base, options } = composerFixture();
    expect(() =>
      composeOpenClawAgentConfig(base, {
        ...options,
        mainWorkspaceDir: join(options.stateDir, "..", "user-openclaw-workspace"),
      }),
    ).toThrow("必须位于");
  });

  it("通过锁定 OpenClaw 2026.7.1-2 的真实配置校验", () => {
    const { base, options } = composerFixture();
    const config = composeOpenClawAgentConfig(base, options);
    const configPath = join(options.stateDir, "openclaw.json");
    mkdirSync(options.stateDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
    const openclawEntry = fileURLToPath(new URL("../node_modules/openclaw/openclaw.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [openclawEntry, "config", "validate"], {
      encoding: "utf8",
      cwd: options.stateDir,
      env: {
        ...process.env,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: options.stateDir,
        LONGHUB_MODEL_TOKEN: "test-device-token",
      },
      // Full-workspace runs start several real OpenClaw processes concurrently.
      // Keep the integration assertion, but allow for Windows process contention.
      timeout: 60_000,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  }, 70_000);

  it("锁定 OpenClaw 能发现并加载 Bridge 的真实运行时契约", () => {
    const { base, options } = composerFixture();
    const pluginSource = fileURLToPath(
      new URL("../../../packages/longhub-openclaw-bridge", import.meta.url),
    );
    const pluginPath = join(options.stateDir, "product-plugins", "longhub-tool-bridge");
    cpSync(pluginSource, pluginPath, {
      recursive: true,
      filter: (source) => !source.includes(`${join(pluginSource, "node_modules")}`) &&
        !source.includes(`${join(pluginSource, ".turbo")}`),
    });
    cpSync(join(pluginSource, "node_modules", "typebox"), join(pluginPath, "node_modules", "typebox"), {
      recursive: true,
      dereference: true,
    });
    const config = composeOpenClawAgentConfig(base, { ...options, toolBridgePluginPath: pluginPath });
    const configPath = join(options.stateDir, "openclaw.json");
    mkdirSync(options.stateDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
    const openclawEntry = fileURLToPath(new URL("../node_modules/openclaw/openclaw.mjs", import.meta.url));
    const result = spawnSync(
      process.execPath,
      [openclawEntry, "plugins", "inspect", "longhub-tool-bridge", "--runtime", "--json"],
      {
        encoding: "utf8",
        cwd: options.stateDir,
        env: {
          ...process.env,
          VITEST: undefined,
          VITEST_WORKER_ID: undefined,
          VITEST_POOL_ID: undefined,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: options.stateDir,
          LONGHUB_MODEL_TOKEN: "test-device-token",
          LONGHUB_BRIDGE_URL: "http://127.0.0.1:30123/v1/execute",
          LONGHUB_BRIDGE_TOKEN: "a".repeat(64),
        },
        // Plugin discovery is intentionally validated through the real CLI.
        timeout: 60_000,
      },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const inspected = JSON.parse(result.stdout) as any;
    expect(inspected, JSON.stringify(inspected, null, 2)).toMatchObject({
      plugin: {
        id: "longhub-tool-bridge",
        status: "loaded",
        imported: true,
        activated: true,
        toolNames: ["longhub_resume_screen", "longhub_offer_letter"],
      },
      tools: [
        { names: ["longhub_resume_screen"], optional: true },
        { names: ["longhub_offer_letter"], optional: true },
      ],
    });
  }, 70_000);
});
