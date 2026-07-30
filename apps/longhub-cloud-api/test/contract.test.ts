/**
 * 端云契约测试：以 contracts/openapi/longhub-cloud-v1.yaml 为准，
 * 校验任务模块实现与冻结契约一致（路径、幂等/断线恢复参数、状态码、统一错误结构）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createExecutorServer } from "longhub-executor";
import { createCloudApiServer } from "../src/server.js";
import { activateTestDevice } from "./helpers/activate-device.js";

const spec = readFileSync(
  fileURLToPath(new URL("../../../contracts/openapi/longhub-cloud-v1.yaml", import.meta.url)),
  "utf-8",
);

let executor: ReturnType<typeof createExecutorServer>;
let api: ReturnType<typeof createCloudApiServer>;
let baseUrl: string;
let deviceToken: string;

beforeAll(async () => {
  executor = createExecutorServer().listen(0);
  await once(executor, "listening");
  api = createCloudApiServer({
    executorUrl: `http://127.0.0.1:${(executor.address() as AddressInfo).port}`,
  }).listen(0);
  await once(api, "listening");
  baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  const registered = await fetch(`${baseUrl}/v1/devices/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      platform: "windows",
      app_version: "1.0.0",
      device_fingerprint: "fp-contract-test",
    }),
  });
  deviceToken = ((await registered.json()) as { device_token: string }).device_token;
  await activateTestDevice(baseUrl, "longhub-dev-admin", deviceToken);
});

afterAll(() => {
  api.close();
  executor.close();
});

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { authorization: `Bearer ${deviceToken}`, ...extra };
}

describe("OpenAPI V1 契约文档", () => {
  it("冻结的任务模块路径全部存在", () => {
    for (const path of ["/tasks:", "/tasks/{taskId}:", "/tasks/{taskId}/cancel:", "/tasks/{taskId}/events:"]) {
      expect(spec).toContain(`  ${path}`);
    }
  });

  it("Identity 与 Entitlement 路径存在", () => {
    for (const path of ["/devices/register:", "/entitlements:"]) {
      expect(spec).toContain(`  ${path}`);
    }
  });

  it("Release/Artifact 分发路径存在", () => {
    for (const path of [
      "/packs/signing-key:",
      "/packs/{packId}/download:",
      "/admin/packs:",
      "/admin/packs/{packId}/{version}/revoke:",
      "/client-releases/latest:",
      "/client-releases/versions/{version}:",
      "/client-releases/signing-key:",
      "/admin/client-releases:",
    ]) {
      expect(spec).toContain(`  ${path}`);
    }
    expect(spec).toContain("SignedClientUpdateMetadata:");
    expect(spec).toContain("ClientUpdateManifest:");
  });

  it("匿名客户端遥测路径与严格契约存在", () => {
    expect(spec).toContain("  /client/telemetry:");
    expect(spec).toContain("ClientTelemetryBatch:");
    expect(spec).toContain("additionalProperties: false");
    expect(spec).toContain("const: longhub/client-telemetry/v1");
  });

  it("声明幂等与断线恢复参数", () => {
    expect(spec).toContain("Idempotency-Key");
    expect(spec).toContain("Last-Event-ID");
  });

  it("统一错误结构 ApiError 必填字段冻结", () => {
    expect(spec).toContain("required: [code, message, request_id, retryable]");
  });
});

describe("任务模块实现与契约一致", () => {
  it("createTask：新建返回 201，同幂等键重放返回 200 且为同一任务", async () => {
    const post = (key: string) =>
      fetch(`${baseUrl}/v1/tasks`, {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json", "idempotency-key": key }),
        body: JSON.stringify({ kind: "skill.execute", input: { skillId: "longhub.skill.salary-band", level: 3 } }),
      });
    const created = await post("contract-key-1");
    expect(created.status).toBe(201);
    const first = (await created.json()) as { task_id: string };

    const replayed = await post("contract-key-1");
    expect(replayed.status).toBe(200);
    expect(((await replayed.json()) as { task_id: string }).task_id).toBe(first.task_id);
  });

  it("错误响应符合 ApiError：code/message/request_id/retryable 必填", async () => {
    const cases = [
      // 缺 Idempotency-Key → 4XX
      fetch(`${baseUrl}/v1/tasks`, {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ kind: "skill.execute", input: { skillId: "x" } }),
      }),
      // 未知任务 → 404
      fetch(`${baseUrl}/v1/tasks/ct-none`, { headers: authHeaders() }),
      // 未知路由 → 404
      fetch(`${baseUrl}/v1/unknown`, { headers: authHeaders() }),
      // 缺设备凭据 → 401
      fetch(`${baseUrl}/v1/entitlements`),
    ];
    for (const res of await Promise.all(cases)) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(typeof body.code).toBe("string");
      expect(typeof body.message).toBe("string");
      expect(typeof body.request_id).toBe("string");
      expect(typeof body.retryable).toBe("boolean");
    }
  });

  it("cancelTask 返回契约状态码 202；事件流为 text/event-stream", async () => {
    const created = await fetch(`${baseUrl}/v1/tasks`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json", "idempotency-key": "contract-key-2" }),
      body: JSON.stringify({ kind: "skill.execute", input: { skillId: "longhub.skill.salary-band", level: 3 } }),
    });
    const { task_id } = (await created.json()) as { task_id: string };

    const cancelled = await fetch(`${baseUrl}/v1/tasks/${task_id}/cancel`, {
      method: "POST",
      headers: authHeaders(),
    });
    expect(cancelled.status).toBe(202);

    const controller = new AbortController();
    const stream = await fetch(`${baseUrl}/v1/tasks/${task_id}/events`, {
      headers: authHeaders(),
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    controller.abort();
  });
});
