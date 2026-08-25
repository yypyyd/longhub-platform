import { describe, expect, it, vi } from "vitest";
import {
  createCloudSkillClient,
  createCloudSkillClientFromEnv,
  CloudSkillError,
} from "../src/client.js";
import { deriveIdempotencyKey, toCloudSkillRequest } from "../src/protocol.js";

const endpoint = "http://127.0.0.1:41081";
const request = toCloudSkillRequest(
  { skill_id: "longhub.skill.resume", skill_version: "1.0.0", input: { text: "hello" } },
  { agent_id: "agent-main", session_key: "session-key", session_id: "session-1", tool_call_id: "call-1" },
);

function vault() {
  return {
    read: vi.fn(async () => ({ deviceId: "dev-1", deviceToken: "device-token-abcdefghijklmnopqrstuvwxyz" })),
    write: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
}

describe("direct Cloud API client", () => {
  it("posts strict tasks with device bearer and polls to success", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/v1/tasks")) {
        return new Response(JSON.stringify({ task_id: "task-1", status: "pending" }), { status: 201 });
      }
      return new Response(JSON.stringify({ task_id: "task-1", status: "succeeded", output: { ok: true } }), { status: 200 });
    });
    const result = await createCloudSkillClient({
      baseUrl: endpoint,
      vault: vault(),
      fetchImpl,
      pollMs: 100,
      openclawVersion: "2026.7.1-2",
    }).execute(request);
    expect(result).toEqual({ ok: true });
    expect(calls[0]?.url).toBe(`${endpoint}/v1/tasks`);
    expect(calls[0]?.init?.headers).toMatchObject({
      Authorization: "Bearer device-token-abcdefghijklmnopqrstuvwxyz",
      "Idempotency-Key": deriveIdempotencyKey({ skill_id: "longhub.skill.resume", skill_version: "1.0.0", input: { text: "hello" } }, { agent_id: "agent-main", session_key: "session-key", session_id: "session-1", tool_call_id: "call-1" }),
      "X-LongHub-Agent-ID": "agent-main",
      "X-LongHub-OpenClaw-Version": "2026.7.1-2",
    });
    expect(String((calls[0]?.init?.body ?? ""))).toContain('"skill_id":"longhub.skill.resume"');
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      schema_version: "longhub/cloud-skill-call/v1",
      kind: "skill.execute",
      session_key_hash: "1add55581aaea687f8c5e7919f217cb6640cba7d2c14e7e4d6d4df21460642cf",
    });
    expect(String(calls[0]?.init?.body)).not.toContain("session-key");
  });

  it("cancels an in-flight task when the caller aborts", async () => {
    const controller = new AbortController();
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/v1/tasks")) return new Response(JSON.stringify({ task_id: "task-2", status: "running" }), { status: 201 });
      if (url.endsWith("/cancel")) return new Response(JSON.stringify({ task_id: "task-2", status: "cancelled" }), { status: 200 });
      return new Response(JSON.stringify({ task_id: "task-2", status: "running" }), { status: 200 });
    });
    const promise = createCloudSkillClient({ baseUrl: endpoint, vault: vault(), fetchImpl, pollMs: 100 }).execute(request, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(urls.some((url) => url.endsWith("/v1/tasks/task-2/cancel"))).toBe(true);
  });

  it("fails closed without a Credential Manager record", async () => {
    const missingVault = { read: vi.fn(async () => undefined), write: vi.fn(), delete: vi.fn() };
    await expect(createCloudSkillClient({ baseUrl: endpoint, vault: missingVault }).execute(request)).rejects.toMatchObject({ code: "DEVICE_CREDENTIAL_REQUIRED" });
  });

  it("uses only the non-secret Cloud API URL environment variable", async () => {
    expect(createCloudSkillClientFromEnv({ LONGHUB_CLOUD_API_URL: endpoint })).toBeDefined();
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ task_id: "task-env", status: "succeeded", output: { ok: true } }), { status: 201 });
    });
    const ignored = createCloudSkillClientFromEnv(
      { LONGHUB_EXECUTION_BRIDGE_URL: endpoint, LONGHUB_EXECUTION_TOKEN: "secret" },
      {
        vault: vault(),
        fetchImpl,
      },
    );
    await expect(ignored.execute(request)).resolves.toEqual({ ok: true });
    expect(calls).toEqual(["https://154-9-26-158.sslip.io/v1/tasks"]);
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      "X-LongHub-OpenClaw-Version": "2026.7.1-2",
    });
  });

  it("maps Cloud API errors to stable public errors", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ code: "CLOUD_SKILL_SUBSCRIPTION_REQUIRED", retryable: false }), { status: 403 }));
    const error = await createCloudSkillClient({ baseUrl: endpoint, vault: vault(), fetchImpl }).execute(request).catch((value) => value);
    expect(error).toBeInstanceOf(CloudSkillError);
    expect(error).toMatchObject({ code: "CLOUD_SKILL_SUBSCRIPTION_REQUIRED", retryable: false });
    expect((error as Error).message).not.toContain("device-token");
  });
});
