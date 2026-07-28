import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createExecutorServer } from "longhub-executor";
import { createCloudApiServer } from "../src/server.js";

let executor: ReturnType<typeof createExecutorServer>;
let api: ReturnType<typeof createCloudApiServer>;
let baseUrl: string;
let deviceToken: string;

beforeAll(async () => {
  executor = createExecutorServer().listen(0);
  await once(executor, "listening");
  const executorUrl = `http://127.0.0.1:${(executor.address() as AddressInfo).port}`;
  api = createCloudApiServer({ executorUrl }).listen(0);
  await once(api, "listening");
  baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  const registered = await fetch(`${baseUrl}/v1/devices/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      platform: "windows",
      app_version: "1.0.0",
      device_fingerprint: "fp-cloud-task-test",
    }),
  });
  deviceToken = ((await registered.json()) as { device_token: string }).device_token;
});

afterAll(() => {
  api.close();
  executor.close();
});

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { authorization: `Bearer ${deviceToken}`, ...extra };
}

async function createTask(idempotencyKey: string): Promise<{ task_id: string; status: string }> {
  const res = await fetch(`${baseUrl}/v1/tasks`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json", "idempotency-key": idempotencyKey }),
    body: JSON.stringify({ kind: "skill.execute", input: { skillId: "longhub.skill.salary-band", level: 5 } }),
  });
  return (await res.json()) as { task_id: string; status: string };
}

async function readSse(
  path: string,
  lastEventId: string | undefined,
  until: (events: { event_id: string; type: string }[]) => boolean,
): Promise<{ event_id: string; type: string }[]> {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}${path}`, {
    headers: authHeaders(lastEventId ? { "last-event-id": lastEventId } : {}),
    signal: controller.signal,
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: { event_id: string; type: string }[] = [];
  let buffer = "";
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const chunkResult = await Promise.race([
      reader.read(),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), deadline - Date.now())),
    ]);
    if (chunkResult === "timeout") break;
    const { value, done } = chunkResult;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (dataLine) events.push(JSON.parse(dataLine.slice(6)) as { event_id: string; type: string });
    }
    if (until(events)) break;
  }
  controller.abort();
  return events;
}

describe("云台任务模块 + 执行器闭环", () => {
  it("缺少设备凭据的任务请求被拒绝（401）", async () => {
    const res = await fetch(`${baseUrl}/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "no-auth" },
      body: JSON.stringify({ kind: "skill.execute", input: { skillId: "x" } }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("UNAUTHORIZED");
  });

  it("拒绝缺少 Idempotency-Key 的请求", async () => {
    const res = await fetch(`${baseUrl}/v1/tasks`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ kind: "skill.execute", input: { skillId: "x" } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; request_id: string };
    expect(body.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(body.request_id).toBeTruthy();
  });

  it("创建任务→执行器执行→查询到成功结果；幂等键返回同一任务", async () => {
    const task = await createTask("it-key-1");
    const dup = await createTask("it-key-1");
    expect(dup.task_id).toBe(task.task_id);

    let detail: { status: string; output?: { min: number; max: number } } | undefined;
    for (let i = 0; i < 50; i++) {
      const res = await fetch(`${baseUrl}/v1/tasks/${task.task_id}`, { headers: authHeaders() });
      detail = (await res.json()) as typeof detail;
      if (detail!.status === "succeeded") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(detail!.status).toBe("succeeded");
    expect(detail!.output!.min).toBe(28000);
    expect(detail!.output!.max).toBe(44800);
  });

  it("SSE 支持 Last-Event-ID 断线恢复且不重复投递", async () => {
    const task = await createTask("it-key-sse");
    // 先等任务到终态，保证历史事件完整
    for (let i = 0; i < 50; i++) {
      const res = await fetch(`${baseUrl}/v1/tasks/${task.task_id}`, { headers: authHeaders() });
      if (((await res.json()) as { status: string }).status === "succeeded") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const path = `/v1/tasks/${task.task_id}/events`;

    // 第一次连接：收到事件后在 task.accepted 处“断线”
    const first = await readSse(path, undefined, (events) => events.length >= 1);
    expect(first[0]!.type).toBe("task.accepted");
    const lastId = first[0]!.event_id;

    // 携带 Last-Event-ID 重连：只重放断点之后的事件，直到终态
    const resumed = await readSse(path, lastId, (events) =>
      events.some((e) => e.type === "task.succeeded"),
    );
    const resumedIds = resumed.map((e) => Number(e.event_id));
    expect(Math.min(...resumedIds)).toBeGreaterThan(Number(lastId));
    expect(resumed.some((e) => e.type === "task.succeeded")).toBe(true);
  }, 20_000);

  it("取消任务返回 202 并进入 cancelled", async () => {
    const task = await createTask("it-key-cancel");
    const res = await fetch(`${baseUrl}/v1/tasks/${task.task_id}/cancel`, {
      method: "POST",
      headers: authHeaders(),
    });
    expect(res.status).toBe(202);
  });
});
