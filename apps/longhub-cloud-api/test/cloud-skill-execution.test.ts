import { createServer, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FeaturePolicyEntry } from "@longhub/feature-policy";
import { createCloudSkillAdapterFile, type CloudSkillAdapterManifest } from "@longhub/cloud-skill-adapter";
import { prepareCloudSkillAdapterRelease } from "../src/cloud-skill-adapter-release.js";
import { MemoryStore } from "../src/memory-store.js";
import { createCloudApiServer, generateSigningKey } from "../src/server.js";
import { isCloudTaskAdmissionPlaceholder } from "../src/store.js";

const ADMIN_TOKEN = "cloud-skill-execution-admin";
const SKILL_ID = "longhub.skill.execution-regression";
const ALTERNATE_SKILL_ID = "longhub.skill.alternate-regression";
const PLAN_ID = "longhub-execution-regression";
const OTHER_PLAN_ID = "longhub-execution-other";
const SKILL_VERSION = "1.0.0";
const ALTERNATE_SKILL_VERSION = "1.0.1";
const OPENCLAW_VERSION = "2026.7.1";
const ADAPTER_SIGNING_KEY = generateSigningKey("execution-test-key");

type ExecutorMode = "immediate" | "hold" | "never";

interface ExecutorCall {
  body: Record<string, unknown>;
}

interface FixtureOptions {
  included_calls?: number;
  requests_per_minute?: number;
  max_concurrency?: number;
  executor_mode?: ExecutorMode;
  executor_timeout_ms?: number;
  publish_release?: boolean;
  release_min_manager_version?: string;
  release_openclaw_version?: string;
  app_version?: string;
  bind_agent_skill?: boolean;
}

interface Fixture {
  store: MemoryStore;
  api: Server;
  executor: Server;
  baseUrl: string;
  userToken: string;
  userId: string;
  deviceToken: string;
  deviceId: string;
  calls: ExecutorCall[];
  pending: ServerResponse[];
  waitForCall(count?: number): Promise<void>;
  finishNext(): void;
}

const openServers: Server[] = [];
let fixtureSequence = 0;

async function listen(server: Server): Promise<string> {
  openServers.push(server);
  server.listen(0);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(async (server) => {
    if (!server.listening) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});

function makeAdapterRelease(
  options: FixtureOptions = {},
  skillId = SKILL_ID,
  skillVersion = SKILL_VERSION,
): ReturnType<typeof prepareCloudSkillAdapterRelease> {
  const contents = {
    "SKILL.md": "---\nname: execution-regression\ndescription: Execution admission regression declaration\n---\n\nThis file is a thin declaration only. Runtime execution stays in LongHub Cloud.\n",
    "schemas/input.json": JSON.stringify({ type: "object", properties: { text: { type: "string" } }, additionalProperties: true }),
    "schemas/output.json": JSON.stringify({ type: "object", properties: { ok: { type: "boolean" } }, additionalProperties: true }),
  };
  const files = Object.fromEntries(Object.entries(contents).map(([path, content]) => [
    path,
    Buffer.from(content, "utf8").toString("base64"),
  ]));
  const manifest = {
    schema_version: "longhub/cloud-skill-adapter/v1",
    skill_id: skillId,
    version: skillVersion,
    display: { name: "Execution regression", description: "Cloud execution admission regression", category: "test" },
    service: { service_id: "longhub.cloud.execution-regression", api_version: "1.0", entry: "local-longhub-bridge" },
    schemas: { input: "schemas/input.json", output: "schemas/output.json" },
    files: Object.entries(contents).map(([path, content]) => createCloudSkillAdapterFile(path, content)),
    subscription: { plan_ids: [PLAN_ID] },
    permissions: { requested: [], confirmation_class: "none" },
    compatibility: {
      manager_min_version: options.release_min_manager_version ?? "1.0.0",
      openclaw_version: options.release_openclaw_version ?? OPENCLAW_VERSION,
    },
    integrity: {
      algorithm: "sha256",
      digest: "0".repeat(64),
      signature_key_id: ADAPTER_SIGNING_KEY.keyId,
      signature: "A".repeat(86) + "==",
    },
  } satisfies CloudSkillAdapterManifest;
  return prepareCloudSkillAdapterRelease({ manifest, files }, ADAPTER_SIGNING_KEY);
}

function disabledSkillExecutionPolicy(): FeaturePolicyEntry {
  return {
    feature_id: "skill.execute",
    enabled: false,
    scope: "global",
    audience: "user",
    mode: "default",
    risk_level: "low",
    limits: {},
    data_policy: {
      processing_location: "platform_region",
      retention_days: 30,
      export_allowed: false,
      deletion_allowed: false,
    },
    required_entitlements: [],
    required_permissions: [],
    min_manager_version: "0.0.0",
    emergency_disabled: false,
  };
}

async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const sequence = ++fixtureSequence;
  const calls: ExecutorCall[] = [];
  const pending: ServerResponse[] = [];
  const callWaiters: Array<{ count: number; resolve: () => void }> = [];
  const mode = options.executor_mode ?? "immediate";

  const executor = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/execute") {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // The test only needs to track that the private boundary was crossed.
    }
    calls.push({ body });
    for (const waiter of callWaiters.splice(0)) {
      if (calls.length >= waiter.count) waiter.resolve();
      else callWaiters.push(waiter);
    }
    if (mode === "immediate") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output: { ok: true, call: calls.length } }));
      return;
    }
    if (mode === "never") {
      res.writeHead(200, { "content-type": "application/json" });
      // Keep the body open so Cloud API's response deadline exercises timeout.
      res.write('{"output":');
      pending.push(res);
      return;
    }
    // Hold the complete response until the test explicitly releases it.
    pending.push(res);
  });
  const executorUrl = await listen(executor);

  const store = new MemoryStore();
  const api = createCloudApiServer({
    executorUrl,
    executorRequestTimeoutMs: options.executor_timeout_ms ?? 1_000,
    store,
    adminToken: ADMIN_TOKEN,
    skillSigningKey: ADAPTER_SIGNING_KEY,
  });
  const baseUrl = await listen(api);

  // Cloud Skill admission tests seed the account directly in MemoryStore.
  // The public bind endpoint intentionally rejects UUID-only requests until
  // the one-time pairing proof flow ships, so HTTP registration is followed
  // by an explicit in-process ownership link.
  const { user: seededUser } = await store.createUser({
    email: `cloud-skill-execution-${sequence}@test.cn`,
    password_hash: "test-only-hash",
  });
  const userBody = { user: { user_id: seededUser.user_id } };

  const registeredDevice = await fetch(`${baseUrl}/v1/devices/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      platform: "openclaw-plugin-windows",
      app_version: options.app_version ?? "1.0.0",
      device_fingerprint: `cloud-skill-execution-device-${sequence}`,
    }),
  });
  expect(registeredDevice.status).toBe(201);
  const deviceBody = await registeredDevice.json() as { device_id: string; device_token: string };
  const bound = await store.bindDevice(deviceBody.device_id, seededUser.user_id);
  expect(bound?.user_id).toBe(seededUser.user_id);

  await store.createCloudSkillPlan({
    plan_id: PLAN_ID,
    name: "Execution regression plan",
    skill_ids: [SKILL_ID],
    price_monthly_fen: 1,
    price_yearly_fen: 1,
    included_calls: options.included_calls ?? 100,
    requests_per_minute: options.requests_per_minute ?? 100,
    max_concurrency: options.max_concurrency ?? 2,
  });
  const startsAt = new Date(Date.now() - 1_000).toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const { subscription } = await store.createCloudSkillSubscription({
    user_id: userBody.user.user_id,
    tenant_id: "tenant-default",
    plan_id: PLAN_ID,
    period: "monthly",
    starts_at: startsAt,
    expires_at: expiresAt,
    source_order_id: `execution-order-${sequence}`,
  });
  await store.grantCloudSkillEntitlement({
    subscription_id: subscription.subscription_id,
    skill_id: SKILL_ID,
    plan_id: PLAN_ID,
  });
  if (options.bind_agent_skill !== false) {
    await store.upsertCloudAgentSkillBinding({
      tenant_id: "tenant-default",
      device_id: deviceBody.device_id,
      user_id: userBody.user.user_id,
      agent_id: "agent-main",
      skill_id: SKILL_ID,
    });
  }
  if (options.publish_release !== false) {
    await store.publishCloudSkillAdapterRelease(makeAdapterRelease(options));
  }

  return {
    store,
    api,
    executor,
    baseUrl,
    userToken: "",
    userId: seededUser.user_id,
    deviceToken: deviceBody.device_token,
    deviceId: deviceBody.device_id,
    calls,
    pending,
    waitForCall(count = 1): Promise<void> {
      if (calls.length >= count) return Promise.resolve();
      return new Promise<void>((resolve) => callWaiters.push({ count, resolve }));
    },
    finishNext(): void {
      const response = pending.shift();
      if (!response || response.writableEnded) return;
      if (!response.headersSent) response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ output: { ok: true } }));
    },
  };
}

interface TaskOptions {
  key: string;
  plan_id?: string;
  skill_id?: string;
  skill_version?: string;
  request_id?: string;
  tool_call_id?: string;
  session_key_hash?: string;
  input?: Record<string, unknown>;
  legacy?: boolean;
  openclaw_version?: string;
}

async function createTask(fixture: Fixture, options: TaskOptions): Promise<{ response: Response; body: any }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${fixture.deviceToken}`,
    "content-type": "application/json",
    "idempotency-key": options.key,
  };
  if (options.openclaw_version !== undefined) headers["x-longhub-openclaw-version"] = options.openclaw_version;
  const body = options.legacy
    ? {
        kind: "skill.execute",
        input: { skill_id: SKILL_ID, plan_id: options.plan_id ?? PLAN_ID, text: "legacy" },
      }
    : {
        schema_version: "longhub/cloud-skill-call/v1",
        request_id: options.request_id ?? `request-${options.key}`,
        kind: "skill.execute",
        skill_id: options.skill_id ?? SKILL_ID,
        skill_version: options.skill_version ?? SKILL_VERSION,
        agent_id: "agent-main",
        tool_call_id: options.tool_call_id ?? `call-${options.key}`,
        session_key_hash: options.session_key_hash ?? "0".repeat(64),
        idempotency_key: options.key,
        ...(options.plan_id === undefined ? {} : { plan_id: options.plan_id }),
        input: options.input ?? { text: "execution regression" },
      };
  const response = await fetch(`${fixture.baseUrl}/v1/tasks`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

async function waitForTerminal(fixture: Fixture, taskId: string, timeoutMs = 2_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${fixture.baseUrl}/v1/tasks/${taskId}`, {
      headers: {
        authorization: `Bearer ${fixture.deviceToken}`,
        "x-longhub-agent-id": "agent-main",
      },
    });
    const body = await response.json() as any;
    if (["succeeded", "failed", "cancelled", "timed_out"].includes(body.status)) return body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`task ${taskId} did not reach a terminal state`);
}

function trackReservations(fixture: Fixture): () => number {
  let count = 0;
  const reserve = fixture.store.reserveCloudSkillExecution.bind(fixture.store);
  fixture.store.reserveCloudSkillExecution = async (params) => {
    count += 1;
    return reserve(params);
  };
  return () => count;
}

describe("Cloud Skill execution admission HTTP boundary", () => {
  it("atomically upserts and reactivates one binding per owner tuple", async () => {
    const store = new MemoryStore();
    const request = {
      tenant_id: "tenant-binding-store",
      device_id: "device-binding-store",
      user_id: "user-binding-store",
      agent_id: "agent-binding-store",
      skill_id: SKILL_ID,
    } as const;
    const results = await Promise.all(Array.from({ length: 16 }, () =>
      store.upsertCloudAgentSkillBinding(request)));
    expect(new Set(results.map((result) => result.binding.binding_id))).toHaveLength(1);
    expect(results.filter((result) => !result.existed)).toHaveLength(1);
    expect(await store.listCloudAgentSkillBindings(request)).toHaveLength(1);

    const binding = results[0]!.binding;
    expect((await store.revokeCloudAgentSkillBinding(binding.binding_id))?.status).toBe("revoked");
    expect(await store.resolveCloudAgentSkillBinding(request)).toBeUndefined();
    const reactivated = await store.upsertCloudAgentSkillBinding(request);
    expect(reactivated).toMatchObject({
      existed: true,
      binding: { binding_id: binding.binding_id, status: "active" },
    });
    expect(reactivated.binding.revoked_at).toBeUndefined();
    expect(await store.resolveCloudAgentSkillBinding({ ...request, user_id: "another-user" })).toBeUndefined();
  });

  it("only executes strict v1 calls with an active subscription and active compatible release", async () => {
    const fixture = await createFixture();
    const legacy = await createTask(fixture, { key: "strict-required-legacy", legacy: true });
    expect(legacy.response.status).toBe(422);
    expect(legacy.body.code).toBe("INVALID_TASK");
    expect(fixture.calls).toHaveLength(0);

    const created = await createTask(fixture, { key: "strict-required-v1", openclaw_version: OPENCLAW_VERSION });
    expect(created.response.status).toBe(201);
    const terminal = await waitForTerminal(fixture, created.body.task_id);
    expect(terminal).toMatchObject({ status: "succeeded", output: { ok: true } });
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]!.body).not.toHaveProperty("plan_id");
    expect(fixture.calls[0]!.body).toMatchObject({
      schema_version: "longhub/executor-request/v1",
      skill_id: SKILL_ID,
    });
  });

  it("uses registered device + account subscription without the legacy Pack activation code", async () => {
    const fixture = await createFixture();
    const created = await createTask(fixture, { key: "cloud-skill-without-legacy-activation" });
    expect(created.response.status).toBe(201);
    expect(await waitForTerminal(fixture, created.body.task_id)).toMatchObject({ status: "succeeded" });
    expect(fixture.calls).toHaveLength(1);
  });

  it("requires an active server-owned Agent-Skill binding before task creation or reservation", async () => {
    const fixture = await createFixture({ bind_agent_skill: false });
    let createCount = 0;
    let reservationCount = 0;
    const create = fixture.store.createTask.bind(fixture.store);
    const reserve = fixture.store.reserveCloudSkillExecution.bind(fixture.store);
    fixture.store.createTask = async (...args) => {
      createCount += 1;
      return create(...args);
    };
    fixture.store.reserveCloudSkillExecution = async (params) => {
      reservationCount += 1;
      return reserve(params);
    };

    const key = "agent-binding-required";
    const rejected = await createTask(fixture, { key });
    expect(rejected.response.status).toBe(403);
    expect(rejected.body).toMatchObject({ code: "AGENT_SKILL_BINDING_REQUIRED", retryable: false });
    expect(createCount).toBe(0);
    expect(reservationCount).toBe(0);
    expect(fixture.calls).toHaveLength(0);
    expect(await fixture.store.findTaskByIdempotency(key, {
      tenant_id: "tenant-default",
      device_id: fixture.deviceId,
      agent_id: "agent-main",
    })).toBeUndefined();
  });

  it("lets an authenticated device enroll, list and revoke only its own Agent-Skill binding", async () => {
    const fixture = await createFixture({ bind_agent_skill: false });
    const enrolled = await fetch(`${fixture.baseUrl}/v1/cloud-skill/bindings`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.deviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ agent_id: "agent-main", skill_id: SKILL_ID }),
    });
    expect(enrolled.status).toBe(201);
    const enrolledBody = await enrolled.json() as { binding: { binding_id: string; status: string } };
    expect(enrolledBody.binding.status).toBe("active");

    const listed = await fetch(`${fixture.baseUrl}/v1/cloud-skill/bindings`, {
      headers: { authorization: `Bearer ${fixture.deviceToken}` },
    });
    expect(listed.status).toBe(200);
    expect((await listed.json() as { bindings: unknown[] }).bindings).toHaveLength(1);

    const revoked = await fetch(
      `${fixture.baseUrl}/v1/cloud-skill/bindings/${enrolledBody.binding.binding_id}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${fixture.deviceToken}` },
      },
    );
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({ binding: { status: "revoked" } });

    const rejected = await createTask(fixture, { key: "revoked-device-binding" });
    expect(rejected.response.status).toBe(403);
    expect(rejected.body.code).toBe("AGENT_SKILL_BINDING_REQUIRED");
    expect(fixture.calls).toHaveLength(0);
  });

  it("rechecks binding revocation at the final pre-Executor execution point", async () => {
    const fixture = await createFixture();
    const [binding] = await fixture.store.listCloudAgentSkillBindings({
      tenant_id: "tenant-default",
      device_id: fixture.deviceId,
      agent_id: "agent-main",
      skill_id: SKILL_ID,
    });
    expect(binding).toBeDefined();
    const resolve = fixture.store.resolveCloudAgentSkillBinding.bind(fixture.store);
    let checks = 0;
    fixture.store.resolveCloudAgentSkillBinding = async (query) => {
      checks += 1;
      if (checks === 2) await fixture.store.revokeCloudAgentSkillBinding(binding!.binding_id);
      return resolve(query);
    };

    const created = await createTask(fixture, { key: "binding-revoked-before-executor" });
    expect(created.response.status).toBe(201);
    const terminal = await waitForTerminal(fixture, created.body.task_id);
    expect(terminal).toMatchObject({
      status: "failed",
      error: { code: "AGENT_SKILL_BINDING_REQUIRED", retryable: false },
    });
    expect(checks).toBeGreaterThanOrEqual(2);
    expect(fixture.calls).toHaveLength(0);
  });

  it("keeps exact idempotent replay readable after binding revoke while blocking a new key", async () => {
    const fixture = await createFixture();
    const reservationCount = trackReservations(fixture);
    let createCount = 0;
    const create = fixture.store.createTask.bind(fixture.store);
    fixture.store.createTask = async (...args) => {
      createCount += 1;
      return create(...args);
    };
    const request = { key: "binding-revoke-replay", input: { text: "binding replay" } } as const;

    const created = await createTask(fixture, request);
    expect(created.response.status).toBe(201);
    expect(await waitForTerminal(fixture, created.body.task_id)).toMatchObject({ status: "succeeded" });
    const [binding] = await fixture.store.listCloudAgentSkillBindings({
      tenant_id: "tenant-default",
      device_id: fixture.deviceId,
      agent_id: "agent-main",
      skill_id: SKILL_ID,
      status: "active",
    });
    expect(binding).toBeDefined();
    await fixture.store.revokeCloudAgentSkillBinding(binding!.binding_id);

    const replayed = await createTask(fixture, request);
    expect(replayed.response.status).toBe(200);
    expect(replayed.body).toMatchObject({ task_id: created.body.task_id, status: "succeeded" });
    const newTask = await createTask(fixture, { key: "binding-revoke-new-key", input: request.input });
    expect(newTask.response.status).toBe(403);
    expect(newTask.body.code).toBe("AGENT_SKILL_BINDING_REQUIRED");
    expect(fixture.calls).toHaveLength(1);
    expect(reservationCount()).toBe(1);
    expect(createCount).toBe(1);
  });

  it("binds one idempotency key to every normalized request field", async () => {
    const fixture = await createFixture();

    // Add authorized catalog entries for the alternate Skill/version and a
    // second active plan so each mutation reaches the task store instead of
    // being rejected earlier by entitlement/release validation.
    await fixture.store.updateCloudSkillPlan(PLAN_ID, {
      skill_ids: [SKILL_ID, ALTERNATE_SKILL_ID],
    });
    const subscription = (await fixture.store.listCloudSkillSubscriptions(fixture.userId))
      .find((entry) => entry.plan_id === PLAN_ID);
    expect(subscription).toBeDefined();
    await fixture.store.grantCloudSkillEntitlement({
      subscription_id: subscription!.subscription_id,
      skill_id: ALTERNATE_SKILL_ID,
      plan_id: PLAN_ID,
    });
    await fixture.store.publishCloudSkillAdapterRelease(makeAdapterRelease({}, ALTERNATE_SKILL_ID, SKILL_VERSION));
    await fixture.store.publishCloudSkillAdapterRelease(makeAdapterRelease({}, SKILL_ID, ALTERNATE_SKILL_VERSION));
    await fixture.store.createCloudSkillPlan({
      plan_id: OTHER_PLAN_ID,
      name: "Execution alternate plan",
      skill_ids: [SKILL_ID],
      price_monthly_fen: 1,
      price_yearly_fen: 1,
      included_calls: 100,
      requests_per_minute: 100,
      max_concurrency: 2,
    });
    const alternateSubscription = await fixture.store.createCloudSkillSubscription({
      user_id: fixture.userId,
      tenant_id: "tenant-default",
      plan_id: OTHER_PLAN_ID,
      period: "monthly",
      starts_at: new Date(Date.now() - 1_000).toISOString(),
      expires_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      source_order_id: `execution-alternate-order-${fixtureSequence}`,
    });
    await fixture.store.grantCloudSkillEntitlement({
      subscription_id: alternateSubscription.subscription.subscription_id,
      skill_id: SKILL_ID,
      plan_id: OTHER_PLAN_ID,
    });

    let reservationCount = 0;
    const reserve = fixture.store.reserveCloudSkillExecution.bind(fixture.store);
    fixture.store.reserveCloudSkillExecution = async (params) => {
      reservationCount += 1;
      return reserve(params);
    };

    const key = "fingerprint-http-binding";
    const input = { text: "same business input" };
    // Pin the baseline to the original plan; the plan variant below is then
    // an authorized, independently resolved plan rather than a no-op replay.
    const first = await createTask(fixture, { key, plan_id: PLAN_ID, input });
    expect(first.response.status).toBe(201);
    const terminal = await waitForTerminal(fixture, first.body.task_id);
    expect(terminal.status).toBe("succeeded");
    expect(fixture.calls).toHaveLength(1);
    expect(reservationCount).toBe(1);

    // Exact terminal replay is a pure read: no Executor call and no second
    // usage reservation.
    const exactReplay = await createTask(fixture, { key, plan_id: PLAN_ID, input });
    expect(exactReplay.response.status).toBe(200);
    expect(exactReplay.body).toMatchObject({ task_id: first.body.task_id, status: "succeeded" });
    expect(fixture.calls).toHaveLength(1);
    expect(reservationCount).toBe(1);

    const variants: Array<{ label: string; options: TaskOptions }> = [
      { label: "skill_id", options: { key, plan_id: PLAN_ID, skill_id: ALTERNATE_SKILL_ID, input } },
      { label: "skill_version", options: { key, plan_id: PLAN_ID, skill_version: ALTERNATE_SKILL_VERSION, input } },
      { label: "tool_call_id", options: { key, plan_id: PLAN_ID, tool_call_id: "call-mutated", input } },
      { label: "session_key_hash", options: { key, plan_id: PLAN_ID, session_key_hash: "1".repeat(64), input } },
      { label: "request_id", options: { key, plan_id: PLAN_ID, request_id: "request-mutated", input } },
      { label: "plan_id", options: { key, plan_id: OTHER_PLAN_ID, input } },
    ];
    for (const variant of variants) {
      const rejected = await createTask(fixture, variant.options);
      expect(rejected.response.status, variant.label).toBe(409);
      expect(rejected.body.code, variant.label).toBe("IDEMPOTENCY_CONFLICT");
      expect(fixture.calls, variant.label).toHaveLength(1);
      expect(reservationCount, variant.label).toBe(1);
    }
    expect(await fixture.store.getTask(first.body.task_id)).toMatchObject({ status: "succeeded" });
  });

  it("replays an in-flight task after subscription cancellation without another reservation or execution", async () => {
    const fixture = await createFixture({ executor_mode: "hold" });
    const reservationCount = trackReservations(fixture);
    const request = {
      key: "replay-after-subscription-cancel",
      plan_id: PLAN_ID,
      input: { text: "subscription replay" },
    } as const;

    const created = await createTask(fixture, request);
    expect(created.response.status).toBe(201);
    await fixture.waitForCall();
    const subscription = (await fixture.store.listCloudSkillSubscriptions(fixture.userId))[0];
    expect(subscription).toBeDefined();
    await fixture.store.updateCloudSkillSubscriptionStatus(subscription!.subscription_id, "cancelled");

    const replayed = await createTask(fixture, request);
    expect(replayed.response.status).toBe(200);
    expect(replayed.body).toMatchObject({ task_id: created.body.task_id, status: "running" });
    expect(replayed.body).not.toHaveProperty("request_fingerprint");
    expect(fixture.calls).toHaveLength(1);
    expect(reservationCount()).toBe(1);

    const newTask = await createTask(fixture, {
      key: "new-after-subscription-cancel",
      plan_id: PLAN_ID,
      input: request.input,
    });
    expect(newTask.response.status).toBe(403);
    expect(newTask.body.code).toBe("CLOUD_SKILL_SUBSCRIPTION_REQUIRED");
    expect(fixture.calls).toHaveLength(1);
    expect(reservationCount()).toBe(1);

    fixture.finishNext();
    expect(await waitForTerminal(fixture, created.body.task_id)).toMatchObject({ status: "succeeded" });
  });

  it("replays the exact task after release revocation while a new key remains blocked", async () => {
    const fixture = await createFixture();
    const reservationCount = trackReservations(fixture);
    const request = {
      key: "replay-after-release-revoke",
      plan_id: PLAN_ID,
      input: { text: "release replay" },
    } as const;

    const created = await createTask(fixture, request);
    expect(created.response.status).toBe(201);
    expect(await waitForTerminal(fixture, created.body.task_id)).toMatchObject({ status: "succeeded" });
    await fixture.store.revokeCloudSkillAdapterRelease(SKILL_ID, SKILL_VERSION);

    const replayed = await createTask(fixture, request);
    expect(replayed.response.status).toBe(200);
    expect(replayed.body).toMatchObject({ task_id: created.body.task_id, status: "succeeded" });
    expect(fixture.calls).toHaveLength(1);
    expect(reservationCount()).toBe(1);

    const newTask = await createTask(fixture, {
      key: "new-after-release-revoke",
      plan_id: PLAN_ID,
      input: request.input,
    });
    expect(newTask.response.status).toBe(410);
    expect(newTask.body.code).toBe("SKILL_RELEASE_REVOKED");
    expect(fixture.calls).toHaveLength(1);
    expect(reservationCount()).toBe(1);
  });

  it("replays the exact task before a disabled feature policy while a new key is denied", async () => {
    const fixture = await createFixture();
    const reservationCount = trackReservations(fixture);
    const request = {
      key: "replay-after-policy-disable",
      plan_id: PLAN_ID,
      input: { text: "policy replay" },
    } as const;

    const created = await createTask(fixture, request);
    expect(created.response.status).toBe(201);
    expect(await waitForTerminal(fixture, created.body.task_id)).toMatchObject({ status: "succeeded" });
    await fixture.store.upsertFeaturePolicy(disabledSkillExecutionPolicy());

    const replayed = await createTask(fixture, request);
    expect(replayed.response.status).toBe(200);
    expect(replayed.body).toMatchObject({ task_id: created.body.task_id, status: "succeeded" });
    expect(fixture.calls).toHaveLength(1);
    expect(reservationCount()).toBe(1);

    const newTask = await createTask(fixture, {
      key: "new-after-policy-disable",
      plan_id: PLAN_ID,
      input: request.input,
    });
    expect(newTask.response.status).toBe(403);
    expect(newTask.body.code).toBe("FEATURE_DISABLED");
    expect(fixture.calls).toHaveLength(1);
    expect(reservationCount()).toBe(1);
  });

  it("fails closed for a strict production Skill with no commercial plan", async () => {
    const fixture = await createFixture();
    let createCount = 0;
    const create = fixture.store.createTask.bind(fixture.store);
    fixture.store.createTask = async (...args) => {
      createCount += 1;
      return create(...args);
    };

    const key = "strict-no-plan-rejected";
    const rejected = await createTask(fixture, {
      key,
      skill_id: "longhub.skill.not-in-any-plan",
      input: { text: "must not execute" },
    });
    expect(rejected.response.status).toBe(403);
    expect(rejected.body.code).toBe("CLOUD_SKILL_SUBSCRIPTION_REQUIRED");
    expect(createCount).toBe(0);
    expect(fixture.calls).toHaveLength(0);
    expect(await fixture.store.findTaskByIdempotency(key, {
      tenant_id: "tenant-default",
      device_id: fixture.deviceId,
      agent_id: "agent-main",
    })).toBeUndefined();
  });

  it("rejects a candidate plan without a matching subscription before execution", async () => {
    const fixture = await createFixture();
    await fixture.store.createCloudSkillPlan({
      plan_id: OTHER_PLAN_ID,
      name: "Other plan",
      skill_ids: [SKILL_ID],
      price_monthly_fen: 1,
      price_yearly_fen: 1,
    });
    const rejected = await createTask(fixture, { key: "plan-mismatch", plan_id: OTHER_PLAN_ID });
    expect(rejected.response.status).toBe(403);
    expect(rejected.body.code).toBe("CLOUD_SKILL_SUBSCRIPTION_REQUIRED");
    expect(fixture.calls).toHaveLength(0);

    const direct = await fixture.store.reserveCloudSkillExecution({
      task_id: "direct-plan-mismatch",
      user_id: fixture.userId,
      tenant_id: "tenant-default",
      device_id: fixture.deviceId,
      agent_id: "agent-main",
      skill_id: SKILL_ID,
      plan_id: OTHER_PLAN_ID,
    });
    expect(direct).toEqual({ ok: false, reason: "PLAN_MISMATCH" });

    fixture.store.reserveCloudSkillExecution = async () => ({ ok: false, reason: "PLAN_MISMATCH" });
    const mapped = await createTask(fixture, { key: "plan-mismatch-mapped" });
    expect(mapped.response.status).toBe(403);
    expect(mapped.body).toMatchObject({ code: "CLOUD_SKILL_PLAN_MISMATCH", retryable: false });
    expect(fixture.calls).toHaveLength(0);
  });

  it("rejects revoked and incompatible releases before creating an executor call", async () => {
    const revokedFixture = await createFixture();
    await revokedFixture.store.revokeCloudSkillAdapterRelease(SKILL_ID, SKILL_VERSION);
    const revoked = await createTask(revokedFixture, { key: "release-revoked" });
    expect(revoked.response.status).toBe(410);
    expect(revoked.body.code).toBe("SKILL_RELEASE_REVOKED");
    expect(revokedFixture.calls).toHaveLength(0);

    const incompatibleFixture = await createFixture({ release_openclaw_version: "2026.8.0" });
    const incompatible = await createTask(incompatibleFixture, {
      key: "release-incompatible",
      openclaw_version: OPENCLAW_VERSION,
    });
    expect(incompatible.response.status).toBe(422);
    expect(incompatible.body.code).toBe("SKILL_INCOMPATIBLE");
    expect(incompatibleFixture.calls).toHaveLength(0);
  });

  it("maps quota, rate and concurrency admission states with stable Retry-After semantics", async () => {
    const quotaFixture = await createFixture({ included_calls: 1, max_concurrency: 2 });
    const firstQuota = await createTask(quotaFixture, { key: "quota-first" });
    expect(firstQuota.response.status).toBe(201);
    await waitForTerminal(quotaFixture, firstQuota.body.task_id);
    const quota = await createTask(quotaFixture, { key: "quota-second" });
    expect(quota.response.status).toBe(403);
    expect(quota.body).toMatchObject({ code: "CLOUD_SKILL_QUOTA_EXCEEDED", retryable: false });
    expect(quota.response.headers.get("retry-after")).toBeNull();
    expect(await quotaFixture.store.getTask("ct-2")).toBeUndefined();

    const rateFixture = await createFixture({ requests_per_minute: 1, max_concurrency: 2 });
    const firstRate = await createTask(rateFixture, { key: "rate-first" });
    expect(firstRate.response.status).toBe(201);
    await waitForTerminal(rateFixture, firstRate.body.task_id);
    const rate = await createTask(rateFixture, { key: "rate-second" });
    expect(rate.response.status).toBe(429);
    expect(rate.body).toMatchObject({ code: "CLOUD_SKILL_RATE_LIMITED", retryable: true });
    expect(Number(rate.response.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await rateFixture.store.getTask("ct-2")).toBeUndefined();

    const concurrencyFixture = await createFixture({ max_concurrency: 1, executor_mode: "hold" });
    const firstConcurrency = await createTask(concurrencyFixture, { key: "concurrency-first" });
    expect(firstConcurrency.response.status).toBe(201);
    await concurrencyFixture.waitForCall();
    const concurrency = await createTask(concurrencyFixture, { key: "concurrency-second" });
    expect(concurrency.response.status).toBe(429);
    expect(concurrency.body).toMatchObject({ code: "CLOUD_SKILL_CONCURRENCY_LIMIT", retryable: true });
    expect(Number(concurrency.response.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await concurrencyFixture.store.getTask("ct-2")).toBeUndefined();
    const cancelled = await fetch(`${concurrencyFixture.baseUrl}/v1/tasks/${firstConcurrency.body.task_id}/cancel`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${concurrencyFixture.deviceToken}`,
        "x-longhub-agent-id": "agent-main",
      },
    });
    expect(cancelled.status).toBe(202);
    await concurrencyFixture.waitForCall();
    concurrencyFixture.finishNext();
    await waitForTerminal(concurrencyFixture, firstConcurrency.body.task_id);
  });

  it("fails closed and discards unadmitted input when the reservation store is unavailable", async () => {
    const fixture = await createFixture();
    fixture.store.reserveCloudSkillExecution = async () => {
      throw new Error("database unavailable");
    };
    const rejected = await createTask(fixture, { key: "reservation-storage-error" });
    expect(rejected.response.status).toBe(503);
    expect(rejected.body).toMatchObject({ code: "CLOUD_SKILL_USAGE_UNAVAILABLE", retryable: true });
    expect(fixture.calls).toHaveLength(0);
    expect(await fixture.store.getTask("ct-1")).toBeUndefined();
  });

  it("never retains full input when cancellation races a rejected reservation", async () => {
    const fixture = await createFixture();
    const originalCreate = fixture.store.createTask.bind(fixture.store);
    let createdTaskId: string | undefined;
    let notifyCreated!: () => void;
    const taskCreated = new Promise<void>((resolve) => { notifyCreated = resolve; });
    fixture.store.createTask = async (...args) => {
      const result = await originalCreate(...args);
      createdTaskId = result.task.task_id;
      notifyCreated();
      return result;
    };

    let rejectReservation!: () => void;
    const reservationGate = new Promise<void>((resolve) => { rejectReservation = resolve; });
    let notifyReservation!: () => void;
    const reservationStarted = new Promise<void>((resolve) => { notifyReservation = resolve; });
    fixture.store.reserveCloudSkillExecution = async () => {
      notifyReservation();
      await reservationGate;
      return { ok: false, reason: "CONCURRENCY_LIMIT", retry_after_seconds: 1 };
    };

    const sensitiveInput = { text: "private-before-admission" };
    const request = createTask(fixture, { key: "reservation-cancel-race", input: sensitiveInput });
    await taskCreated;
    await reservationStarted;
    const taskId = createdTaskId!;
    const staged = await fixture.store.getTask(taskId);
    expect(isCloudTaskAdmissionPlaceholder(staged?.input)).toBe(true);
    expect(JSON.stringify(staged)).not.toContain(sensitiveInput.text);

    const cancelled = await fetch(`${fixture.baseUrl}/v1/tasks/${taskId}/cancel`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.deviceToken}`,
        "x-longhub-agent-id": "agent-main",
      },
    });
    expect(cancelled.status).toBe(202);
    rejectReservation();

    const rejected = await request;
    expect(rejected.response.status).toBe(429);
    expect(rejected.body.code).toBe("CLOUD_SKILL_CONCURRENCY_LIMIT");
    const retained = await fixture.store.getTask(taskId);
    expect(retained?.status).toBe("cancelled");
    expect(isCloudTaskAdmissionPlaceholder(retained?.input)).toBe(true);
    expect(JSON.stringify(retained)).not.toContain(sensitiveInput.text);
    expect(fixture.calls).toHaveLength(0);
  });

  it("admits and executes only once when exact retries race during reservation", async () => {
    const fixture = await createFixture();
    const reserve = fixture.store.reserveCloudSkillExecution.bind(fixture.store);
    let reservationCalls = 0;
    let notifyFirst!: () => void;
    let notifyBoth!: () => void;
    const firstReservation = new Promise<void>((resolve) => { notifyFirst = resolve; });
    const bothReservations = new Promise<void>((resolve) => { notifyBoth = resolve; });
    let releaseReservations!: () => void;
    const gate = new Promise<void>((resolve) => { releaseReservations = resolve; });
    fixture.store.reserveCloudSkillExecution = async (params) => {
      reservationCalls += 1;
      if (reservationCalls === 1) notifyFirst();
      if (reservationCalls === 2) notifyBoth();
      await gate;
      return reserve(params);
    };

    const options = { key: "concurrent-exact-admission", input: { text: "one execution" } };
    const first = createTask(fixture, options);
    await firstReservation;
    const second = createTask(fixture, options);
    await bothReservations;
    releaseReservations();

    const responses = await Promise.all([first, second]);
    expect(responses.map(({ response }) => response.status).sort()).toEqual([200, 201]);
    expect(new Set(responses.map(({ body }) => body.task_id))).toHaveLength(1);
    expect(reservationCalls).toBe(2);
    expect(await waitForTerminal(fixture, responses[0]!.body.task_id)).toMatchObject({ status: "succeeded" });
    expect(fixture.calls).toHaveLength(1);
  });

  it("does not admit staged input through a released reservation replay", async () => {
    const fixture = await createFixture();
    const reserve = fixture.store.reserveCloudSkillExecution.bind(fixture.store);
    fixture.store.reserveCloudSkillExecution = async (params) => {
      const result = await reserve(params);
      if (!result.ok) return result;
      return {
        ok: true,
        reservation: { ...result.reservation, released_at: new Date().toISOString() },
      };
    };

    const sensitiveInput = { text: "must not pass an expired lease" };
    const rejected = await createTask(fixture, { key: "released-reservation-replay", input: sensitiveInput });
    expect(rejected.response.status).toBe(503);
    expect(rejected.body).toMatchObject({ code: "CLOUD_SKILL_USAGE_UNAVAILABLE", retryable: true });
    expect(await fixture.store.getTask("ct-1")).toBeUndefined();
    expect(fixture.calls).toHaveLength(0);
  });

  it("releases the concurrency lease when a task is cancelled", async () => {
    const fixture = await createFixture({ max_concurrency: 1, executor_mode: "hold" });
    const first = await createTask(fixture, { key: "cancel-lease-first" });
    expect(first.response.status).toBe(201);
    await fixture.waitForCall();
    const blocked = await createTask(fixture, { key: "cancel-lease-blocked" });
    expect(blocked.response.status).toBe(429);
    expect(blocked.body.code).toBe("CLOUD_SKILL_CONCURRENCY_LIMIT");

    const cancelled = await fetch(`${fixture.baseUrl}/v1/tasks/${first.body.task_id}/cancel`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.deviceToken}`,
        "x-longhub-agent-id": "agent-main",
      },
    });
    expect(cancelled.status).toBe(202);
    expect((await cancelled.json()).status).toBe("cancelled");
    fixture.finishNext();
    await waitForTerminal(fixture, first.body.task_id);

    const admitted = await createTask(fixture, { key: "cancel-lease-after" });
    expect(admitted.response.status).toBe(201);
    await fixture.waitForCall(2);
    fixture.finishNext();
  });

  it("releases the concurrency lease after executor timeout", async () => {
    const fixture = await createFixture({ max_concurrency: 1, executor_mode: "never", executor_timeout_ms: 60 });
    const first = await createTask(fixture, { key: "timeout-lease-first" });
    expect(first.response.status).toBe(201);
    await fixture.waitForCall();
    const timedOut = await waitForTerminal(fixture, first.body.task_id, 1_500);
    expect(timedOut).toMatchObject({ status: "timed_out", error: { code: "EXECUTION_TIMEOUT" } });

    const admitted = await createTask(fixture, { key: "timeout-lease-after" });
    expect(admitted.response.status).toBe(201);
    const terminal = await waitForTerminal(fixture, admitted.body.task_id, 1_500);
    expect(terminal.status).toBe("timed_out");
  }, 5_000);
});
