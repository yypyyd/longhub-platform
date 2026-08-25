import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createExecutorServer } from "longhub-executor";
import { MemoryStore } from "../src/memory-store.js";
import { createCloudApiServer } from "../src/server.js";

let executor: ReturnType<typeof createExecutorServer>;
let api: ReturnType<typeof createCloudApiServer>;
let baseUrl: string;
let deviceAToken: string;
let deviceBToken: string;
let managerToken: string;
const store = new MemoryStore();

beforeAll(async () => {
  executor = createExecutorServer().listen(0);
  await once(executor, "listening");
  api = createCloudApiServer({
    executorUrl: `http://127.0.0.1:${(executor.address() as AddressInfo).port}`,
    allowDevelopmentTasks: true,
    store,
  }).listen(0);
  await once(api, "listening");
  baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  const register = async (fingerprint: string, platform = "openclaw-plugin-windows") => {
    const response = await fetch(`${baseUrl}/v1/devices/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform, app_version: "1.0.0", device_fingerprint: fingerprint }),
    });
    return ((await response.json()) as { device_token: string }).device_token;
  };
  deviceAToken = await register("task-owner-a");
  deviceBToken = await register("task-owner-b");
  managerToken = await register("legacy-manager-device", "windows");
});

afterAll(() => {
  api.close();
  executor.close();
});

function headers(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...extra };
}

async function create(token: string, key: string, agentId?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/v1/tasks`, {
    method: "POST",
    headers: headers(token, { "content-type": "application/json", "idempotency-key": key }),
    body: JSON.stringify({
      kind: "skill.execute",
      ...(agentId ? { agent_id: agentId } : {}),
      input: { skillId: "longhub.skill.salary-band", level: 3 },
    }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("Cloud Task owner isolation", () => {
  it("rejects legacy Manager credentials without deleting the historical device", async () => {
    const createDenied = await create(managerToken, "legacy-manager-key", "agent-manager");
    expect(createDenied.status).toBe(403);
    expect(createDenied.body.code).toBe("CLOUD_PLUGIN_DEVICE_REQUIRED");

    const created = await create(deviceAToken, "plugin-only-task", "agent-a");
    const taskId = String(created.body.task_id);
    for (const response of [
      await fetch(`${baseUrl}/v1/tasks/${taskId}`, {
        headers: headers(managerToken, { "x-longhub-agent-id": "agent-a" }),
      }),
      await fetch(`${baseUrl}/v1/tasks/${taskId}/cancel`, {
        method: "POST",
        headers: headers(managerToken, { "x-longhub-agent-id": "agent-a" }),
      }),
      await fetch(`${baseUrl}/v1/tasks/${taskId}/events`, {
        headers: headers(managerToken, { "x-longhub-agent-id": "agent-a" }),
      }),
    ]) {
      expect(response.status).toBe(403);
      expect(((await response.json()) as { code: string }).code).toBe("CLOUD_PLUGIN_DEVICE_REQUIRED");
    }

    const self = await fetch(`${baseUrl}/v1/devices/self`, { headers: headers(managerToken) });
    expect(self.status).toBe(200);
    expect(((await self.json()) as { platform: string }).platform).toBe("windows");
    expect((await store.listAudits()).some((audit) =>
      audit.actor.startsWith("device:") && audit.action === "cloud_task.execution_denied"
    )).toBe(true);
  });

  it("persists tenant/device/agent owner and scopes idempotency by owner", async () => {
    const first = await create(deviceAToken, "owner-key", "agent-a");
    expect(first.status).toBe(201);
    expect(first.body.tenant_id).toBe("tenant-default");
    expect(typeof first.body.device_id).toBe("string");
    expect(first.body.agent_id).toBe("agent-a");

    const sameOwnerReplay = await create(deviceAToken, "owner-key", "agent-a");
    expect(sameOwnerReplay.status).toBe(200);
    expect(sameOwnerReplay.body.task_id).toBe(first.body.task_id);

    const otherDevice = await create(deviceBToken, "owner-key", "agent-a");
    expect(otherDevice.status).toBe(201);
    expect(otherDevice.body.task_id).not.toBe(first.body.task_id);
  });

  it("hides a foreign device task from get, cancel and SSE", async () => {
    const created = await create(deviceAToken, "owner-read-key", "agent-a");
    const taskId = String(created.body.task_id);
    const foreignGet = await fetch(`${baseUrl}/v1/tasks/${taskId}`, { headers: headers(deviceBToken) });
    expect(foreignGet.status).toBe(404);
    expect(((await foreignGet.json()) as { code: string }).code).toBe("TASK_NOT_FOUND");

    const foreignCancel = await fetch(`${baseUrl}/v1/tasks/${taskId}/cancel`, {
      method: "POST",
      headers: headers(deviceBToken),
    });
    expect(foreignCancel.status).toBe(404);

    const foreignEvents = await fetch(`${baseUrl}/v1/tasks/${taskId}/events`, { headers: headers(deviceBToken) });
    expect(foreignEvents.status).toBe(404);
  });

  it("binds task reads to the requested agent on the creating device", async () => {
    const created = await create(deviceAToken, "owner-agent-key", "agent-a");
    const taskId = String(created.body.task_id);
    const wrongAgent = await fetch(`${baseUrl}/v1/tasks/${taskId}`, {
      headers: headers(deviceAToken, { "x-longhub-agent-id": "agent-b" }),
    });
    expect(wrongAgent.status).toBe(404);
    const rightAgent = await fetch(`${baseUrl}/v1/tasks/${taskId}`, {
      headers: headers(deviceAToken, { "x-longhub-agent-id": "agent-a" }),
    });
    expect(rightAgent.status).toBe(200);
  });
});
