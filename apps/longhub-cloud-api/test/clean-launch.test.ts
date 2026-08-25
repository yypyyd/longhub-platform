import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CLIENT_TELEMETRY_SCHEMA } from "@longhub/observability";
import { MemoryStore } from "../src/memory-store.js";
import { createCloudApiServer } from "../src/server.js";

const ADMIN_TOKEN = "clean-launch-admin";
const openServers: ReturnType<typeof createCloudApiServer>[] = [];

async function listen(server: ReturnType<typeof createCloudApiServer>): Promise<string> {
  openServers.push(server);
  server.listen(0);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(async (server) => {
    if (!server.listening) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

async function register(baseUrl: string, fingerprint: string): Promise<{ device_id: string; device_token: string }> {
  const response = await fetch(`${baseUrl}/v1/devices/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform: "windows", app_version: "1.0.0", device_fingerprint: fingerprint }),
  });
  expect(response.status).toBe(201);
  return await response.json() as { device_id: string; device_token: string };
}

describe("Cloud API clean launch", () => {
  it("never returns the device bearer from ordinary MemoryStore lookups", async () => {
    const store = new MemoryStore();
    const registered = await store.registerDevice({
      tenant_id: "tenant-default",
      platform: "windows",
      app_version: "1.0.0",
      device_fingerprint: "memory-token-free",
    });
    const found = await store.findDeviceByToken(registered.device.device_token!);
    expect(found?.device_id).toBe(registered.device.device_id);
    expect(found).not.toHaveProperty("device_token");
    expect(await store.getDevice(registered.device.device_id)).not.toHaveProperty("device_token");
  });

  it("allows the current Manager and OpenClaw version headers in CORS preflight", async () => {
    const baseUrl = await listen(createCloudApiServer({
      executorUrl: "http://127.0.0.1:1",
      store: new MemoryStore(),
      adminToken: ADMIN_TOKEN,
    }));

    const response = await fetch(baseUrl + "/v1/client/feature-policy", {
      method: "OPTIONS",
      headers: {
        origin: "http://127.0.0.1:19527",
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-longhub-manager-version,x-longhub-openclaw-version",
      },
    });
    expect(response.status).toBe(204);
    const allowed = response.headers.get("access-control-allow-headers")?.split(/,\s*/u) ?? [];
    expect(allowed).toContain("x-longhub-manager-version");
    expect(allowed).toContain("x-longhub-openclaw-version");
  });

  it("disables legacy Pack/activation/admin surfaces while keeping Cloud Skill admin", async () => {
    const api = createCloudApiServer({
      executorUrl: "http://127.0.0.1:1",
      store: new MemoryStore(),
      adminToken: ADMIN_TOKEN,
    });
    const baseUrl = await listen(api);
    const device = await register(baseUrl, "clean-launch-device");
    const headers = { authorization: `Bearer ${device.device_token}` };

    for (const path of [
      "/v1/devices/activation",
      "/v1/catalog/packs",
      "/v1/packs/legacy/download",
      "/v1/entitlements",
      "/v1/client/runtime-config",
      "/v1/client/model-capabilities",
      "/v1/model/models",
      "/v1/model/chat/completions",
      "/v1/knowledge/query",
    ]) {
      const response = await fetch(baseUrl + path, { headers });
      expect(response.status, path).toBe(410);
      expect((await response.json() as { code: string }).code, path).toBe("LEGACY_SURFACE_DISABLED");
    }

    const adminLegacy = await fetch(baseUrl + "/v1/admin/products", {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(adminLegacy.status).toBe(410);
    expect((await adminLegacy.json() as { code: string }).code).toBe("LEGACY_SURFACE_DISABLED");

    const adminHeaders = { authorization: `Bearer ${ADMIN_TOKEN}` };
    for (const [method, path] of [
      ["GET", "/v1/admin/knowledge-documents"],
      ["POST", "/v1/admin/knowledge-documents"],
      ["DELETE", "/v1/admin/knowledge-documents/legacy-document"],
    ] as const) {
      const response = await fetch(baseUrl + path, {
        method,
        headers: method === "POST"
          ? { ...adminHeaders, "content-type": "application/json" }
          : adminHeaders,
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect(response.status, `${method} ${path}`).toBe(410);
      expect((await response.json() as { code: string }).code, `${method} ${path}`).toBe("LEGACY_SURFACE_DISABLED");
    }

    const adminCloud = await fetch(baseUrl + "/v1/admin/cloud-skill-plans", {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(adminCloud.status).toBe(200);
  });

  it("keeps retired model UI fields out of the clean-launch Admin contract", async () => {
    const store = new MemoryStore();
    const api = createCloudApiServer({
      executorUrl: "http://127.0.0.1:1",
      store,
      adminToken: ADMIN_TOKEN,
      modelEncryptionKey: Buffer.alloc(32, 7),
      allowInsecureModelUpstream: true,
      legacySurfaceEnabled: false,
    });
    const baseUrl = await listen(api);
    const headers = { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" };

    const initial = await fetch(baseUrl + "/v1/admin/model-config", { headers });
    expect(initial.status).toBe(200);
    const initialBody = await initial.json() as Record<string, unknown>;
    for (const field of ["assistant_name", "assistant_avatar_path", "welcome_message", "quick_tasks", "features"]) {
      expect(initialBody).not.toHaveProperty(field);
    }

    const routeFields = {
      base_url: "http://127.0.0.1:9",
      model_id: "executor-model",
      display_name: "Executor 模型",
      api_type: "openai-completions",
      enabled: false,
      api_key: "executor-test-key",
    };
    for (const field of [
      ["assistant_name", "旧客户端"],
      ["assistant_avatar_path", "/assets/legacy.png"],
      ["welcome_message", "旧欢迎语"],
      ["quick_tasks", ["旧任务"]],
      ["features", { agent_catalog: true }],
    ] as const) {
      const response = await fetch(baseUrl + "/v1/admin/model-config", {
        method: "POST",
        headers,
        body: JSON.stringify({ ...routeFields, [field[0]]: field[1] }),
      });
      expect(response.status, field[0]).toBe(422);
      expect((await response.json() as { code: string }).code, field[0]).toBe("LEGACY_MODEL_UI_FIELDS_DISABLED");
    }

    const saved = await fetch(baseUrl + "/v1/admin/model-config", {
      method: "POST",
      headers,
      body: JSON.stringify(routeFields),
    });
    expect(saved.status).toBe(200);
    const savedBody = await saved.json() as Record<string, unknown>;
    expect(savedBody.model_id).toBe("executor-model");
    expect(savedBody).not.toHaveProperty("assistant_name");
    expect((await store.getModelGatewayConfig("default"))?.model_id).toBe("executor-model");
  });

  it("rejects mock payment and permits telemetry for a registered, unactivated device", async () => {
    const store = new MemoryStore();
    const api = createCloudApiServer({
      executorUrl: "http://127.0.0.1:1",
      store,
      adminToken: ADMIN_TOKEN,
      legacySurfaceEnabled: false,
    });
    const baseUrl = await listen(api);
    const device = await register(baseUrl, "clean-launch-payment-device");

    const registered = await fetch(baseUrl + "/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "clean-launch@test.cn", password: "clean-launch-pass" }),
    });
    expect(registered.status).toBe(201);
    const account = await registered.json() as { token: string; user: { user_id: string } };
    const bind = await fetch(baseUrl + "/v1/me/devices/bind", {
      method: "POST",
      headers: { authorization: `Bearer ${account.token}`, "content-type": "application/json" },
      body: JSON.stringify({ device_id: device.device_id }),
    });
    expect(bind.status).toBe(410);
    expect((await bind.json() as { code: string }).code).toBe("PAIRING_CODE_REQUIRED");
    expect((await store.bindDevice(device.device_id, account.user.user_id))?.user_id)
      .toBe(account.user.user_id);

    // The first release has one commercial line. Historical order rows may
    // still exist in a development store, but they must never appear in the
    // clean Admin ledger or affect its revenue counters.
    const legacyOrder = await store.createOrder({
      user_id: account.user.user_id,
      type: "plan",
      product_id: "legacy-product",
      pack_id: "legacy-pack",
      period: "monthly",
      amount_fen: 9_900,
    });
    await store.updateOrder(legacyOrder.order_id, {
      status: "paid",
      pay_method: "mock",
      paid_at: new Date().toISOString(),
    });

    await store.createCloudSkillPlan({
      plan_id: "clean-launch-plan",
      name: "Clean launch plan",
      skill_ids: ["longhub.skill.clean-launch"],
      price_monthly_fen: 1,
      price_yearly_fen: 1,
    });
    const orderResponse = await fetch(baseUrl + "/v1/orders", {
      method: "POST",
      headers: { authorization: `Bearer ${account.token}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "cloud_skill_plan", plan_id: "clean-launch-plan", period: "monthly" }),
    });
    expect(orderResponse.status).toBe(201);
    const order = await orderResponse.json() as { order_id: string };
    await store.updateOrder(order.order_id, {
      status: "paid",
      paid_at: new Date().toISOString(),
    });

    const adminHeaders = { authorization: `Bearer ${ADMIN_TOKEN}` };
    const adminUsers = await fetch(baseUrl + "/v1/admin/users", { headers: adminHeaders });
    expect(adminUsers.status).toBe(200);
    const userRows = (await adminUsers.json() as { users: Array<Record<string, unknown>> }).users;
    expect(userRows).toHaveLength(1);
    expect(userRows[0]).not.toHaveProperty("balance_fen");

    const adminDevices = await fetch(baseUrl + "/v1/admin/devices", { headers: adminHeaders });
    expect(adminDevices.status).toBe(200);
    const deviceRows = (await adminDevices.json() as { devices: Array<Record<string, unknown>> }).devices;
    expect(deviceRows).toHaveLength(1);
    expect(deviceRows[0]).not.toHaveProperty("activation_code_id");
    expect(deviceRows[0]).not.toHaveProperty("activated_at");

    const adminOrders = await fetch(baseUrl + "/v1/admin/orders", { headers: adminHeaders });
    expect(adminOrders.status).toBe(200);
    const visibleOrders = (await adminOrders.json() as { orders: Array<{ order_id: string; type: string }> }).orders;
    expect(visibleOrders.map(({ order_id, type }) => ({ order_id, type }))).toEqual([
      { order_id: order.order_id, type: "cloud_skill_plan" },
    ]);

    const metrics = await fetch(baseUrl + "/v1/admin/metrics", { headers: adminHeaders });
    expect(metrics.status).toBe(200);
    expect(await metrics.json()).toMatchObject({
      orders_paid_total: 1,
      revenue_fen: 1,
    });

    const refund = await fetch(`${baseUrl}/v1/admin/orders/${order.order_id}/refund`, {
      method: "POST",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: "{}",
    });
    expect(refund.status).toBe(503);
    expect((await refund.json() as { code: string }).code).toBe("PAYMENT_NOT_CONFIGURED");

    const payment = await fetch(`${baseUrl}/v1/orders/${order.order_id}/pay`, {
      method: "POST",
      headers: { authorization: `Bearer ${account.token}`, "content-type": "application/json" },
      body: JSON.stringify({ method: "mock" }),
    });
    expect(payment.status).toBe(503);
    expect((await payment.json() as { code: string }).code).toBe("PAYMENT_NOT_CONFIGURED");

    const telemetry = await fetch(baseUrl + "/v1/client/telemetry", {
      method: "POST",
      headers: { authorization: `Bearer ${device.device_token}`, "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: CLIENT_TELEMETRY_SCHEMA,
        events: [{
          event_type: "gateway_state",
          occurred_at: new Date().toISOString(),
          manager_version: "1.0.0",
          openclaw_version: "2026.7.1",
          platform: "win32",
          architecture: "x64",
          fields: { state: "running" },
        }],
      }),
    });
    expect(telemetry.status).toBe(202);
  });
});
