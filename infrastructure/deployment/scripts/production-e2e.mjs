#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  verifyCloudSkillAdapterFileDigests,
  verifyCloudSkillAdapterSignature,
} from "../../../packages/longhub-cloud-skill-adapter/dist/index.js";
import { PgStore } from "../../../apps/longhub-cloud-api/dist/pg-store.js";

const PLAN_ID = "longhub.salary-band.standard";
const SKILL_ID = "longhub.skill.salary-band";
const ACTIVE_VERSION = "1.0.0";
const REVOKED_VERSION = "1.0.1";
const OPENCLAW_VERSION = "2026.7.1-2";
const AGENT_ID = "agent-production-validation";
const SESSION_KEY_HASH = "a".repeat(64);
const CLOUD_ENVIRONMENT = "/etc/longhub/cloud-api.env";

function usage() {
  process.stderr.write(
    "usage: production-e2e.mjs https://LONGHUB_HOST [--exercise-runtime-cancel]\n",
  );
  process.exit(2);
}

if (process.getuid?.() !== 0) {
  throw new Error("production E2E must run as root to read deployment credentials");
}
if (process.argv.length < 3 || process.argv.length > 4) usage();
const baseUrl = process.argv[2].replace(/\/$/u, "");
const exerciseRuntimeCancel = process.argv[3] === "--exercise-runtime-cancel";
if (process.argv[3] && !exerciseRuntimeCancel) usage();
const origin = new URL(baseUrl);
if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash) {
  throw new Error("production E2E URL must be an HTTPS origin");
}

async function readEnvironment(path) {
  const environment = {};
  const lines = (await readFile(path, "utf8")).split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*(?:#.*)?$/u.test(line)) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match) throw new Error(`invalid environment record in ${path}:${index + 1}`);
    const [, name, encoded] = match;
    if (Object.hasOwn(environment, name)) throw new Error(`duplicate ${name} in ${path}`);
    let value = encoded;
    if (value.startsWith("'")) {
      if (value.length < 2 || !value.endsWith("'") || value.slice(1, -1).includes("'")) {
        throw new Error(`unsupported quoted value for ${name} in ${path}`);
      }
      value = value.slice(1, -1);
    } else if (/\s/u.test(value) || value.startsWith('"')) {
      throw new Error(`unsupported value syntax for ${name} in ${path}`);
    }
    environment[name] = value;
  }
  return Object.freeze(environment);
}

async function responseBody(response) {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function request(path, {
  method = "GET",
  token,
  body,
  headers = {},
  expected = 200,
  timeoutMs = 15_000,
} = {}) {
  const requestHeaders = { ...headers };
  if (token) requestHeaders.authorization = `Bearer ${token}`;
  if (body !== undefined) requestHeaders["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const parsed = await responseBody(response);
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(response.status)) {
    const code = parsed && typeof parsed === "object" ? parsed.code : undefined;
    throw new Error(`${method} ${path} returned ${response.status}${code ? ` (${code})` : ""}`);
  }
  return { status: response.status, headers: response.headers, body: parsed };
}

function adapterPayload(version) {
  const contents = {
    "SKILL.md": [
      "---",
      "name: salary-band",
      "description: Official salary band classification",
      "---",
      "",
      "This file is a thin declaration only. Runtime execution stays in LongHub Cloud.",
      "",
    ].join("\n"),
    "schemas/input.json": JSON.stringify({
      type: "object",
      properties: { level: { type: "integer", minimum: 1, maximum: 10 } },
      required: ["level"],
      additionalProperties: false,
    }),
    "schemas/output.json": JSON.stringify({
      type: "object",
      properties: {
        level: { type: "integer" },
        min: { type: "integer" },
        max: { type: "integer" },
        currency: { type: "string" },
      },
      required: ["level", "min", "max", "currency"],
      additionalProperties: false,
    }),
  };
  const files = Object.fromEntries(Object.entries(contents).map(([path, content]) => [
    path,
    Buffer.from(content, "utf8").toString("base64"),
  ]));
  const manifestFiles = Object.entries(contents).map(([path, content]) => ({
    path,
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    size: Buffer.byteLength(content),
  }));
  return {
    manifest: {
      schema_version: "longhub/cloud-skill-adapter/v1",
      skill_id: SKILL_ID,
      version,
      display: {
        name: "Salary band",
        description: "Classifies an approved salary level into a CNY range.",
        category: "business",
      },
      service: {
        service_id: "longhub.cloud.salary-band",
        api_version: "1.0",
        entry: "local-longhub-bridge",
      },
      schemas: { input: "schemas/input.json", output: "schemas/output.json" },
      files: manifestFiles,
      subscription: { plan_ids: [PLAN_ID] },
      permissions: { requested: ["salary.read"], confirmation_class: "none" },
      compatibility: { manager_min_version: "0.1.0", openclaw_version: OPENCLAW_VERSION },
      integrity: {
        algorithm: "sha256",
        digest: "0".repeat(64),
        signature_key_id: "server-owned",
        signature: `${"A".repeat(86)}==`,
      },
    },
    files,
  };
}

async function publishAdapter(adminToken, version) {
  const published = await request("/v1/admin/cloud-skill-adapters", {
    method: "POST",
    token: adminToken,
    body: adapterPayload(version),
    expected: [201, 409],
  });
  if (published.status === 201) {
    assert.equal(published.body.skill_id, SKILL_ID);
    assert.equal(published.body.version, version);
    assert.equal(published.body.signature_key_id, "cloud-skill-2026-08");
    return;
  }
  const listed = await request(`/v1/admin/cloud-skill-adapters?skill_id=${encodeURIComponent(SKILL_ID)}`, {
    token: adminToken,
  });
  assert(listed.body.releases.some((release) =>
    release.version === version && release.signature_key_id === "cloud-skill-2026-08"));
}

function taskBody(key, level = 3) {
  return {
    schema_version: "longhub/cloud-skill-call/v1",
    request_id: `request-${key}`,
    kind: "skill.execute",
    skill_id: SKILL_ID,
    skill_version: ACTIVE_VERSION,
    agent_id: AGENT_ID,
    tool_call_id: `tool-${key}`,
    session_key_hash: SESSION_KEY_HASH,
    idempotency_key: key,
    plan_id: PLAN_ID,
    input: { level },
  };
}

async function createTask(deviceToken, key, level = 3, expected = 201) {
  return request("/v1/tasks", {
    method: "POST",
    token: deviceToken,
    headers: {
      "idempotency-key": key,
      "x-longhub-openclaw-version": OPENCLAW_VERSION,
    },
    body: taskBody(key, level),
    expected,
  });
}

async function waitForTerminal(deviceToken, taskId, expectedStatus) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await request(`/v1/tasks/${taskId}`, {
      token: deviceToken,
      headers: { "x-longhub-agent-id": AGENT_ID },
    });
    if (["succeeded", "failed", "cancelled", "timed_out"].includes(result.body.status)) {
      if (expectedStatus) assert.equal(result.body.status, expectedStatus);
      return result.body;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`task ${taskId} did not reach a terminal state`);
}

const cloudEnvironment = await readEnvironment(CLOUD_ENVIRONMENT);
assert(cloudEnvironment.DATABASE_URL);
assert(cloudEnvironment.ADMIN_TOKEN);
assert.equal(origin.hostname, new URL(cloudEnvironment.CORS_ALLOW_ORIGINS).hostname);

await request("/v1/admin/metrics", { expected: 401 });
const adminToken = cloudEnvironment.ADMIN_TOKEN;
await request("/v1/admin/metrics", { token: adminToken });

// A terminated validation run must not leave reusable account or device
// credentials behind. Cleanup is intentionally limited to this script's
// fixed identity prefixes and is audited before a new run starts.
const cleanupStore = new PgStore(cloudEnvironment.DATABASE_URL);
try {
  await cleanupStore.init();
  const staleUsers = (await cleanupStore.listUsers()).filter((user) =>
    user.email.startsWith("deployment-validation-") && user.email.endsWith("@example.test"));
  const staleUserIds = new Set(staleUsers.map((user) => user.user_id));
  for (const user of staleUsers) {
    for (const subscription of await cleanupStore.listCloudSkillSubscriptions(user.user_id)) {
      if (subscription.status === "active") {
        await cleanupStore.updateCloudSkillSubscriptionStatus(subscription.subscription_id, "cancelled");
      }
    }
    if (user.status === "active") await cleanupStore.setUserStatus(user.user_id, "disabled");
  }
  const staleDevices = (await cleanupStore.listDevices()).filter((device) =>
    device.device_fingerprint.startsWith("production-e2e-") ||
      (device.user_id !== undefined && staleUserIds.has(device.user_id)));
  for (const device of staleDevices) {
    if (device.status === "active") {
      await cleanupStore.updateDeviceOperations(device.device_id, { status: "revoked" });
    }
  }
  if (staleUsers.length > 0 || staleDevices.length > 0) {
    await cleanupStore.appendAudit("deployment-e2e", "deployment_validation.stale_identity_cleanup", {
      users: staleUsers.length,
      devices: staleDevices.length,
    });
  }
} finally {
  await cleanupStore.close();
}

const planPayload = {
  plan_id: PLAN_ID,
  name: "Salary band standard",
  description: "Production Cloud Skill access for salary band classification.",
  skill_ids: [SKILL_ID],
  price_monthly_fen: 990,
  price_yearly_fen: 9_900,
  included_calls: 1_000,
  requests_per_minute: 120,
  max_concurrency: 4,
  status: "listed",
};
const planCreate = await request("/v1/admin/cloud-skill-plans", {
  method: "POST",
  token: adminToken,
  body: planPayload,
  expected: [201, 409],
});
if (planCreate.status === 409) {
  await request(`/v1/admin/cloud-skill-plans/${PLAN_ID}`, {
    method: "POST",
    token: adminToken,
    body: planPayload,
  });
}

await publishAdapter(adminToken, ACTIVE_VERSION);
await publishAdapter(adminToken, REVOKED_VERSION);

const publicPlans = await request("/v1/cloud-skill-plans");
assert(publicPlans.body.plans.some((plan) =>
  plan.plan_id === PLAN_ID && plan.status === "listed" && plan.skill_ids.includes(SKILL_ID)));

const runId = `${Date.now()}-${randomBytes(5).toString("hex")}`;
const accountPassword = `Lh!9${randomBytes(24).toString("hex")}`;
const email = `deployment-validation-${runId}@example.test`;
const device = (await request("/v1/devices/register", {
  method: "POST",
  body: {
    platform: "openclaw-plugin-windows",
    app_version: "0.1.0",
    device_fingerprint: `production-e2e-${runId}`,
    display_name: "Production deployment validation",
  },
  expected: 201,
})).body;
const foreignDevice = (await request("/v1/devices/register", {
  method: "POST",
  body: {
    platform: "openclaw-plugin-windows",
    app_version: "0.1.0",
    device_fingerprint: `production-e2e-foreign-${runId}`,
  },
  expected: 201,
})).body;
const legacyManagerDevice = (await request("/v1/devices/register", {
  method: "POST",
  body: {
    platform: "windows",
    app_version: "0.1.1",
    device_fingerprint: `production-e2e-manager-${runId}`,
    display_name: "Production legacy Manager boundary validation",
  },
  expected: 201,
})).body;

const legacyManagerTask = await createTask(
  legacyManagerDevice.device_token,
  `production-e2e-manager-rejected-${runId}`,
  3,
  403,
);
assert.equal(legacyManagerTask.body.code, "CLOUD_PLUGIN_DEVICE_REQUIRED");

const registered = await request("/v1/auth/register", {
  method: "POST",
  body: { email, password: accountPassword },
  expected: 201,
});
const userId = registered.body.user.user_id;
const userLogin = await request("/v1/auth/login", {
  method: "POST",
  body: { email, password: accountPassword },
});
const userToken = userLogin.body.token;
assert.equal(userLogin.body.user.user_id, userId);

const challenge = await request("/v1/devices/pairing/challenge", {
  method: "POST",
  token: device.device_token,
  body: {},
  expected: 201,
});
const pairingCode = challenge.body.pairing_code;
const formattedPairingCode = [pairingCode.slice(0, 4), pairingCode.slice(4, 8), pairingCode.slice(8)]
  .join("-")
  .toLowerCase();
const paired = await request("/v1/me/devices/pair", {
  method: "POST",
  token: userToken,
  body: { pairing_code: formattedPairingCode },
});
assert.equal(paired.body.device.device_id, device.device_id);
assert(!Object.hasOwn(paired.body.device, "device_token"));
await request("/v1/me/devices/pair", {
  method: "POST",
  token: userToken,
  body: { pairing_code: pairingCode },
  expected: 422,
});

// The production schema intentionally ties every subscription to an order.
// This pending order proves the public purchase boundary without pretending a
// provider payment occurred; the operator-only validation grant is cancelled
// before the script exits.
const validationOrder = await request("/v1/orders", {
  method: "POST",
  token: userToken,
  body: {
    type: "cloud_skill_plan",
    plan_id: PLAN_ID,
    tenant_id: device.tenant_id,
    period: "monthly",
  },
  expected: 201,
});
assert.equal(validationOrder.body.status, "pending");

const store = new PgStore(cloudEnvironment.DATABASE_URL);
let subscription;
try {
  await store.init();
  const storedUser = await store.getUserByEmail(email);
  const storedDevice = await store.getDevice(device.device_id);
  assert.equal(storedUser?.user_id, userId);
  assert.equal(storedDevice?.user_id, userId);
  const now = Date.now();
  ({ subscription } = await store.createCloudSkillSubscription({
    user_id: userId,
    tenant_id: device.tenant_id,
    plan_id: PLAN_ID,
    period: "monthly",
    starts_at: new Date(now - 60_000).toISOString(),
    expires_at: new Date(now + 30 * 24 * 60 * 60_000).toISOString(),
    source_order_id: validationOrder.body.order_id,
  }));
  await store.grantCloudSkillEntitlement({
    subscription_id: subscription.subscription_id,
    skill_id: SKILL_ID,
    plan_id: PLAN_ID,
  });
} finally {
  await store.close();
}

const subscriptions = await request("/v1/me/cloud-skill-subscriptions", { token: userToken });
assert(subscriptions.body.subscriptions.some((entry) =>
  entry.subscription_id === subscription.subscription_id && entry.status === "active"));
const entitlements = await request("/v1/me/cloud-skill-entitlements", { token: userToken });
assert(entitlements.body.entitlements.some((entry) =>
  entry.subscription_id === subscription.subscription_id && entry.status === "active"));

await request("/v1/admin/cloud-skill-plans", { token: userToken, expected: 401 });
await request(`/v1/skills/${SKILL_ID}/adapter?openclaw_version=${encodeURIComponent(OPENCLAW_VERSION)}`, {
  token: foreignDevice.device_token,
  expected: 403,
});

const bindingResponse = await request("/v1/cloud-skill/bindings", {
  method: "POST",
  token: device.device_token,
  body: { agent_id: AGENT_ID, skill_id: SKILL_ID },
  expected: 201,
});
const bindingId = bindingResponse.body.binding.binding_id;
const catalog = await request(`/v1/catalog/skills?openclaw_version=${encodeURIComponent(OPENCLAW_VERSION)}`, {
  token: device.device_token,
});
assert(catalog.body.skills.some((skill) =>
  skill.skill_id === SKILL_ID && skill.adapter_available === true && skill.entitled === true));

const download = await request(
  `/v1/skills/${SKILL_ID}/adapter?version=${ACTIVE_VERSION}&openclaw_version=${encodeURIComponent(OPENCLAW_VERSION)}`,
  { token: device.device_token },
);
assert.equal(download.headers.get("cache-control"), "no-store");
const signingKey = await request("/v1/skills/adapters/signing-key");
assert.equal(signingKey.body.key_id, "cloud-skill-2026-08");
assert(verifyCloudSkillAdapterSignature(download.body.adapter.manifest, signingKey.body.public_key_pem));
assert(verifyCloudSkillAdapterFileDigests(
  download.body.adapter.manifest,
  new Map(Object.entries(download.body.adapter.files).map(([path, encoded]) => [
    path,
    Buffer.from(encoded, "base64"),
  ])),
));

const firstKey = `production-e2e-success-${runId}`;
const firstTask = await createTask(device.device_token, firstKey);
const taskId = firstTask.body.task_id;
const terminal = await waitForTerminal(device.device_token, taskId, "succeeded");
assert.deepEqual(terminal.output, { level: 3, min: 20_000, max: 32_000, currency: "CNY" });

const replay = await createTask(device.device_token, firstKey, 3, 200);
assert.equal(replay.body.task_id, taskId);
assert.equal(replay.body.status, "succeeded");
await createTask(device.device_token, firstKey, 4, 409);

await request(`/v1/tasks/${taskId}`, {
  token: foreignDevice.device_token,
  headers: { "x-longhub-agent-id": AGENT_ID },
  expected: 404,
});
await request(`/v1/cloud-skill/bindings/${bindingId}`, {
  method: "DELETE",
  token: foreignDevice.device_token,
  expected: 404,
});

const revokeAdapter = await request(`/v1/admin/cloud-skill-adapters/${SKILL_ID}/${REVOKED_VERSION}/revoke`, {
  method: "POST",
  token: adminToken,
  expected: [202, 404],
});
if (revokeAdapter.status === 404) {
  const releases = await request(`/v1/admin/cloud-skill-adapters?skill_id=${encodeURIComponent(SKILL_ID)}`, {
    token: adminToken,
  });
  assert(releases.body.releases.some((release) =>
    release.version === REVOKED_VERSION && release.status === "revoked"));
}
await request(
  `/v1/skills/${SKILL_ID}/adapter?version=${REVOKED_VERSION}&openclaw_version=${encodeURIComponent(OPENCLAW_VERSION)}`,
  { token: device.device_token, expected: 410 },
);

const revokedBinding = await request(`/v1/cloud-skill/bindings/${bindingId}`, {
  method: "DELETE",
  token: device.device_token,
});
assert.equal(revokedBinding.body.binding.status, "revoked");
const replayAfterRevoke = await createTask(device.device_token, firstKey, 3, 200);
assert.equal(replayAfterRevoke.body.task_id, taskId);
const blockedAfterRevoke = await createTask(
  device.device_token,
  `production-e2e-binding-revoked-${runId}`,
  3,
  403,
);
assert.equal(blockedAfterRevoke.body.code, "AGENT_SKILL_BINDING_REQUIRED");
const reactivated = await request("/v1/cloud-skill/bindings", {
  method: "POST",
  token: device.device_token,
  body: { agent_id: AGENT_ID, skill_id: SKILL_ID },
  expected: 200,
});
assert.equal(reactivated.body.binding.binding_id, bindingId);
assert.equal(reactivated.body.binding.status, "active");

if (exerciseRuntimeCancel) {
  let executorStopped = false;
  try {
    execFileSync("systemctl", [
      "kill",
      "--kill-who=main",
      "--signal=STOP",
      "longhub-executor.service",
    ], { stdio: "ignore" });
    executorStopped = true;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const cancelKey = `production-e2e-cancel-${runId}`;
    const pending = await createTask(device.device_token, cancelKey);
    const cancelled = await request(`/v1/tasks/${pending.body.task_id}/cancel`, {
      method: "POST",
      token: device.device_token,
      headers: { "x-longhub-agent-id": AGENT_ID },
      body: {},
      expected: 202,
    });
    assert.equal(cancelled.body.status, "cancelled");
    await waitForTerminal(device.device_token, pending.body.task_id, "cancelled");
  } finally {
    if (executorStopped) {
      execFileSync("systemctl", [
        "kill",
        "--kill-who=main",
        "--signal=CONT",
        "longhub-executor.service",
      ], { stdio: "ignore" });
    }
  }
}

const metrics = await request("/v1/admin/metrics", { token: adminToken });
assert.deepEqual(Object.keys(metrics.body.operations.billing_outbox).sort(), [
  "dead_lettered",
  "in_flight",
  "pending",
  "published",
  "retry_waiting",
]);
const skillMetric = metrics.body.operations.cloud_skills.skills.find((entry) =>
  entry.plan_id === PLAN_ID && entry.skill_id === SKILL_ID);
assert(skillMetric);
assert(skillMetric.calls >= 2);
assert(skillMetric.succeeded >= 1);
assert(skillMetric.active_subscriptions >= 1);
assert.equal(skillMetric.included_calls_per_subscription, 1_000);
const operationalJson = JSON.stringify({
  billing_outbox: metrics.body.operations.billing_outbox,
  cloud_skills: metrics.body.operations.cloud_skills,
});
for (const forbidden of [
  "user_id",
  "tenant_id",
  "device_id",
  "agent_id",
  "task_id",
  "payload",
  "provider_reference",
  "last_error",
]) {
  assert(!operationalJson.includes(`\"${forbidden}\"`));
}

const cancelledSubscription = await request(
  `/v1/me/cloud-skill-subscriptions/${subscription.subscription_id}/cancel`,
  { method: "POST", token: userToken, body: {} },
);
assert.equal(cancelledSubscription.body.status, "cancelled");
const blockedAfterCancellation = await createTask(
  device.device_token,
  `production-e2e-subscription-cancelled-${runId}`,
  3,
  403,
);
assert.equal(blockedAfterCancellation.body.code, "CLOUD_SKILL_SUBSCRIPTION_REQUIRED");

await request(`/v1/admin/devices/${foreignDevice.device_id}`, {
  method: "POST",
  token: adminToken,
  body: { status: "revoked" },
});
await request(`/v1/admin/devices/${legacyManagerDevice.device_id}`, {
  method: "POST",
  token: adminToken,
  body: { status: "revoked" },
});
await request(`/v1/admin/devices/${device.device_id}`, {
  method: "POST",
  token: adminToken,
  body: { status: "revoked" },
});
await request(`/v1/admin/users/${userId}/status`, {
  method: "POST",
  token: adminToken,
  body: { status: "disabled" },
});
await request("/v1/me", { token: userToken, expected: [401, 403] });
await request("/v1/private-skills/registry.js", { expected: 404 });

process.stdout.write([
  "LongHub production E2E: OK",
  "static admin authorization, account login and one-time device pairing: OK",
  "listed plan and active signed adapter distribution: OK",
  "legacy Manager device task boundary: OK",
  "private Executor task, exact replay and conflict rejection: OK",
  "cross-device, binding revoke and adapter revoke boundaries: OK",
  exerciseRuntimeCancel ? "runtime cancellation with paused Executor: OK" : "runtime cancellation exercise: skipped",
  "anonymous Cloud Skill and billing outbox metrics: OK",
  "subscription cancellation and validation identity shutdown: OK",
].join("\n") + "\n");
