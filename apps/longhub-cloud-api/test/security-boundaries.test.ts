import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  hashPassword,
  hashSessionToken,
  newToken,
  sessionExpiry,
  verifyPassword,
} from "../src/auth.js";
import { MemoryStore } from "../src/memory-store.js";
import { createCloudApiServer } from "../src/server.js";

const openServers: ReturnType<typeof createCloudApiServer>[] = [];

async function start(options: Parameters<typeof createCloudApiServer>[0] = {}): Promise<{ server: ReturnType<typeof createCloudApiServer>; baseUrl: string }> {
  const server = createCloudApiServer({ executorUrl: "http://127.0.0.1:1", ...options }).listen(0);
  openServers.push(server);
  await once(server, "listening");
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(async (server) => {
    if (!server.listening) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

describe("首发安全边界", () => {
  it("hashes passwords asynchronously and derives non-bearer session identifiers", async () => {
    const passwordHash = await hashPassword("high-entropy-password");
    expect(await verifyPassword("high-entropy-password", passwordHash)).toBe(true);
    expect(await verifyPassword("wrong-password", passwordHash)).toBe(false);
    const token = newToken("us");
    const digest = hashSessionToken(token);
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(digest).not.toContain(token);
    expect(await verifyPassword("high-entropy-password", `scrypt:${"0".repeat(32)}:${"0".repeat(127)}`)).toBe(false);
    expect(await verifyPassword("high-entropy-password", `${passwordHash}:unexpected`)).toBe(false);
  });

  it("重复设备指纹不回显已有 bearer token", async () => {
    const { baseUrl } = await start();
    const body = JSON.stringify({ platform: "windows", app_version: "1.0.0", device_fingerprint: "same-fp" });
    const first = await fetch(`${baseUrl}/v1/devices/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json() as { device_token: string };
    const duplicate = await fetch(`${baseUrl}/v1/devices/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(duplicate.status).toBe(409);
    const duplicateBody = await duplicate.json() as Record<string, unknown>;
    expect(duplicateBody.code).toBe("DEVICE_ALREADY_REGISTERED");
    expect(duplicateBody).not.toHaveProperty("device_token");
    expect(JSON.stringify(duplicateBody)).not.toContain(firstBody.device_token);
  });

  it("JSON routes require a JSON content type and reject oversized registration bodies", async () => {
    const { baseUrl } = await start();
    const missingType = await fetch(`${baseUrl}/v1/devices/register`, {
      method: "POST",
      body: JSON.stringify({ platform: "windows", app_version: "1.0.0", device_fingerprint: "type-fp" }),
    });
    expect(missingType.status).toBe(415);
    expect((await missingType.json() as { code: string }).code).toBe("UNSUPPORTED_MEDIA_TYPE");

    const oversized = await fetch(`${baseUrl}/v1/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "large@example.test", password: "password-123", padding: "x".repeat(1 << 20) }),
    });
    expect(oversized.status).toBe(413);
    expect((await oversized.json() as { code: string }).code).toBe("BODY_TOO_LARGE");
  });

  it.each([null, [], ["array"], "string", 42, true])(
    "rejects non-object JSON request bodies: %j",
    async (body) => {
      const { baseUrl } = await start();
      const response = await fetch(`${baseUrl}/v1/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect((await response.json() as { code: string }).code).toBe("INVALID_JSON");
    },
  );

  it("bounds account identifiers before storage lookups or password work", async () => {
    const { baseUrl } = await start();
    const oversizedEmail = `${"a".repeat(243)}@example.test`;
    const register = await fetch(`${baseUrl}/v1/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: oversizedEmail, password: "password-123" }),
    });
    expect(register.status).toBe(422);
    expect((await register.json() as { code: string }).code).toBe("INVALID_EMAIL");

    const login = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: oversizedEmail, password: "password-123" }),
    });
    expect(login.status).toBe(401);
    expect((await login.json() as { code: string }).code).toBe("BAD_CREDENTIALS");

    const adminLogin = await fetch(`${baseUrl}/v1/admin/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "a".repeat(129), password: "password-123" }),
    });
    expect(adminLogin.status).toBe(401);
    expect((await adminLogin.json() as { code: string }).code).toBe("BAD_CREDENTIALS");
  });

  it("does not let an unauthenticated registration choose a tenant or add fields", async () => {
    const { baseUrl } = await start();
    const response = await fetch(`${baseUrl}/v1/devices/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        platform: "windows",
        app_version: "1.0.0",
        device_fingerprint: "tenant-spoof-fp",
        tenant_id: "attacker-tenant",
      }),
    });
    expect(response.status).toBe(422);
    expect((await response.json() as { code: string }).code).toBe("INVALID_DEVICE");
  });

  it("account device bind fails closed until one-time pairing proof exists", async () => {
    const store = new MemoryStore();
    const { baseUrl } = await start({ store });
    const registered = await fetch(`${baseUrl}/v1/devices/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "windows", app_version: "1.0.0", device_fingerprint: "pair-fp" }),
    });
    const device = await registered.json() as { device_id: string };
    const user = (await store.createUser({ email: "pair@example.test", password_hash: "unused" })).user;
    const sessionToken = newToken("us");
    await store.createSession({ subject_type: "user", subject_id: user.user_id, token: sessionToken, expires_at: sessionExpiry() });
    const response = await fetch(`${baseUrl}/v1/me/devices/bind`, {
      method: "POST",
      headers: { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" },
      body: JSON.stringify({ device_id: device.device_id }),
    });
    expect(response.status).toBe(410);
    expect((await response.json() as { code: string }).code).toBe("PAIRING_CODE_REQUIRED");
    expect((await store.getDevice(device.device_id))?.user_id).toBeUndefined();
  });

  it("production mode rejects missing or weak static admin credentials", () => {
    expect(() => createCloudApiServer({
      executorUrl: "http://127.0.0.1:1",
      productionMode: true,
    })).toThrow(/ADMIN_TOKEN/);
    expect(() => createCloudApiServer({
      executorUrl: "http://127.0.0.1:1",
      productionMode: true,
      adminToken: "a".repeat(32),
    })).toThrow(/ADMIN_TOKEN/);
    expect(() => createCloudApiServer({
      executorUrl: "http://127.0.0.1:1",
      productionMode: true,
      adminToken: "CHANGE_ME_HIGH_ENTROPY_ADMIN_TOKEN",
    })).toThrow(/ADMIN_TOKEN/);
  });

  it("production CORS only exposes configured origins", async () => {
    const { baseUrl } = await start({ corsAllowedOrigins: ["https://portal.example"] });
    const allowed = await fetch(`${baseUrl}/v1/health`, {
      method: "OPTIONS",
      headers: { origin: "https://portal.example", "access-control-request-method": "GET" },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://portal.example");
    const denied = await fetch(`${baseUrl}/v1/health`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "GET" },
    });
    expect(denied.status).toBe(403);
    expect((await denied.json() as { code: string }).code).toBe("ORIGIN_NOT_ALLOWED");
  });
});
