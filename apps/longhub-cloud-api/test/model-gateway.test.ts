import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { once } from "node:events";
import type { AddressInfo, LookupFunction } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCloudApiServer } from "../src/server.js";
import { MemoryStore } from "../src/memory-store.js";
import type { ModelRequestAggregateRecord, ModelUsageAggregateRecord } from "../src/store.js";
import { activateTestDevice } from "./helpers/activate-device.js";
import {
  decryptModelApiKey,
  encryptModelApiKey,
  createPinnedUpstreamLookup,
  isAllowedConnectedAddress,
  isDisallowedUpstreamAddress,
  normalizeUpstreamBaseUrl,
  resolveModelGatewayConfig,
  RUNTIME_CONFIG_SCHEMA,
  RUNTIME_CONFIG_TTL_MS,
} from "../src/model-gateway.js";

let upstream: ReturnType<typeof createServer>;
let cloud: ReturnType<typeof createCloudApiServer>;
let baseUrl: string;
let upstreamBaseUrl: string;
let deviceToken: string;
let deviceId: string;
let receivedModel = "";
let receivedAuthorization = "";
let upstreamMode: "success" | "rejected" | "slow" | "fallback" | "redirect" | "stream" = "success";
let redirectTargetHits = 0;
let upstreamRequestHits = 0;
let resolveUpstreamStreamClosed: (() => void) | undefined;
const encryptionKey = Buffer.alloc(32, 7);
class ModelMetricStore extends MemoryStore {
  failMetrics = false;
  private usageReadGate?: { announce(): void; wait: Promise<void> };

  blockNextUsageRead(): { started: Promise<void>; release(): void } {
    let announce!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { announce = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    this.usageReadGate = { announce, wait };
    return { started, release };
  }

  override async incrementModelRequestMetrics(records: readonly ModelRequestAggregateRecord[]): Promise<void> {
    if (this.failMetrics) throw new Error("metrics unavailable");
    return super.incrementModelRequestMetrics(records);
  }

  override async listModelUsage() {
    const gate = this.usageReadGate;
    if (gate) {
      this.usageReadGate = undefined;
      gate.announce();
      await gate.wait;
    }
    return super.listModelUsage();
  }
}
const store = new ModelMetricStore();

beforeAll(async () => {
  upstream = createServer((req, res) => {
    void (async () => {
      if (req.url === "/private-redirect-target") {
        redirectTargetHits += 1;
        res.end("unexpected redirect");
        return;
      }
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [] }));
        return;
      }
      upstreamRequestHits += 1;
      if (upstreamMode === "slow") {
        setTimeout(() => {
          if (!res.destroyed) res.end(JSON.stringify({ choices: [] }));
        }, 3_000);
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      receivedModel = (JSON.parse(body) as { model: string }).model;
      receivedAuthorization = String(req.headers.authorization ?? "");
      if (upstreamMode === "redirect") {
        res.writeHead(302, { location: "/private-redirect-target" });
        res.end();
        return;
      }
      if (upstreamMode === "stream") {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write(`${JSON.stringify({ model: receivedModel })}\n`);
        res.once("close", () => {
          if (!res.writableEnded) resolveUpstreamStreamClosed?.();
        });
        return;
      }
      const rejected = upstreamMode === "rejected" || (upstreamMode === "fallback" && receivedModel === "device-model");
      res.writeHead(rejected ? 429 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "chat-1", object: "chat.completion", model: receivedModel, choices: [] }));
    })();
  }).listen(0);
  await once(upstream, "listening");
  upstreamBaseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;

  cloud = createCloudApiServer({
    executorUrl: "http://127.0.0.1:1",
    adminToken: "admin-test",
    legacySurfaceEnabled: true,
    modelEncryptionKey: encryptionKey,
    allowInsecureModelUpstream: true,
    modelProxyTimeoutMs: 2_000,
    store,
  }).listen(0);
  await once(cloud, "listening");
  baseUrl = `http://127.0.0.1:${(cloud.address() as AddressInfo).port}`;
  const registered = await fetch(`${baseUrl}/v1/devices/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform: "windows", app_version: "0.3.2", device_fingerprint: "fp-model-test" }),
  });
  const registeredBody = (await registered.json()) as { device_token: string; device_id: string };
  deviceToken = registeredBody.device_token;
  deviceId = registeredBody.device_id;
  await activateTestDevice(baseUrl, "admin-test", deviceToken);
});

afterAll(() => {
  cloud.close();
  upstream.close();
});

describe("模型配置密钥", () => {
  it("AES-GCM 加密可恢复且不保存明文", () => {
    const encrypted = encryptModelApiKey("sk-upstream-secret", encryptionKey);
    expect(encrypted).not.toContain("sk-upstream-secret");
    expect(decryptModelApiKey(encrypted, encryptionKey)).toBe("sk-upstream-secret");
  });

  it("生产默认只允许 HTTPS 公网地址", () => {
    expect(normalizeUpstreamBaseUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1");
    expect(() => normalizeUpstreamBaseUrl("http://127.0.0.1:8000/v1")).toThrow("HTTPS");
    expect(() => normalizeUpstreamBaseUrl("https://[::ffff:7f00:1]/v1")).toThrow("私网");
  });

  it("DNS 结果拒绝私网和 IPv4-mapped IPv6，并固定本次连接地址", async () => {
    await expect(createPinnedUpstreamLookup("provider.example", async () => [
      { address: "127.0.0.1", family: 4 },
    ])).rejects.toThrow("私网");
    await expect(createPinnedUpstreamLookup("provider.example", async () => [
      { address: "::ffff:7f00:1", family: 6 },
    ])).rejects.toThrow("私网");
    await expect(createPinnedUpstreamLookup("provider.example", async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.8", family: 4 },
    ])).rejects.toThrow("私网");
    expect(isDisallowedUpstreamAddress("169.254.10.20")).toBe(true);
    expect(isDisallowedUpstreamAddress("fe80::1%eth0")).toBe(true);

    for (const transitionAddress of [
      "64:ff9b::7f00:1",
      "::ffff:0:7f00:1",
      "2001::1",
      "2001:20::1",
      "2002:7f00:1::",
      "fec0::1",
      "101::1",
      "4000::1",
      "8000::1",
    ]) {
      expect(isDisallowedUpstreamAddress(transitionAddress)).toBe(true);
      expect(isAllowedConnectedAddress(transitionAddress)).toBe(false);
      expect(() => normalizeUpstreamBaseUrl(`https://[${transitionAddress}]/v1`)).toThrow("私网");
      await expect(createPinnedUpstreamLookup("provider.example", async () => [
        { address: transitionAddress, family: 6 },
      ])).rejects.toThrow("私网");
    }
    expect(isAllowedConnectedAddress("2001:4860:4860::8888")).toBe(true);

    let resolutions = 0;
    const pinnedLookup = await createPinnedUpstreamLookup("provider.example", async () => {
      resolutions += 1;
      return resolutions === 1
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "127.0.0.1", family: 4 }];
    });
    const lookupOnce = (lookup: LookupFunction): Promise<string> => new Promise((resolve, reject) => {
      lookup("provider.example", { all: false }, (error, address) => {
        if (error) reject(error);
        else if (typeof address === "string") resolve(address);
        else reject(new Error("expected one pinned address"));
      });
    });
    await expect(lookupOnce(pinnedLookup)).resolves.toBe("93.184.216.34");
    await expect(lookupOnce(pinnedLookup)).resolves.toBe("93.184.216.34");
    expect(resolutions).toBe(1);
  });

  it("等待 DNS 解析时可由 AbortSignal 立即停止", async () => {
    let release!: (addresses: readonly { address: string; family: 4 }[]) => void;
    const pending = new Promise<readonly { address: string; family: 4 }[]>((resolve) => { release = resolve; });
    const controller = new AbortController();
    const lookup = createPinnedUpstreamLookup("provider.example", () => pending, controller.signal);
    controller.abort(new Error("client disconnected"));
    await expect(lookup).rejects.toThrow("client disconnected");
    release([{ address: "93.184.216.34", family: 4 }]);
  });
});

describe("固定 OpenAI 兼容模型代理", () => {
  it("上游尚未配置时仍下发固定别名，让客户端可以直接进入聊天", async () => {
    const runtime = await fetch(`${baseUrl}/v1/client/runtime-config`, { headers: { authorization: `Bearer ${deviceToken}` } });
    expect(runtime.status).toBe(200);
    expect(runtime.headers.get("cache-control")).toBe("private, no-store");
    const body = await runtime.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      schema_version: RUNTIME_CONFIG_SCHEMA,
      config_version: "unconfigured",
      model_id: "longhub-default",
      allow_user_model_selection: false,
    });
    expect(Date.parse(String(body.expires_at)) - Date.parse(String(body.issued_at))).toBe(RUNTIME_CONFIG_TTL_MS);
  });

  it("runtime-config 支持策略 ETag 条件刷新", async () => {
    const first = await fetch(`${baseUrl}/v1/client/runtime-config`, { headers: { authorization: `Bearer ${deviceToken}` } });
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^W\/"/);
    const second = await fetch(`${baseUrl}/v1/client/runtime-config`, {
      headers: { authorization: `Bearer ${deviceToken}`, "if-none-match": etag! },
    });
    expect(second.status).toBe(304);
    expect(second.headers.get("x-longhub-config-expires-at")).toBeTruthy();
  });

  it("管理端保存配置、客户端读取固定别名、代理强制覆盖真实模型", async () => {
    upstreamMode = "success";
    const saved = await fetch(`${baseUrl}/v1/admin/model-config`, {
      method: "POST",
      headers: { authorization: "Bearer admin-test", "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, base_url: upstreamBaseUrl, model_id: "real-model", display_name: "龙枢模型", api_type: "openai-completions", context_window: 64_000, max_tokens: 4_096, input_capabilities: ["text", "image"], api_key: "sk-upstream-secret" }),
    });
    expect(saved.status).toBe(200);
    expect((await saved.json()) as object).not.toHaveProperty("api_key");

    const runtime = await fetch(`${baseUrl}/v1/client/runtime-config`, { headers: { authorization: `Bearer ${deviceToken}` } });
    expect(runtime.status).toBe(200);
    expect(runtime.headers.get("cache-control")).toBe("private, no-store");
    const runtimeBody = await runtime.json() as Record<string, unknown>;
    expect(runtimeBody).toMatchObject({
      schema_version: RUNTIME_CONFIG_SCHEMA,
      model_id: "longhub-default",
      allow_user_model_selection: false,
    });
    expect(typeof runtimeBody.config_version).toBe("string");
    expect(Date.parse(String(runtimeBody.expires_at)) - Date.parse(String(runtimeBody.issued_at))).toBe(RUNTIME_CONFIG_TTL_MS);

    const capabilities = await fetch(`${baseUrl}/v1/client/model-capabilities`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(await capabilities.json()).toEqual({
      schema_version: "longhub/model-capabilities/v1",
      model_id: "longhub-default",
      input: ["text", "image"],
      file_inputs: { text_extraction: true, image_understanding: true },
    });

    const proxied = await fetch(`${baseUrl}/v1/model/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "user-selected-model", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(proxied.status).toBe(200);
    expect(receivedModel).toBe("real-model");
    expect(receivedAuthorization).toBe("Bearer sk-upstream-secret");
    await new Promise((resolve) => setImmediate(resolve));
    expect((await store.listModelRequestMetrics()).some((row) => row.outcome === "success" && row.count === 1)).toBe(true);
    const usage = await store.listModelUsage();
    expect(usage.some((row) => row.period === "day" && row.device_id === deviceId && row.request_count === 1)).toBe(true);
    expect(JSON.stringify(usage)).not.toMatch(/prompt|messages|response|authorization|api_key/i);
  });

  it("旧配置缺少 features 时保存会补默认值而不是抛出空值错误", async () => {
    const current = await store.getModelGatewayConfig("default");
    expect(current).toBeTruthy();
    await store.setModelGatewayConfig({ ...current!, features: undefined } as any);
    const response = await fetch(`${baseUrl}/v1/admin/model-config`, {
      method: "POST",
      headers: { authorization: "Bearer admin-test", "content-type": "application/json" },
      body: JSON.stringify({ config_id: "default", assistant_name: "龙枢助手" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      features: { agent_catalog: true, file_upload: true, tool_execution: true },
    });
  });

  it("只保存上游拒绝和超时的匿名小时聚合", async () => {
    upstreamMode = "rejected";
    const rejected = await fetch(`${baseUrl}/v1/model/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "ignored", messages: [] }),
    });
    expect(rejected.status).toBe(429);

    upstreamMode = "slow";
    const timedOut = await fetch(`${baseUrl}/v1/model/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "ignored", messages: [] }),
    });
    expect(timedOut.status).toBe(502);
    await new Promise((resolve) => setImmediate(resolve));
    const rows = await store.listModelRequestMetrics();
    expect(rows.some((row) => row.outcome === "upstream_rejected")).toBe(true);
    expect(rows.some((row) => row.outcome === "timeout")).toBe(true);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toMatch(/device|tenant|message|url|model_id|duration_ms/i);
  });

  it("指标存储故障不阻断模型响应", async () => {
    upstreamMode = "success";
    store.failMetrics = true;
    try {
      const response = await fetch(`${baseUrl}/v1/model/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "ignored", messages: [] }),
      });
      expect(response.status).toBe(200);
    } finally {
      store.failMetrics = false;
    }
  });

  it("设备策略覆盖租户与全局策略，并执行兼容范围和紧急停用", async () => {
    const savePolicy = (body: Record<string, unknown>) => fetch(`${baseUrl}/v1/admin/model-config`, {
      method: "POST",
      headers: { authorization: "Bearer admin-test", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect((await savePolicy({
      config_id: "tenant-default-policy",
      scope_type: "tenant",
      scope_id: "tenant-default",
      enabled: true,
      base_url: upstreamBaseUrl,
      model_id: "tenant-model",
      display_name: "租户模型",
      api_key: "sk-tenant",
    })).status).toBe(200);
    expect((await savePolicy({
      config_id: "device-test-policy",
      scope_type: "device",
      scope_id: deviceId,
      enabled: true,
      base_url: upstreamBaseUrl,
      model_id: "device-model",
      display_name: "设备模型",
      assistant_name: "财务助手",
      welcome_message: "你好，我可以协助财务工作。",
      quick_tasks: ["汇总本月费用"],
      api_key: "sk-device",
    })).status).toBe(200);
    const runtimeResponse = await fetch(`${baseUrl}/v1/client/runtime-config`, { headers: { authorization: `Bearer ${deviceToken}` } });
    expect(await runtimeResponse.json()).toMatchObject({
      display_name: "设备模型",
      product: { assistant_name: "财务助手", quick_tasks: ["汇总本月费用"] },
    });
    upstreamMode = "success";
    expect((await fetch(`${baseUrl}/v1/model/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "forged", messages: [] }),
    })).status).toBe(200);
    expect(receivedModel).toBe("device-model");

    expect((await savePolicy({ config_id: "device-test-policy", min_manager_version: "9.0.0" })).status).toBe(200);
    expect((await fetch(`${baseUrl}/v1/client/runtime-config`, { headers: { authorization: `Bearer ${deviceToken}` } })).status).toBe(426);
    const hitsBeforeUnsupportedPost = upstreamRequestHits;
    const unsupportedPost = await fetch(`${baseUrl}/v1/model/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(unsupportedPost.status).toBe(426);
    expect(await unsupportedPost.json()).toMatchObject({ code: "CLIENT_VERSION_UNSUPPORTED" });
    expect(upstreamRequestHits).toBe(hitsBeforeUnsupportedPost);
    expect((await savePolicy({ config_id: "device-test-policy", min_manager_version: "0.0.0", emergency_disabled: true })).status).toBe(200);
    expect((await fetch(`${baseUrl}/v1/client/runtime-config`, { headers: { authorization: `Bearer ${deviceToken}` } })).status).toBe(503);
    expect((await savePolicy({ config_id: "device-test-policy", emergency_disabled: false })).status).toBe(200);
  });

  it("严格按 SemVer 处理预发布版本，并对非法存量版本关闭模型执行", async () => {
    const savePolicy = (body: Record<string, unknown>) => fetch(`${baseUrl}/v1/admin/model-config`, {
      method: "POST",
      headers: { authorization: "Bearer admin-test", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect((await savePolicy({ config_id: "device-test-policy", min_manager_version: "1.0.0" })).status).toBe(200);

    await store.updateDeviceVersion(deviceId, "1.0.0-alpha");
    expect((await fetch(`${baseUrl}/v1/client/runtime-config`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    })).status).toBe(426);
    let hitsBeforePost = upstreamRequestHits;
    expect((await fetch(`${baseUrl}/v1/model/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    })).status).toBe(426);
    expect(upstreamRequestHits).toBe(hitsBeforePost);

    await store.updateDeviceVersion(deviceId, "zzz");
    hitsBeforePost = upstreamRequestHits;
    expect((await fetch(`${baseUrl}/v1/model/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    })).status).toBe(426);
    expect(upstreamRequestHits).toBe(hitsBeforePost);

    await store.updateDeviceVersion(deviceId, "0.3.2");
    expect((await savePolicy({ config_id: "device-test-policy", min_manager_version: "0.0.0" })).status).toBe(200);
    for (const invalidMaxVersion of ["", 0, false] as const) {
      expect((await savePolicy({
        config_id: "device-test-policy",
        max_manager_version: invalidMaxVersion,
      })).status).toBe(422);
    }
    const stored = await store.getModelGatewayConfig("device-test-policy");
    if (!stored) throw new Error("device model policy missing");
    await store.setModelGatewayConfig({ ...stored, max_manager_version: "" });
    hitsBeforePost = upstreamRequestHits;
    expect((await fetch(`${baseUrl}/v1/model/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    })).status).toBe(426);
    expect(upstreamRequestHits).toBe(hitsBeforePost);
    await store.setModelGatewayConfig({ ...stored, max_manager_version: undefined });
  });

  it("fallback 只使用当前设备上下文适用且 API 类型一致的策略", async () => {
    const savePolicy = (body: Record<string, unknown>) => fetch(`${baseUrl}/v1/admin/model-config`, {
      method: "POST",
      headers: { authorization: "Bearer admin-test", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect((await savePolicy({
      config_id: "other-tenant-fallback",
      scope_type: "tenant",
      scope_id: "tenant-other",
      enabled: true,
      base_url: upstreamBaseUrl,
      model_id: "other-tenant-model",
      display_name: "其他租户模型",
      api_key: "sk-other-tenant",
    })).status).toBe(200);
    expect((await savePolicy({
      config_id: "responses-fallback",
      scope_type: "tenant",
      scope_id: "tenant-default",
      enabled: true,
      base_url: upstreamBaseUrl,
      model_id: "responses-model",
      display_name: "Responses 模型",
      api_type: "openai-responses",
      api_key: "sk-responses",
    })).status).toBe(200);

    upstreamMode = "fallback";
    expect((await savePolicy({
      config_id: "tenant-default-policy",
      device_daily_tokens: 1_000_000,
      input_cost_microunits_per_million: 1_000_000,
      output_cost_microunits_per_million: 1_000_000,
    })).status).toBe(200);
    expect((await savePolicy({
      config_id: "device-test-policy",
      fallback_config_id: "tenant-default-policy",
      circuit_breaker_threshold: 100,
    })).status).toBe(200);
    const usageBefore = await store.listModelUsage();
    const compatible = await fetch(`${baseUrl}/v1/model/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(compatible.status).toBe(200);
    expect(receivedModel).toBe("tenant-model");
    const usageAfter = await store.listModelUsage();
    const dayTotals = (records: readonly ModelUsageAggregateRecord[], configId: string) => records
      .filter((row) => row.period === "day" && row.device_id === deviceId && row.config_id === configId)
      .reduce((totals, row) => ({
        requests: totals.requests + row.request_count,
        successes: totals.successes + row.success_count,
        errors: totals.errors + row.error_count,
        cost: totals.cost + row.cost_microunits,
      }), { requests: 0, successes: 0, errors: 0, cost: 0 });
    const beforePrimary = dayTotals(usageBefore, "device-test-policy");
    const afterPrimary = dayTotals(usageAfter, "device-test-policy");
    const beforeFallback = dayTotals(usageBefore, "tenant-default-policy");
    const afterFallback = dayTotals(usageAfter, "tenant-default-policy");
    expect(afterPrimary.requests - beforePrimary.requests).toBe(1);
    expect(afterPrimary.errors - beforePrimary.errors).toBe(1);
    expect(afterPrimary.cost - beforePrimary.cost).toBe(0);
    expect(afterFallback.requests - beforeFallback.requests).toBe(1);
    expect(afterFallback.successes - beforeFallback.successes).toBe(1);
    expect(afterFallback.cost - beforeFallback.cost).toBeGreaterThan(0);

    await store.incrementModelUsage([{
      period_start: new Date().toISOString().slice(0, 10),
      period: "day",
      tenant_id: "tenant-default",
      device_id: deviceId,
      config_id: "fallback-quota-fixture",
      request_count: 1,
      success_count: 1,
      error_count: 0,
      input_tokens: 1_000,
      output_tokens: 0,
      cache_tokens: 0,
      estimated_tokens: 0,
      cost_microunits: 0,
    }]);
    expect((await savePolicy({ config_id: "tenant-default-policy", device_daily_tokens: 1_000 })).status).toBe(200);
    const hitsBeforeFallbackQuota = upstreamRequestHits;
    const fallbackQuota = await fetch(`${baseUrl}/v1/model/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(fallbackQuota.status).toBe(429);
    expect(await fallbackQuota.json()).toMatchObject({ code: "MODEL_DAILY_QUOTA_EXCEEDED" });
    expect(upstreamRequestHits).toBe(hitsBeforeFallbackQuota + 1);

    expect((await savePolicy({
      config_id: "tenant-default-policy",
      device_daily_tokens: 1_000_000,
      max_manager_version: "0.1.0",
    })).status).toBe(200);
    const hitsBeforeUnsupportedFallback = upstreamRequestHits;
    const unsupportedFallback = await fetch(`${baseUrl}/v1/model/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(unsupportedFallback.status).toBe(429);
    expect(receivedModel).toBe("device-model");
    expect(upstreamRequestHits).toBe(hitsBeforeUnsupportedFallback + 1);
    expect((await savePolicy({ config_id: "tenant-default-policy", max_manager_version: null })).status).toBe(200);

    expect((await savePolicy({ config_id: "device-test-policy", fallback_config_id: "other-tenant-fallback" })).status).toBe(200);
    const wrongTenant = await fetch(`${baseUrl}/v1/model/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(wrongTenant.status).toBe(429);
    expect(receivedModel).toBe("device-model");

    expect((await savePolicy({ config_id: "device-test-policy", fallback_config_id: "responses-fallback" })).status).toBe(200);
    const wrongApi = await fetch(`${baseUrl}/v1/model/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(wrongApi.status).toBe(429);
    expect(receivedModel).toBe("device-model");
    expect((await savePolicy({ config_id: "device-test-policy", fallback_config_id: null })).status).toBe(200);
    upstreamMode = "success";
  });

  it("plan 策略只接受同一用户和租户当前有效的 Cloud Skill subscription", async () => {
    const savePolicy = (body: Record<string, unknown>) => fetch(`${baseUrl}/v1/admin/model-config`, {
      method: "POST",
      headers: { authorization: "Bearer admin-test", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    upstreamMode = "success";
    expect((await fetch(`${baseUrl}/v1/model/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    })).status).toBe(200);

    const { user } = await store.createUser({
      email: "model-plan-scope@example.test",
      password_hash: "test-only-hash",
    });
    await store.bindDevice(deviceId, user.user_id);
    const now = Date.now();
    const createPlanSubscription = async (params: {
      planId: string;
      tenantId: string;
      startsAt: number;
      expiresAt: number;
    }): Promise<void> => {
      await store.createCloudSkillPlan({
        plan_id: params.planId,
        name: params.planId,
        skill_ids: ["longhub.skill.model-policy-test"],
        price_monthly_fen: 1,
        price_yearly_fen: 1,
      });
      await store.createCloudSkillSubscription({
        user_id: user.user_id,
        tenant_id: params.tenantId,
        plan_id: params.planId,
        period: "monthly",
        starts_at: new Date(params.startsAt).toISOString(),
        expires_at: new Date(params.expiresAt).toISOString(),
        source_order_id: `model-policy-${params.planId}`,
      });
    };
    await createPlanSubscription({
      planId: "model-plan-active",
      tenantId: "tenant-default",
      startsAt: now - 60_000,
      expiresAt: now + 600_000,
    });
    await createPlanSubscription({
      planId: "model-plan-expired",
      tenantId: "tenant-default",
      startsAt: now - 120_000,
      expiresAt: now - 60_000,
    });
    await createPlanSubscription({
      planId: "model-plan-other-tenant",
      tenantId: "tenant-other",
      startsAt: now - 60_000,
      expiresAt: now + 600_000,
    });
    for (const [configId, planId, modelId] of [
      ["active-plan-policy", "model-plan-active", "active-plan-model"],
      ["expired-plan-policy", "model-plan-expired", "expired-plan-model"],
      ["other-tenant-plan-policy", "model-plan-other-tenant", "other-tenant-plan-model"],
    ] as const) {
      expect((await savePolicy({
        config_id: configId,
        scope_type: "plan",
        scope_id: planId,
        enabled: true,
        base_url: upstreamBaseUrl,
        model_id: modelId,
        display_name: modelId,
        api_key: `sk-${modelId}`,
      })).status).toBe(200);
    }

    const { device: planOnlyDevice } = await store.registerDevice({
      tenant_id: "tenant-default",
      platform: "windows",
      app_version: "1.0.0",
      device_fingerprint: "fp-model-plan-only",
    });
    const boundPlanOnlyDevice = await store.bindDevice(planOnlyDevice.device_id, user.user_id);
    expect((await resolveModelGatewayConfig(store, boundPlanOnlyDevice!))?.config_id).toBe("active-plan-policy");

    upstreamMode = "fallback";
    expect((await savePolicy({ config_id: "device-test-policy", fallback_config_id: "active-plan-policy" })).status).toBe(200);
    const active = await fetch(`${baseUrl}/v1/model/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(active.status).toBe(200);
    expect(receivedModel).toBe("active-plan-model");

    for (const fallbackConfigId of ["expired-plan-policy", "other-tenant-plan-policy"]) {
      expect((await savePolicy({ config_id: "device-test-policy", fallback_config_id: fallbackConfigId })).status).toBe(200);
      const rejected = await fetch(`${baseUrl}/v1/model/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
        body: JSON.stringify({ messages: [] }),
      });
      expect(rejected.status).toBe(429);
      expect(receivedModel).toBe("device-model");
    }
    expect((await savePolicy({ config_id: "device-test-policy", fallback_config_id: null })).status).toBe(200);
    upstreamMode = "success";
    expect((await fetch(`${baseUrl}/v1/model/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    })).status).toBe(200);
  });

  it("禁止上游重定向且不会访问重定向目标", async () => {
    redirectTargetHits = 0;
    upstreamMode = "redirect";
    const response = await fetch(`${baseUrl}/v1/model/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      code: "MODEL_UPSTREAM_ERROR",
      message: "上游模型服务暂时不可用，请稍后重试",
      retryable: true,
    });
    expect(redirectTargetHits).toBe(0);
    upstreamMode = "success";
  });

  it("下游响应提前 close 时中止仍在流式输出的上游请求", async () => {
    upstreamMode = "stream";
    const upstreamClosed = new Promise<void>((resolve) => {
      resolveUpstreamStreamClosed = resolve;
    });
    const requestBody = JSON.stringify({ messages: [] });
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = httpRequest(`${baseUrl}/v1/model/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${deviceToken}`,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(requestBody)),
        },
      }, resolve);
      request.once("error", reject);
      request.end(requestBody);
    });
    await once(response, "data");
    response.destroy();
    await expect(Promise.race([
      upstreamClosed.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ])).resolves.toBe(true);
    resolveUpstreamStreamClosed = undefined;
    upstreamMode = "success";
  });

  it("额度读取等待期间断开的客户端不会命中上游且会释放并发 lease", async () => {
    const saved = await fetch(`${baseUrl}/v1/admin/model-config`, {
      method: "POST",
      headers: { authorization: "Bearer admin-test", "content-type": "application/json" },
      body: JSON.stringify({
        config_id: "device-test-policy",
        fallback_config_id: null,
        max_device_concurrency: 1,
        device_requests_per_minute: 10_000,
        device_daily_tokens: 10_000_000,
      }),
    });
    expect(saved.status).toBe(200);
    upstreamMode = "success";
    const hitsBeforeAbort = upstreamRequestHits;
    const gate = store.blockNextUsageRead();
    const requestBody = JSON.stringify({ messages: [] });
    const request = httpRequest(`${baseUrl}/v1/model/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deviceToken}`,
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(requestBody)),
      },
    }, (response) => response.resume());
    request.on("error", () => undefined);
    request.end(requestBody);
    await expect(Promise.race([
      gate.started.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ])).resolves.toBe(true);
    const requestClosed = new Promise<void>((resolve) => request.once("close", resolve));
    request.destroy();
    await requestClosed;
    const nextController = new AbortController();
    const nextTimeout = setTimeout(() => nextController.abort(), 500);
    try {
      const next = await fetch(`${baseUrl}/v1/model/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
        body: requestBody,
        signal: nextController.signal,
      });
      expect(next.status).toBe(200);
      expect(upstreamRequestHits).toBe(hitsBeforeAbort + 1);
    } finally {
      clearTimeout(nextTimeout);
      gate.release();
    }
  });

  it("DNS 解析等待期间断开的客户端会立即释放并发 lease", async () => {
    const isolatedStore = new ModelMetricStore();
    let firstResolveStarted!: () => void;
    let secondResolveStarted!: () => void;
    const firstResolverStarted = new Promise<void>((resolve) => { firstResolveStarted = resolve; });
    const secondResolverStarted = new Promise<void>((resolve) => { secondResolveStarted = resolve; });
    let firstRelease!: () => void;
    let secondRelease!: () => void;
    const publicAddress = [{ address: "93.184.216.34", family: 4 as const }];
    let resolverCalls = 0;
    const resolveModelUpstreamHostname = async (): Promise<typeof publicAddress> => {
      resolverCalls += 1;
      if (resolverCalls === 1) {
        firstResolveStarted();
        return new Promise<typeof publicAddress>((resolve) => { firstRelease = () => resolve(publicAddress); });
      }
      if (resolverCalls === 2) {
        secondResolveStarted();
        return new Promise<typeof publicAddress>((resolve) => { secondRelease = () => resolve(publicAddress); });
      }
      throw new Error("fixture DNS unavailable");
    };
    const isolatedCloud = createCloudApiServer({
      executorUrl: "http://127.0.0.1:1",
      adminToken: "dns-test-admin",
      modelEncryptionKey: encryptionKey,
      allowInsecureModelUpstream: false,
      legacySurfaceEnabled: true,
      modelProxyTimeoutMs: 2_000,
      resolveModelUpstreamHostname,
      store: isolatedStore,
    }).listen(0);
    try {
      await once(isolatedCloud, "listening");
      const isolatedBaseUrl = `http://127.0.0.1:${(isolatedCloud.address() as AddressInfo).port}`;
      const registered = await fetch(`${isolatedBaseUrl}/v1/devices/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ platform: "windows", app_version: "1.0.0", device_fingerprint: "fp-dns-abort" }),
      });
      expect(registered.status).toBe(201);
      const registeredBody = await registered.json() as { device_token: string; device_id: string };
      const configured = await fetch(`${isolatedBaseUrl}/v1/admin/model-config`, {
        method: "POST",
        headers: { authorization: "Bearer dns-test-admin", "content-type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          base_url: "https://provider.example/v1",
          model_id: "dns-abort-model",
          display_name: "DNS abort test",
          api_key: "sk-dns-abort",
          max_device_concurrency: 1,
        }),
      });
      expect(configured.status).toBe(200);
      await activateTestDevice(isolatedBaseUrl, "dns-test-admin", registeredBody.device_token);

      const requestBody = JSON.stringify({ messages: [] });
      const openRequest = (): import("node:http").ClientRequest => {
        const request = httpRequest(`${isolatedBaseUrl}/v1/model/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${registeredBody.device_token}`,
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(requestBody)),
          },
        }, (response) => response.resume());
        request.once("error", () => undefined);
        request.end(requestBody);
        return request;
      };
      const waitForSignal = (signal: Promise<void>, timeoutMs: number): Promise<boolean> => Promise.race([
        signal.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
      ]);
      const waitForClose = (request: import("node:http").ClientRequest): Promise<void> =>
        request.closed ? Promise.resolve() : new Promise((resolve) => request.once("close", resolve));
      const destroyAndWaitForClose = (request: import("node:http").ClientRequest): Promise<void> => {
        const closed = waitForClose(request);
        request.destroy();
        return closed;
      };

      const firstRequest = openRequest();
      await expect(waitForSignal(firstResolverStarted, 1_000)).resolves.toBe(true);
      await destroyAndWaitForClose(firstRequest);

      const secondRequest = openRequest();
      await expect(Promise.race([
        secondResolverStarted.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
      ])).resolves.toBe(true);
      await destroyAndWaitForClose(secondRequest);

      const leaseReleaseDeadline = Date.now() + 1_000;
      let dnsFailure: Response;
      do {
        dnsFailure = await fetch(`${isolatedBaseUrl}/v1/model/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${registeredBody.device_token}`, "content-type": "application/json" },
          body: requestBody,
        });
        if (dnsFailure.status !== 429 || Date.now() >= leaseReleaseDeadline) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      } while (true);
      expect(dnsFailure.status).toBe(502);
      expect(await dnsFailure.json()).toMatchObject({ code: "MODEL_UPSTREAM_ERROR" });
      await new Promise((resolve) => setImmediate(resolve));

      expect(resolverCalls).toBe(3);
      expect(await isolatedStore.listModelUsage()).toEqual([]);
      expect((await isolatedStore.listModelRequestMetrics()).filter((row) =>
        row.outcome === "network_error" || row.outcome === "timeout"
      )).toEqual([]);
      expect((await isolatedStore.getDevice(registeredBody.device_id))?.last_error_code).toBeUndefined();
    } finally {
      firstRelease?.();
      secondRelease?.();
      isolatedCloud.close();
    }
  }, 10_000);

  it("设备最低版本门禁按 SemVer 处理预发布版本并对非法策略失败关闭", async () => {
    const headers = { authorization: "Bearer admin-test", "content-type": "application/json" };
    await store.updateDeviceVersion(deviceId, "1.0.0-alpha");
    expect((await fetch(`${baseUrl}/v1/admin/devices/${deviceId}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ min_required_version: "1.0.0" }),
    })).status).toBe(200);

    const hitsBeforePrerelease = upstreamRequestHits;
    expect((await fetch(`${baseUrl}/v1/model/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    })).status).toBe(426);
    expect(upstreamRequestHits).toBe(hitsBeforePrerelease);

    for (const invalidMinVersion of ["", 0, false, "zzz"] as const) {
      expect((await fetch(`${baseUrl}/v1/admin/devices/${deviceId}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ min_required_version: invalidMinVersion }),
      })).status).toBe(422);
    }
    await store.updateDeviceOperations(deviceId, { min_required_version: "" });
    const hitsBeforeStoredInvalid = upstreamRequestHits;
    expect((await fetch(`${baseUrl}/v1/client/runtime-config`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    })).status).toBe(426);
    expect((await fetch(`${baseUrl}/v1/model/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    })).status).toBe(426);
    expect(upstreamRequestHits).toBe(hitsBeforeStoredInvalid);

    await store.updateDeviceVersion(deviceId, "0.3.2");
    await store.updateDeviceOperations(deviceId, { min_required_version: "0.3.0" });
  });

  it("管理员可停用、分组和轮换设备凭据且全程留审计", async () => {
    const headers = { authorization: "Bearer admin-test", "content-type": "application/json" };
    const updated = await fetch(`${baseUrl}/v1/admin/devices/${deviceId}`, {
      method: "POST", headers, body: JSON.stringify({ rollout_group: "pilot-a", min_required_version: "0.3.0" }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ device: { rollout_group: "pilot-a", min_required_version: "0.3.0" } });
    const previousToken = deviceToken;
    const rotated = await fetch(`${baseUrl}/v1/admin/devices/${deviceId}/rotate-credential`, { method: "POST", headers, body: "{}" });
    expect(rotated.status).toBe(200);
    deviceToken = ((await rotated.json()) as { device_token: string }).device_token;
    expect(deviceToken).not.toBe(previousToken);
    expect((await fetch(`${baseUrl}/v1/client/runtime-config`, { headers: { authorization: `Bearer ${previousToken}` } })).status).toBe(401);
    expect((await fetch(`${baseUrl}/v1/client/runtime-config`, { headers: { authorization: `Bearer ${deviceToken}` } })).status).toBe(200);
    expect((await fetch(`${baseUrl}/v1/admin/devices/${deviceId}`, { method: "POST", headers, body: JSON.stringify({ status: "revoked" }) })).status).toBe(200);
    expect((await fetch(`${baseUrl}/v1/client/runtime-config`, { headers: { authorization: `Bearer ${deviceToken}` } })).status).toBe(401);
    expect((await fetch(`${baseUrl}/v1/admin/devices/${deviceId}`, { method: "POST", headers, body: JSON.stringify({ status: "active" }) })).status).toBe(200);
    const audits = await store.listAudits();
    expect(audits.some((audit) => audit.action === "device.credential.rotate")).toBe(true);
    expect(audits.filter((audit) => audit.action === "device.policy.update").length).toBeGreaterThanOrEqual(3);
  });

  it("无设备凭据不能调用模型代理", async () => {
    const response = await fetch(`${baseUrl}/v1/model/models`);
    expect(response.status).toBe(401);
  });
});
