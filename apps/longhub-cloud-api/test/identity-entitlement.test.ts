/** Identity（设备注册/凭据）与 Entitlement（授予/查询/撤销）模块测试。 */
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCloudApiServer } from "../src/server.js";
import { activateTestDevice } from "./helpers/activate-device.js";

const ADMIN_TOKEN = "test-admin-token";

let api: ReturnType<typeof createCloudApiServer>;
let baseUrl: string;

beforeAll(async () => {
  api = createCloudApiServer({ executorUrl: "http://127.0.0.1:9", adminToken: ADMIN_TOKEN }).listen(0);
  await once(api, "listening");
  baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

afterAll(() => {
  api.close();
});

async function register(fingerprint: string): Promise<{
  status: number;
  device: { device_id: string; device_token: string; status: string; tenant_id: string };
}> {
  const res = await fetch(`${baseUrl}/v1/devices/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform: "windows", app_version: "1.0.0", device_fingerprint: fingerprint }),
  });
  return { status: res.status, device: (await res.json()) as never };
}

describe("Identity：设备注册与凭据", () => {
  it("注册设备返回 201 并颁发设备凭据；同指纹重注册返回同一设备（200）", async () => {
    const first = await register("fp-1");
    expect(first.status).toBe(201);
    expect(first.device.device_id).toMatch(/^dev-/);
    expect(first.device.device_token).toMatch(/^dt-/);
    expect(first.device.status).toBe("active");

    const again = await register("fp-1");
    expect(again.status).toBe(200);
    expect(again.device.device_id).toBe(first.device.device_id);
  });

  it("拒绝非法注册请求（422）", async () => {
    const res = await fetch(`${baseUrl}/v1/devices/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "linux", app_version: "1.0.0", device_fingerprint: "fp-x" }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("INVALID_DEVICE");
  });

  it("无效设备凭据访问受保护接口返回 401", async () => {
    const res = await fetch(`${baseUrl}/v1/entitlements`, {
      headers: { authorization: "Bearer dt-bogus" },
    });
    expect(res.status).toBe(401);
  });
});

describe("Entitlement：授予/查询/撤销", () => {
  it("管理面授予授权→设备可查询→撤销后状态变 revoked", async () => {
    const { device } = await register("fp-ent");
    await activateTestDevice(baseUrl, ADMIN_TOKEN, device.device_token);

    // 非管理凭据不能授予
    const denied = await fetch(`${baseUrl}/v1/admin/entitlements`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${device.device_token}` },
      body: JSON.stringify({ device_id: device.device_id, pack_id: "longhub.hr-suite" }),
    });
    expect(denied.status).toBe(401);

    const granted = await fetch(`${baseUrl}/v1/admin/entitlements`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ device_id: device.device_id, pack_id: "longhub.hr-suite" }),
    });
    expect(granted.status).toBe(201);
    const entitlement = (await granted.json()) as { entitlement_id: string; status: string; pack_id: string };
    expect(entitlement.status).toBe("active");
    expect(entitlement.pack_id).toBe("longhub.hr-suite");

    const listed = await fetch(`${baseUrl}/v1/entitlements`, {
      headers: { authorization: `Bearer ${device.device_token}` },
    });
    expect(listed.status).toBe(200);
    const { entitlements } = (await listed.json()) as { entitlements: { entitlement_id: string; status: string }[] };
    expect(entitlements).toHaveLength(1);
    expect(entitlements[0]!.entitlement_id).toBe(entitlement.entitlement_id);

    const revoked = await fetch(`${baseUrl}/v1/admin/entitlements/${entitlement.entitlement_id}/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(revoked.status).toBe(202);

    const after = await fetch(`${baseUrl}/v1/entitlements`, {
      headers: { authorization: `Bearer ${device.device_token}` },
    });
    const afterList = (await after.json()) as { entitlements: { status: string }[] };
    expect(afterList.entitlements[0]!.status).toBe("revoked");
  });

  it("给未知设备授权返回 404", async () => {
    const res = await fetch(`${baseUrl}/v1/admin/entitlements`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ device_id: "dev-none", pack_id: "p" }),
    });
    expect(res.status).toBe(404);
  });
});
