import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createCloudApiServer } from "../src/server.js";

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(async (server) => {
    if (!server.listening) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

async function listen(server: Server): Promise<string> {
  openServers.push(server);
  server.listen(0);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function createDevelopmentTask(baseUrl: string, key: string): Promise<{ taskId: string; deviceToken: string }> {
  const registered = await fetch(`${baseUrl}/v1/devices/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      platform: "openclaw-plugin-windows",
      app_version: "1.0.0",
      device_fingerprint: `executor-boundary-${key}`,
    }),
  });
  expect(registered.status).toBe(201);
  const device = await registered.json() as { device_token: string };
  const created = await fetch(`${baseUrl}/v1/tasks`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${device.device_token}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify({
      kind: "skill.execute",
      input: { skill_id: "longhub.skill.salary-band", level: 3 },
    }),
  });
  expect(created.status).toBe(201);
  return {
    taskId: (await created.json() as { task_id: string }).task_id,
    deviceToken: device.device_token,
  };
}

async function waitForTerminal(baseUrl: string, taskId: string, deviceToken: string): Promise<any> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await fetch(`${baseUrl}/v1/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    const detail = await response.json() as any;
    if (["failed", "timed_out", "succeeded", "cancelled"].includes(detail.status)) return detail;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("task did not reach a terminal state");
}

describe("Cloud API → Executor response boundary", () => {
  it("keeps the request deadline active while the upstream body is stalled", async () => {
    const executorUrl = await listen(createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"output":');
      // The Cloud API must abort this connection before the delayed end.
      setTimeout(() => res.end("{}"), 2_000);
    }));
    const apiUrl = await listen(createCloudApiServer({
      executorUrl,
      allowDevelopmentTasks: true,
      executorRequestTimeoutMs: 80,
    }));
    const task = await createDevelopmentTask(apiUrl, "boundary-timeout-key");
    const detail = await waitForTerminal(apiUrl, task.taskId, task.deviceToken);
    expect(detail).toMatchObject({ status: "timed_out", error: { code: "EXECUTION_TIMEOUT" } });
  }, 5_000);

  it("rejects an oversized streamed response before buffering it", async () => {
    const executorUrl = await listen(createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"output":"1234567890');
      res.end('"}');
    }));
    const apiUrl = await listen(createCloudApiServer({
      executorUrl,
      allowDevelopmentTasks: true,
      executorRequestTimeoutMs: 1_000,
      executorResponseMaxBytes: 16,
    }));
    const task = await createDevelopmentTask(apiUrl, "boundary-size-key");
    const detail = await waitForTerminal(apiUrl, task.taskId, task.deviceToken);
    expect(detail).toMatchObject({ status: "failed", error: { code: "EXECUTOR_INVALID_RESPONSE" } });
  }, 5_000);
});
