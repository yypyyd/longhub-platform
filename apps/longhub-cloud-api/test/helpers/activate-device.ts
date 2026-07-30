import { expect } from "vitest";

export async function activateTestDevice(
  baseUrl: string,
  adminToken: string,
  deviceToken: string,
  packIds: string[] = [],
): Promise<string> {
  const created = await fetch(`${baseUrl}/v1/admin/activation-codes`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({ label: "自动化测试", max_uses: 1, expires_in_days: 30, pack_ids: packIds }),
  });
  expect(created.status).toBe(201);
  const { code } = await created.json() as { code: string };
  const activated = await fetch(`${baseUrl}/v1/devices/activate`, {
    method: "POST",
    headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  expect(activated.status).toBe(200);
  return code;
}
