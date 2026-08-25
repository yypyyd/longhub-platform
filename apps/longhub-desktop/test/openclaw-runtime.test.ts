import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildOpenClawConfig,
  fetchClientRuntimeConfig,
  initializeOpenClawWorkspace,
  LONGHUB_IDENTITY_MD,
  modelProxyBaseUrl,
  parseClientRuntimeConfig,
  RuntimeConfigRequestError,
} from "../src/openclaw-runtime.js";

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

const versionedRuntime = {
  schema_version: "longhub/runtime-config/v1" as const,
  config_version: "2026-07-30T00:00:00.000Z",
  issued_at: "2026-07-30T00:00:00.000Z",
  expires_at: "2026-07-30T00:10:00.000Z",
  compatible_manager: { min_version: "0.0.0" },
  product: { assistant_name: "龙枢助手", assistant_avatar_path: "/assets/longhub-avatar.png", welcome_message: "你好，我是龙枢助手。", quick_tasks: [] },
  features: { agent_catalog: true, file_upload: true, tool_execution: true },
  ...runtime,
};

describe("OpenClaw 固定模型运行配置", () => {
  it("使用设备凭据从龙枢后台读取配置", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(versionedRuntime), { status: 200 }));
    await expect(fetchClientRuntimeConfig(
      "https://cloud.example",
      "dt-secret",
      fetchMock,
    )).resolves.toEqual(versionedRuntime);
    expect(fetchMock).toHaveBeenCalledWith("https://cloud.example/v1/client/runtime-config", expect.objectContaining({
      headers: { authorization: "Bearer dt-secret" },
      redirect: "error",
      signal: expect.any(AbortSignal),
    }));
  });

  it.each([
    ["未知字段", { ...versionedRuntime, unexpected: true }],
    ["外部代理路径", { ...versionedRuntime, base_path: "https://evil.example/v1" }],
    ["倒置有效期", { ...versionedRuntime, expires_at: versionedRuntime.issued_at }],
    ["非规范时间", { ...versionedRuntime, issued_at: "2026-07-30 00:00:00Z" }],
    ["过长有效期", { ...versionedRuntime, expires_at: "2026-07-30T00:10:00.001Z" }],
    ["非整数 token", { ...versionedRuntime, max_tokens: 1_024.5 }],
    ["越界 token", { ...versionedRuntime, max_tokens: 256_000 }],
  ])("严格拒绝%s的运行配置", (_label, candidate) => {
    expect(() => parseClientRuntimeConfig(candidate)).toThrow("无效的客户端模型配置");
  });

  it.each([
    [401, false],
    [403, false],
    [429, true],
    [500, true],
  ])("HTTP %i 的重试和缓存策略为 %s", async (status, transient) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: "SAFE_ERROR" }), { status }));
    const error = await fetchClientRuntimeConfig("https://cloud.example", "dt-secret", fetchMock)
      .then(() => undefined, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(RuntimeConfigRequestError);
    expect(error).toMatchObject({ status, retryable: transient, cacheAllowed: transient, code: "SAFE_ERROR" });
  });

  it("只生成一个模型 allowlist，设备凭据保留为环境变量占位符", () => {
    const workspaceDir = "C:\\Users\\tester\\AppData\\Roaming\\longhub-desktop\\openclaw\\workspace";
    const config = buildOpenClawConfig("https://cloud.example", runtime, workspaceDir) as any;
    expect(config.gateway.mode).toBe("local");
    expect(config.agents.defaults.workspace).toBe(workspaceDir);
    expect(config.agents.defaults.skipBootstrap).toBe(true);
    expect(config.agents.defaults.model.primary).toBe("longhub/longhub-default");
    expect(Object.keys(config.agents.defaults.models)).toEqual(["longhub/longhub-default"]);
    expect(config.models.mode).toBe("replace");
    expect(config.models.providers.longhub.apiKey).toBe("${LONGHUB_MODEL_TOKEN}");
    expect(config.models.providers.longhub.baseUrl).toBe("https://cloud.example/v1/model");
    expect(config.models.providers.longhub.models).toHaveLength(1);
  });

  it("在独立工作区预置龙枢身份且不覆盖已有定制", () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "longhub-workspace-"));
    try {
      const avatarSource = join(workspaceDir, "avatar-source.png");
      writeFileSync(avatarSource, Buffer.from("longhub-avatar"));
      const identityPath = initializeOpenClawWorkspace(workspaceDir, avatarSource);
      expect(readFileSync(identityPath, "utf8")).toBe(LONGHUB_IDENTITY_MD);
      expect(readFileSync(identityPath, "utf8")).toContain("**Name:** 龙枢助手");
      expect(readFileSync(join(workspaceDir, "avatars", "longhub.png"))).toEqual(Buffer.from("longhub-avatar"));

      writeFileSync(identityPath, "# 自定义身份\n", "utf8");
      initializeOpenClawWorkspace(workspaceDir);
      expect(readFileSync(identityPath, "utf8")).toBe("# 自定义身份\n");
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("拒绝缺失的独立工作区路径，避免回退到用户全局 OpenClaw", () => {
    expect(() => buildOpenClawConfig("https://cloud.example", runtime, " ")).toThrow("工作区路径不能为空");
  });

  it("拒绝把模型代理重定向到不同源", () => {
    expect(() => modelProxyBaseUrl("https://cloud.example", "//evil.example/v1")).toThrow();
  });
});
