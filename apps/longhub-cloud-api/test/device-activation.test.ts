import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCloudApiServer } from "../src/server.js";
import { generateActivationCode, hashActivationCode, normalizeActivationCode } from "../src/activation-code.js";

const ADMIN_TOKEN = "activation-admin";
let server: ReturnType<typeof createCloudApiServer>;
let baseUrl = "";

async function json(path: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, init);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function register(fingerprint: string): Promise<{ device_id: string; device_token: string }> {
  const response = await json("/v1/devices/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform: "windows", app_version: "0.3.7", device_fingerprint: fingerprint }),
  });
  expect(response.status).toBe(201);
  return response.body as unknown as { device_id: string; device_token: string };
}

async function createCode(options: { maxUses?: number; packIds?: string[] } = {}): Promise<string> {
  const response = await json("/v1/admin/activation-codes", {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      label: "测试授权",
      max_uses: options.maxUses ?? 1,
      expires_in_days: 30,
      pack_ids: options.packIds ?? [],
    }),
  });
  expect(response.status).toBe(201);
  expect(response.body).not.toHaveProperty("code_hash");
  expect(response.body.activation_code).not.toHaveProperty("code_hash");
  return response.body.code as string;
}

beforeEach(async () => {
  server = createCloudApiServer({ executorUrl: "http://127.0.0.1:1", adminToken: ADMIN_TOKEN });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

describe("设备首次授权码激活", () => {
  it("未激活设备不能获取模型配置，核销后可用且授权码明文不再返回", async () => {
    const device = await register("activation-device-1");
    const headers = { authorization: `Bearer ${device.device_token}` };
    expect((await json("/v1/devices/activation", { headers })).body).toMatchObject({
      device_id: device.device_id,
      activated: false,
      reason: "ACTIVATION_REQUIRED",
    });
    expect(await json("/v1/client/runtime-config", { headers })).toMatchObject({
      status: 403,
      body: { code: "ACTIVATION_REQUIRED" },
    });

    const code = await createCode({ packIds: ["longhub.hr-suite"] });
    expect((await json("/v1/devices/activate", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ code: code.toLowerCase() }),
    })).body).toMatchObject({ device_id: device.device_id, activated: true });
    expect((await json("/v1/devices/activation", { headers })).body).toMatchObject({
      device_id: device.device_id,
      activated: true,
    });
    expect((await json("/v1/client/runtime-config", { headers })).body).toMatchObject({
      schema_version: "longhub/runtime-config/v1",
      model_id: "longhub-default",
      allow_user_model_selection: false,
    });
    expect((await json("/v1/entitlements", { headers })).body).toMatchObject({
      entitlements: [expect.objectContaining({ pack_id: "longhub.hr-suite", status: "active" })],
    });

    const listed = await json("/v1/admin/activation-codes", {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(JSON.stringify(listed.body)).not.toContain(code);
    expect(JSON.stringify(listed.body)).not.toContain(hashActivationCode(code));
  });

  it("限制使用次数，并在撤销授权码后立即阻断已激活设备", async () => {
    const first = await register("activation-device-a");
    const second = await register("activation-device-b");
    const code = await createCode({ maxUses: 1 });
    const auth = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
    const activated = await json("/v1/devices/activate", {
      method: "POST", headers: auth(first.device_token), body: JSON.stringify({ code }),
    });
    const activationId = (activated.body.activation_code as { activation_code_id: string }).activation_code_id;
    expect(activated.status).toBe(200);
    expect((await json("/v1/devices/activate", {
      method: "POST", headers: auth(second.device_token), body: JSON.stringify({ code }),
    })).status).toBe(403);

    expect((await json(`/v1/admin/activation-codes/${activationId}/revoke`, {
      method: "POST", headers: auth(ADMIN_TOKEN), body: "{}",
    })).status).toBe(200);
    expect(await json("/v1/client/runtime-config", {
      headers: { authorization: `Bearer ${first.device_token}` },
    })).toMatchObject({ status: 403, body: { code: "ACTIVATION_REVOKED" } });
  });

  it("生成 128 位随机授权码并严格规范化", () => {
    const first = generateActivationCode();
    const second = generateActivationCode();
    expect(first.code).toMatch(/^LH-(?:[A-F0-9]{4}-){3}[A-F0-9]{4}$/);
    expect(first.code).not.toBe(second.code);
    expect(normalizeActivationCode(first.code.toLowerCase())).toBe(first.code.replaceAll("-", ""));
    expect(hashActivationCode(first.code)).toHaveLength(64);
  });

  it("换码时撤销旧授权码附带的智能体权限，不继承已失效套餐", async () => {
    const device = await register("activation-device-renew");
    const headers = { authorization: `Bearer ${device.device_token}`, "content-type": "application/json" };
    const firstCode = await createCode({ packIds: ["longhub.hr-suite"] });
    const first = await json("/v1/devices/activate", {
      method: "POST", headers, body: JSON.stringify({ code: firstCode }),
    });
    const firstId = (first.body.activation_code as { activation_code_id: string }).activation_code_id;
    await json(`/v1/admin/activation-codes/${firstId}/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: "{}",
    });
    const replacement = await createCode();
    expect((await json("/v1/devices/activate", {
      method: "POST", headers, body: JSON.stringify({ code: replacement }),
    })).status).toBe(200);
    const entitlements = (await json("/v1/entitlements", { headers })).body.entitlements as Array<{
      pack_id: string;
      status: string;
    }>;
    expect(entitlements.some((item) => item.pack_id === "longhub.hr-suite" && item.status === "active")).toBe(false);
  });
});
