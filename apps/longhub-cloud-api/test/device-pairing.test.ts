import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/memory-store.js";
import { createCloudApiServer } from "../src/server.js";

const servers: ReturnType<typeof createCloudApiServer>[] = [];

async function start(store = new MemoryStore()): Promise<{ baseUrl: string; store: MemoryStore }> {
  const server = createCloudApiServer({ executorUrl: "http://127.0.0.1:1", store });
  servers.push(server);
  server.listen(0);
  await once(server, "listening");
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, store };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    if (!server.listening) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

async function registerDevice(baseUrl: string, fingerprint: string) {
  const response = await fetch(`${baseUrl}/v1/devices/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      platform: "windows",
      app_version: "1.0.0",
      device_fingerprint: fingerprint,
    }),
  });
  expect(response.status).toBe(201);
  return await response.json() as { device_id: string; device_token: string };
}

async function registerUser(baseUrl: string, email: string) {
  const response = await fetch(`${baseUrl}/v1/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "pairing-password" }),
  });
  expect(response.status).toBe(201);
  return await response.json() as { token: string; user: { user_id: string } };
}

async function createChallenge(baseUrl: string, deviceToken: string) {
  const response = await fetch(`${baseUrl}/v1/devices/pairing/challenge`, {
    method: "POST",
    headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
    body: "{}",
  });
  expect(response.status).toBe(201);
  return await response.json() as {
    challenge_id: string;
    device_id: string;
    pairing_code: string;
    expires_at: string;
  };
}

describe("one-time Manager device pairing", () => {
  it("binds only after a registered Manager bearer mints a one-time code", async () => {
    const { baseUrl, store } = await start();
    const device = await registerDevice(baseUrl, "pairing-device-1");
    const challenge = await createChallenge(baseUrl, device.device_token);
    expect(challenge.device_id).toBe(device.device_id);
    expect(challenge.pairing_code).toMatch(/^[A-HJ-NP-Z2-9]{12}$/);

    const account = await registerUser(baseUrl, "pairing-1@example.test");
    const formatted = `${challenge.pairing_code.slice(0, 4)}-${challenge.pairing_code.slice(4, 8)}-${challenge.pairing_code.slice(8)}`;
    const paired = await fetch(`${baseUrl}/v1/me/devices/pair`, {
      method: "POST",
      headers: { authorization: `Bearer ${account.token}`, "content-type": "application/json" },
      body: JSON.stringify({ pairing_code: formatted.toLowerCase() }),
    });
    expect(paired.status).toBe(200);
    const pairedBody = await paired.json() as { device: Record<string, unknown> };
    expect(pairedBody.device.device_id).toBe(device.device_id);
    expect(pairedBody.device).not.toHaveProperty("device_token");
    expect(pairedBody.device).not.toHaveProperty("device_fingerprint");
    expect((await store.getDevice(device.device_id))?.user_id).toBe(account.user.user_id);

    const replay = await fetch(`${baseUrl}/v1/me/devices/pair`, {
      method: "POST",
      headers: { authorization: `Bearer ${account.token}`, "content-type": "application/json" },
      body: JSON.stringify({ pairing_code: challenge.pairing_code }),
    });
    expect(replay.status).toBe(422);
    expect((await replay.json() as { code: string }).code).toBe("PAIRING_CODE_INVALID");
  });

  it("invalidates the previous proof when Manager requests a replacement", async () => {
    const { baseUrl } = await start();
    const device = await registerDevice(baseUrl, "pairing-device-2");
    const first = await createChallenge(baseUrl, device.device_token);
    const second = await createChallenge(baseUrl, device.device_token);
    expect(second.pairing_code).not.toBe(first.pairing_code);
    const account = await registerUser(baseUrl, "pairing-2@example.test");

    const stale = await fetch(`${baseUrl}/v1/me/devices/pair`, {
      method: "POST",
      headers: { authorization: `Bearer ${account.token}`, "content-type": "application/json" },
      body: JSON.stringify({ pairing_code: first.pairing_code }),
    });
    expect(stale.status).toBe(422);

    const current = await fetch(`${baseUrl}/v1/me/devices/pair`, {
      method: "POST",
      headers: { authorization: `Bearer ${account.token}`, "content-type": "application/json" },
      body: JSON.stringify({ pairing_code: second.pairing_code }),
    });
    expect(current.status).toBe(200);
  });

  it("permanently rejects the retired UUID-only bind endpoint", async () => {
    const { baseUrl } = await start();
    const device = await registerDevice(baseUrl, "pairing-device-3");
    const account = await registerUser(baseUrl, "pairing-3@example.test");
    const response = await fetch(`${baseUrl}/v1/me/devices/bind`, {
      method: "POST",
      headers: { authorization: `Bearer ${account.token}`, "content-type": "application/json" },
      body: JSON.stringify({ device_id: device.device_id }),
    });
    expect(response.status).toBe(410);
    expect((await response.json() as { code: string }).code).toBe("PAIRING_CODE_REQUIRED");
  });

  it("rejects retired or unknown fields on the pairing endpoint", async () => {
    const { baseUrl } = await start();
    const account = await registerUser(baseUrl, "pairing-unknown@example.test");
    const response = await fetch(`${baseUrl}/v1/me/devices/pair`, {
      method: "POST",
      headers: { authorization: `Bearer ${account.token}`, "content-type": "application/json" },
      body: JSON.stringify({ pairing_code: "ABCD2345EFGH", device_id: "retired" }),
    });
    expect(response.status).toBe(422);
    expect((await response.json() as { code: string }).code).toBe("INVALID_PAIRING_REQUEST");
  });
});
