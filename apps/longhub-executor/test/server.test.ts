import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXECUTOR_CREDENTIAL_HEADER,
  EXECUTOR_REQUEST_SCHEMA,
  createExecutorServer,
  computeExecutorInputDigest,
  issueExecutorCredential,
  parseExecutorBindHost,
  parseExecutorPort,
  type CloudSkill,
  type ExecutorCredentialKey,
} from "../src/index.js";

const key: ExecutorCredentialKey = { keyId: "test-key", secret: Buffer.alloc(32, 0x42) };
const servers: ReturnType<typeof createExecutorServer>[] = [];

// The salary-band implementation is test-only. Production Executor instances
// must inject a private, audited registry explicitly.
const testSalaryBand: CloudSkill = async (input) => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("invalid");
  const level = (input as { level?: unknown }).level;
  if (!Number.isInteger(level) || (level as number) < 1 || (level as number) > 10) throw new Error("invalid");
  const base = 8000 + (level as number) * 4000;
  return { level, min: base, max: Math.round(base * 1.6), currency: "CNY" };
};

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function start(options: Parameters<typeof createExecutorServer>[0] = {}) {
  const server = createExecutorServer({
    credentialKey: key,
    ...options,
    skills: options.skills ?? new Map([["longhub.skill.salary-band", testSalaryBand]]),
  }).listen(0);
  servers.push(server);
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function requestParts(
  input: unknown,
  overrides: Partial<{ task_id: string; tenant_id: string; skill_id: string; idempotency_key: string }> = {},
) {
  const task_id = overrides.task_id ?? "task-1";
  const tenant_id = overrides.tenant_id ?? "tenant-a";
  const skill_id = overrides.skill_id ?? "longhub.skill.salary-band";
  const idempotency_key = overrides.idempotency_key ?? "idem-1";
  const credential = issueExecutorCredential(
    { taskId: task_id, tenantId: tenant_id, skillId: skill_id, idempotencyKey: idempotency_key, input },
    { key },
  );
  return {
    credential,
    body: {
      schema_version: EXECUTOR_REQUEST_SCHEMA,
      task_id,
      tenant_id,
      skill_id,
      idempotency_key,
      // The server verifies this field against the signed credential and input.
      input_digest: computeExecutorInputDigest(input),
      input,
    },
    idempotency_key,
  };
}

async function post(
  baseUrl: string,
  parts: ReturnType<typeof requestParts>,
  mutate?: (body: Record<string, unknown>) => Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const body = mutate ? mutate(parts.body as unknown as Record<string, unknown>) : parts.body;
  const response = await fetch(`${baseUrl}/execute`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [EXECUTOR_CREDENTIAL_HEADER]: parts.credential,
      "idempotency-key": parts.idempotency_key,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function expectError(body: Record<string, unknown>, code: string): void {
  expect(body.code).toBe(code);
  expect(typeof body.message).toBe("string");
  expect(typeof body.request_id).toBe("string");
  expect(typeof body.retryable).toBe("boolean");
}

describe("Executor startup port validation", () => {
  it.each(["0", "-1", "65536", "1.5", "NaN", "Infinity", "1e3", " 8082", "8082 "])(
    "rejects unsafe PORT=%s",
    (port) => {
      expect(() => parseExecutorPort(port)).toThrow("PORT 必须是 1-65535 的十进制整数");
    },
  );

  it.each([0, -1, 65_536, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects unsafe explicit startup port %s",
    (port) => {
      expect(() => parseExecutorPort(undefined, port)).toThrow("PORT 必须是 1-65535 的十进制整数");
    },
  );

  it.each([1, 8082, 65_535])("accepts configured port %s", (port) => {
    expect(parseExecutorPort(String(port))).toBe(port);
    expect(parseExecutorPort(undefined, port)).toBe(port);
  });
});

describe("Executor bind boundary", () => {
  it.each([undefined, "127.0.0.1", "127.42.0.5", "::1"])("accepts loopback host %s", (host) => {
    expect(parseExecutorBindHost(host)).toBe(host ?? "127.0.0.1");
  });

  it.each(["0.0.0.0", "::", "192.168.2.10", "8.8.8.8", "localhost", "127.0.0.1\n"])(
    "rejects non-loopback or ambiguous host %s",
    (host) => expect(() => parseExecutorBindHost(host)).toThrow(/EXECUTOR_BIND_HOST/u),
  );
});

describe("Executor internal request boundary", () => {
  it("does not ship the demo salary-band registry by default", async () => {
    const server = createExecutorServer({ credentialKey: key }).listen(0);
    servers.push(server);
    await once(server, "listening");
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const result = await post(baseUrl, requestParts({ level: 2 }));
    expect(result.status).toBe(404);
    expectError(result.body, "SKILL_NOT_FOUND");
  });

  it("rejects a naked request and never returns implementation details", async () => {
    const baseUrl = await start();
    const response = await fetch(`${baseUrl}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "idem-no-auth" },
      body: "{}",
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    expectError(body, "CREDENTIAL_REQUIRED");
    expect(JSON.stringify(body)).not.toContain("stack");
  });

  it("supports a bounded key-rotation overlap without accepting unknown keys", async () => {
    const oldKey: ExecutorCredentialKey = { keyId: "old-key", secret: Buffer.alloc(32, 0x17) };
    const baseUrl = await start({ credentialVerificationKeys: new Map([[oldKey.keyId, oldKey]]) });
    const parts = requestParts({ level: 2 });
    const oldCredential = issueExecutorCredential(
      {
        taskId: "rotation-task",
        tenantId: "tenant-a",
        skillId: "longhub.skill.salary-band",
        idempotencyKey: "rotation-idem",
        input: { level: 2 },
      },
      { key: oldKey },
    );
    const oldBody = {
      ...parts.body,
      task_id: "rotation-task",
      idempotency_key: "rotation-idem",
      input_digest: computeExecutorInputDigest({ level: 2 }),
      input: { level: 2 },
    };
    const response = await fetch(`${baseUrl}/execute`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [EXECUTOR_CREDENTIAL_HEADER]: oldCredential,
        "idempotency-key": "rotation-idem",
      },
      body: JSON.stringify(oldBody),
    });
    expect(response.status).toBe(200);
    const unknown = requestParts({ level: 2 }, { task_id: "unknown-key-task", idempotency_key: "unknown-key-idem" });
    const unknownResponse = await fetch(`${baseUrl}/execute`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [EXECUTOR_CREDENTIAL_HEADER]: issueExecutorCredential(
          { taskId: "unknown-key-task", tenantId: "tenant-a", skillId: "longhub.skill.salary-band", idempotencyKey: "unknown-key-idem", input: { level: 2 } },
          { key: { keyId: "other-key", secret: Buffer.alloc(32, 0x18) } },
        ),
        "idempotency-key": unknown.idempotency_key,
      },
      body: JSON.stringify(unknown.body),
    });
    expect(unknownResponse.status).toBe(401);
    expectError((await unknownResponse.json()) as Record<string, unknown>, "CREDENTIAL_INVALID");
  });

  it("binds credential to tenant, task, Skill, input and idempotency key", async () => {
    const baseUrl = await start();
    const parts = requestParts({ level: 3 });
    const ok = await post(baseUrl, parts);
    expect(ok.status).toBe(200);
    expect((ok.body.output as { min: number }).min).toBe(20_000);

    const changedTenant = await post(baseUrl, parts, (body) => ({ ...body, tenant_id: "tenant-b" }));
    expect(changedTenant.status).toBe(403);
    expectError(changedTenant.body, "CREDENTIAL_BINDING_MISMATCH");

    const changedInput = await post(baseUrl, parts, (body) => ({ ...body, input: { level: 4 } }));
    expect(changedInput.status).toBe(403);
    expectError(changedInput.body, "CREDENTIAL_BINDING_MISMATCH");
  });

  it("returns one result for idempotent retries and rejects conflicting reuse", async () => {
    let executions = 0;
    const skill: CloudSkill = async (input) => {
      executions += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { input, executions };
    };
    const baseUrl = await start({ skills: new Map([["longhub.skill.salary-band", skill]]) });
    const parts = requestParts({ level: 3 });
    const [first, replay] = await Promise.all([post(baseUrl, parts), post(baseUrl, parts)]);
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(executions).toBe(1);
    expect(first.body.output).toEqual(replay.body.output);

    // Reuse the same tenant/task/Skill/idempotency tuple with a different input.
    const conflictParts = requestParts({ level: 4 }, { task_id: "task-1", tenant_id: "tenant-a", idempotency_key: "idem-1" });
    const conflict = await post(baseUrl, conflictParts);
    expect(conflict.status).toBe(409);
    expectError(conflict.body, "IDEMPOTENCY_CONFLICT");
  });

  it("enforces body size and execution time limits", async () => {
    const slowSkill: CloudSkill = async (_input, context) => {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 100);
        context.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      return { shouldNot: "finish" };
    };
    const baseUrl = await start({
      maxBodyBytes: 512,
      executionTimeoutMs: 15,
      skills: new Map([["longhub.skill.salary-band", slowSkill]]),
    });
    const timeout = await post(baseUrl, requestParts({ value: "x" }));
    expect(timeout.status).toBe(504);
    expectError(timeout.body, "EXECUTION_TIMEOUT");

    const oversized = requestParts({ value: "x".repeat(2_000) });
    const tooLarge = await post(baseUrl, oversized);
    expect(tooLarge.status).toBe(413);
    expectError(tooLarge.body, "REQUEST_TOO_LARGE");
  });

  it("maps Skill failures to fixed errors without leaking thrown messages", async () => {
    const skill: CloudSkill = async () => {
      throw new Error("secret prompt, database://internal, stack trace");
    };
    const baseUrl = await start({ skills: new Map([["longhub.skill.salary-band", skill]]) });
    const result = await post(baseUrl, requestParts({ level: 3 }));
    expect(result.status).toBe(500);
    expectError(result.body, "SKILL_EXECUTION_FAILED");
    expect(JSON.stringify(result.body)).not.toContain("database://internal");
    expect(JSON.stringify(result.body)).not.toContain("secret prompt");
  });
});
