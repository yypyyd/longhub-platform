import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLIENT_TELEMETRY_MAX_BYTES, CLIENT_TELEMETRY_SCHEMA } from "@longhub/observability";
import { createCloudApiServer } from "../src/server.js";
import { MemoryStore } from "../src/memory-store.js";

const store = new MemoryStore();
let api: ReturnType<typeof createCloudApiServer>;
let baseUrl: string;
let deviceToken: string;

beforeAll(async () => {
  api = createCloudApiServer({ executorUrl: "http://127.0.0.1:1", store }).listen(0);
  await once(api, "listening");
  baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  deviceToken = await register("telemetry-active");
});

afterAll(() => api.close());

async function register(fingerprint: string): Promise<string> {
  const response = await fetch(`${baseUrl}/v1/devices/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform: "windows", app_version: "0.4.0", device_fingerprint: fingerprint }),
  });
  return ((await response.json()) as { device_token: string }).device_token;
}

function event(eventType: "client_started" | "gateway_state" = "client_started") {
  const common = {
    event_type: eventType,
    occurred_at: new Date().toISOString(),
    manager_version: "0.4.0",
    openclaw_version: "2026.7.1-2",
    platform: "win32",
    architecture: "x64",
  };
  return eventType === "client_started"
    ? { ...common, fields: { startup_duration: "5_to_15s", active_agent_count: "2_to_5" } }
    : { ...common, fields: { state: "running" } };
}

function submit(token: string | undefined, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/v1/client/telemetry`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /v1/client/telemetry", () => {
  it("只接受已注册设备，并把身份留在聚合存储之外", async () => {
    expect((await submit(undefined, { schema_version: CLIENT_TELEMETRY_SCHEMA, events: [event()] })).status).toBe(401);
    const unactivated = await register("telemetry-unactivated");
    expect((await submit(unactivated, { schema_version: CLIENT_TELEMETRY_SCHEMA, events: [event()] })).status).toBe(202);

    const response = await submit(deviceToken, {
      schema_version: CLIENT_TELEMETRY_SCHEMA,
      events: [event(), event("gateway_state"), {
        event_type: "previous_exit",
        occurred_at: new Date().toISOString(),
        manager_version: "0.4.0",
        openclaw_version: "2026.7.1-2",
        platform: "win32",
        architecture: "x64",
        fields: { result: "unclean" },
      }],
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 3 });
    const rows = await store.listClientTelemetry();
    expect(rows).toHaveLength(3);
    // The earlier registered-device probe uses the same aggregate dimensions,
    // so its accepted event is intentionally folded into the hourly counter.
    expect(rows.map((row) => row.count).sort((a, b) => a - b)).toEqual([1, 1, 2]);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("device_");
    expect(serialized).not.toContain("user_");
    expect(serialized).not.toContain("tenant_");
    expect(serialized).not.toContain(deviceToken);
  });

  it.each([
    ["设备 ID", { device_id: "dev-private" }],
    ["用户 ID", { user_id: "usr-private" }],
    ["自由文本", { prompt: "完整聊天内容" }],
    ["URL", { url: "https://private.example/chat" }],
  ])("拒绝%s等非契约字段", async (_label, extra) => {
    expect((await submit(deviceToken, {
      schema_version: CLIENT_TELEMETRY_SCHEMA,
      events: [{ ...event(), ...extra }],
    })).status).toBe(422);
  });

  it("拒绝超大批次，且同维度事件只累加聚合计数", async () => {
    const oversized = JSON.stringify({ padding: "x".repeat(CLIENT_TELEMETRY_MAX_BYTES) });
    expect((await submit(deviceToken, oversized)).status).toBe(413);

    const shared = event("gateway_state");
    expect((await submit(deviceToken, { schema_version: CLIENT_TELEMETRY_SCHEMA, events: [shared, shared] })).status).toBe(202);
    const running = (await store.listClientTelemetry()).find((row) => row.event_type === "gateway_state");
    expect(running?.count).toBe(3);
  });

  it("按设备凭据限制批次频率", async () => {
    const limitedToken = await register("telemetry-rate-limit");
    const batch = { schema_version: CLIENT_TELEMETRY_SCHEMA, events: [event()] };
    for (let index = 0; index < 120; index += 1) {
      expect((await submit(limitedToken, batch)).status).toBe(202);
    }
    const limited = await submit(limitedToken, batch);
    expect(limited.status).toBe(429);
    expect((await limited.json() as { code: string }).code).toBe("TELEMETRY_RATE_LIMITED");
  });
});
