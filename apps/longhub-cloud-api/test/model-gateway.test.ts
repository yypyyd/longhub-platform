import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCloudApiServer } from "../src/server.js";
import { MemoryStore } from "../src/memory-store.js";
import type { ModelRequestAggregateRecord } from "../src/store.js";
import { activateTestDevice } from "./helpers/activate-device.js";
import {
  decryptModelApiKey,
  encryptModelApiKey,
  normalizeUpstreamBaseUrl,
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
let upstreamMode: "success" | "rejected" | "slow" = "success";
const encryptionKey = Buffer.alloc(32, 7);
class ModelMetricStore extends MemoryStore {
  failMetrics = false;

  override async incrementModelRequestMetrics(records: readonly ModelRequestAggregateRecord[]): Promise<void> {
    if (this.failMetrics) throw new Error("metrics unavailable");
    return super.incrementModelRequestMetrics(records);
  }
}
const store = new ModelMetricStore();

beforeAll(async () => {
  upstream = createServer((req, res) => {
    void (async () => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [] }));
        return;
      }
      if (upstreamMode === "slow") {
        setTimeout(() => {
          if (!res.destroyed) res.end(JSON.stringify({ choices: [] }));
        }, 250);
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      receivedModel = (JSON.parse(body) as { model: string }).model;
      receivedAuthorization = String(req.headers.authorization ?? "");
      res.writeHead(upstreamMode === "rejected" ? 429 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "chat-1", object: "chat.completion", model: receivedModel, choices: [] }));
    })();
  }).listen(0);
  await once(upstream, "listening");
  upstreamBaseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;

  cloud = createCloudApiServer({
    executorUrl: "http://127.0.0.1:1",
    adminToken: "admin-test",
    modelEncryptionKey: encryptionKey,
    allowInsecureModelUpstream: true,
    modelProxyTimeoutMs: 50,
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
      body: JSON.stringify({ enabled: true, base_url: upstreamBaseUrl, model_id: "real-model", display_name: "龙枢模型", api_type: "openai-completions", context_window: 64_000, max_tokens: 4_096, api_key: "sk-upstream-secret" }),
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

    expect((await savePolicy({ config_id: "device-test-policy", min_desktop_version: "9.0.0" })).status).toBe(200);
    expect((await fetch(`${baseUrl}/v1/client/runtime-config`, { headers: { authorization: `Bearer ${deviceToken}` } })).status).toBe(426);
    expect((await savePolicy({ config_id: "device-test-policy", min_desktop_version: "0.0.0", emergency_disabled: true })).status).toBe(200);
    expect((await fetch(`${baseUrl}/v1/client/runtime-config`, { headers: { authorization: `Bearer ${deviceToken}` } })).status).toBe(503);
    expect((await savePolicy({ config_id: "device-test-policy", emergency_disabled: false })).status).toBe(200);
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
