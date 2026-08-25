import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/memory-store.js";
import { createCloudApiServer } from "../src/server.js";

const store = new MemoryStore();
let server: ReturnType<typeof createCloudApiServer>;
let baseUrl: string;

beforeAll(async () => {
  server = createCloudApiServer({ executorUrl: "http://127.0.0.1:1", store }).listen(0);
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

describe("standalone Cloud Plugin device lifecycle", () => {
  it("accepts only the reviewed plugin platform and revokes its own bearer", async () => {
    const invalid = await fetch(`${baseUrl}/v1/devices/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "openclaw-plugin-linux", app_version: "0.1.0", device_fingerprint: "plugin-linux" }),
    });
    expect(invalid.status).toBe(422);

    const registered = await fetch(`${baseUrl}/v1/devices/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        platform: "openclaw-plugin-windows",
        app_version: "0.1.0",
        device_fingerprint: "plugin-windows-device",
        display_name: "Cloud Plugin",
      }),
    });
    expect(registered.status).toBe(201);
    const credentials = await registered.json() as { device_id: string; device_token: string };
    const headers = { authorization: `Bearer ${credentials.device_token}` };
    const self = await fetch(`${baseUrl}/v1/devices/self`, { headers });
    expect(self.status).toBe(200);
    const selfBody = await self.json();
    expect(selfBody).toMatchObject({
      device_id: credentials.device_id,
      platform: "openclaw-plugin-windows",
      app_version: "0.1.0",
      status: "active",
      bound: false,
    });
    expect(JSON.stringify(selfBody)).not.toContain(credentials.device_token);

    const revoked = await fetch(`${baseUrl}/v1/devices/self/revoke`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: "{}",
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ device_id: credentials.device_id, status: "revoked" });
    expect((await fetch(`${baseUrl}/v1/devices/self`, { headers })).status).toBe(401);
    expect((await store.listAudits()).map((audit) => audit.action)).toContain("device.revoked");
  });
});
