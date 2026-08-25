import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeConfigRequestError } from "../src/openclaw-runtime.js";
import {
  resolveClientRuntimeConfig,
  RuntimeConfigUnavailableError,
} from "../src/runtime-config-resolver.js";

const NOW = Date.parse("2026-07-30T00:01:00.000Z");
const runtime = {
  schema_version: "longhub/runtime-config/v1" as const,
  config_version: "2026-07-30T00:00:00.000Z",
  issued_at: "2026-07-30T00:00:00.000Z",
  expires_at: "2026-07-30T00:10:00.000Z",
  provider_id: "longhub" as const,
  base_path: "/v1/model",
  model_id: "longhub-default" as const,
  display_name: "龙枢默认模型",
  api_type: "openai-completions" as const,
  context_window: 128_000,
  max_tokens: 8_192,
  allow_user_model_selection: false as const,
  compatible_manager: { min_version: "0.0.0" },
  product: { assistant_name: "龙枢助手", assistant_avatar_path: "/assets/longhub-avatar.png", welcome_message: "你好，我是龙枢助手。", quick_tasks: [] },
  features: { agent_catalog: true, file_upload: true, tool_execution: true },
};

const temporaryDirectories: string[] = [];

function temporaryCache(): { root: string; cacheFile: string } {
  const root = mkdtempSync(join(tmpdir(), "longhub-runtime-config-"));
  temporaryDirectories.push(root);
  return { root, cacheFile: join(root, "runtime-config-cache.json") };
}

function response(body: unknown = runtime, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function options(cacheFile: string, fetchImpl: typeof fetch) {
  return {
    cloudBaseUrl: "https://cloud.example",
    deviceId: "device-a",
    deviceToken: "dt-super-secret",
    cacheFile,
    fetchImpl,
    now: () => NOW,
    sleep: async () => {},
    random: () => 0,
    backoffBaseMs: 100,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
});

describe("运行配置指数退避与安全缓存", () => {
  it("网络瞬时失败时指数退避，并在第三次成功后停止", async () => {
    const { cacheFile } = temporaryCache();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(response());
    const sleep = vi.fn(async () => {});

    await expect(resolveClientRuntimeConfig({
      ...options(cacheFile, fetchMock as typeof fetch),
      sleep,
    })).resolves.toMatchObject({ source: "network", attempts: 3, config: runtime });
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([100, 200]);
  });

  it("在线成功后只缓存公开路由元数据，不落盘设备 Token", async () => {
    const { cacheFile } = temporaryCache();
    await resolveClientRuntimeConfig(options(cacheFile, vi.fn(async () => response()) as typeof fetch));

    const saved = readFileSync(cacheFile, "utf8");
    expect(saved).toContain("longhub/runtime-config-cache/v2");
    expect(saved).toContain("device-a");
    expect(saved).not.toContain("dt-super-secret");
    expect(saved).not.toMatch(/api[_-]?key/i);
    expect(readdirSync(join(cacheFile, "..")).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("使用缓存 ETag 条件刷新，并用服务端新有效期继续运行", async () => {
    const { cacheFile } = temporaryCache();
    const etag = 'W/"abcdefghijklmnop"';
    await resolveClientRuntimeConfig(options(cacheFile, vi.fn(async () => new Response(JSON.stringify(runtime), {
      status: 200,
      headers: { "content-type": "application/json", etag },
    })) as typeof fetch));
    const conditional = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ "if-none-match": etag });
      return new Response(null, {
        status: 304,
        headers: {
          etag,
          "x-longhub-config-issued-at": "2026-07-30T00:01:00.000Z",
          "x-longhub-config-expires-at": "2026-07-30T00:11:00.000Z",
        },
      });
    });
    await expect(resolveClientRuntimeConfig(options(cacheFile, conditional as typeof fetch))).resolves.toMatchObject({
      source: "network",
      config: { expires_at: "2026-07-30T00:11:00.000Z" },
    });
  });

  it("重试耗尽后使用同源、同设备且未过期的缓存", async () => {
    const { cacheFile } = temporaryCache();
    await resolveClientRuntimeConfig(options(cacheFile, vi.fn(async () => response()) as typeof fetch));
    const transientFailure = vi.fn(async () => response({ code: "UPSTREAM_UNAVAILABLE" }, 503));

    await expect(resolveClientRuntimeConfig({
      ...options(cacheFile, transientFailure as typeof fetch),
      maxAttempts: 2,
    })).resolves.toMatchObject({ source: "cache", attempts: 2, config: runtime });
    expect(transientFailure).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403])("HTTP %i 不重试，也绝不回退已有缓存", async (status) => {
    const { cacheFile } = temporaryCache();
    await resolveClientRuntimeConfig(options(cacheFile, vi.fn(async () => response()) as typeof fetch));
    const unauthorized = vi.fn(async () => response({ code: "ACTIVATION_REQUIRED" }, status));

    const error = await resolveClientRuntimeConfig({
      ...options(cacheFile, unauthorized as typeof fetch),
      maxAttempts: 3,
    }).then(() => undefined, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(RuntimeConfigRequestError);
    expect(error).toMatchObject({ status, retryable: false, cacheAllowed: false });
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });

  it("拒绝过期缓存和已过期的在线响应", async () => {
    const { cacheFile } = temporaryCache();
    await resolveClientRuntimeConfig(options(cacheFile, vi.fn(async () => response()) as typeof fetch));
    const transientFailure = vi.fn(async () => response({ code: "UNAVAILABLE" }, 503));

    await expect(resolveClientRuntimeConfig({
      ...options(cacheFile, transientFailure as typeof fetch),
      maxAttempts: 1,
      now: () => Date.parse(runtime.expires_at),
    })).rejects.toMatchObject({ reason: "expired" });

    await expect(resolveClientRuntimeConfig({
      ...options(join(temporaryCache().root, "expired-online.json"), vi.fn(async () => response()) as typeof fetch),
      now: () => Date.parse(runtime.expires_at),
    })).rejects.toThrow("已过期或尚未生效");
  });

  it.each([
    ["其他设备", { deviceId: "device-b" }],
    ["其他 Cloud", { cloudBaseUrl: "https://other.example" }],
  ])("拒绝%s的缓存", async (_label, override) => {
    const { cacheFile } = temporaryCache();
    await resolveClientRuntimeConfig(options(cacheFile, vi.fn(async () => response()) as typeof fetch));

    await expect(resolveClientRuntimeConfig({
      ...options(cacheFile, vi.fn(async () => response({ code: "UNAVAILABLE" }, 503)) as typeof fetch),
      ...override,
      maxAttempts: 1,
    })).rejects.toBeInstanceOf(RuntimeConfigUnavailableError);
  });

  it.each([
    ["损坏 JSON", "{not-json"],
    ["未知缓存字段", JSON.stringify({ unexpected: true })],
  ])("拒绝%s缓存", async (_label, content) => {
    const { cacheFile } = temporaryCache();
    writeFileSync(cacheFile, content, "utf8");
    await expect(resolveClientRuntimeConfig({
      ...options(cacheFile, vi.fn(async () => response({ code: "UNAVAILABLE" }, 503)) as typeof fetch),
      maxAttempts: 1,
    })).rejects.toMatchObject({ reason: "invalid" });
  });

  it("拒绝符号链接缓存文件", async () => {
    const { root, cacheFile } = temporaryCache();
    const target = join(root, "target.json");
    writeFileSync(target, JSON.stringify(runtime), "utf8");
    try {
      symlinkSync(target, cacheFile, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    await expect(resolveClientRuntimeConfig({
      ...options(cacheFile, vi.fn(async () => response({ code: "UNAVAILABLE" }, 503)) as typeof fetch),
      maxAttempts: 1,
    })).rejects.toMatchObject({ reason: "invalid" });
  });

  it("缓存写入失败不阻断本次在线启动", async () => {
    const { root } = temporaryCache();
    const blockingParent = join(root, "not-a-directory");
    writeFileSync(blockingParent, "block", "utf8");
    const onCacheWriteFailure = vi.fn();

    await expect(resolveClientRuntimeConfig({
      ...options(join(blockingParent, "cache.json"), vi.fn(async () => response()) as typeof fetch),
      onCacheWriteFailure,
    })).resolves.toMatchObject({ source: "network", attempts: 1 });
    expect(onCacheWriteFailure).toHaveBeenCalledOnce();
  });
});
