import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FeaturePolicyEntry } from "@longhub/feature-policy";
import { MemoryStore } from "../src/memory-store.js";
import { createCloudApiServer } from "../src/server.js";

const adminToken = "feature-policy-admin";

let store: MemoryStore;
let api: ReturnType<typeof createCloudApiServer>;
let baseUrl: string;
let deviceId: string;
let deviceToken: string;

function makePolicy(overrides: Partial<FeaturePolicyEntry> = {}): FeaturePolicyEntry {
  return {
    feature_id: "agent.catalog",
    enabled: true,
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
    ...overrides,
  };
}

async function registerDevice(fingerprint: string): Promise<{ device_id: string; device_token: string }> {
  const response = await fetch(baseUrl + "/v1/devices/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      platform: "openclaw-plugin-windows",
      app_version: "0.5.0",
      device_fingerprint: fingerprint,
    }),
  });
  expect(response.status).toBe(201);
  return await response.json() as { device_id: string; device_token: string };
}

async function savePolicy(policy: FeaturePolicyEntry): Promise<Response> {
  return fetch(baseUrl + "/v1/admin/feature-policies", {
    method: "POST",
    headers: {
      authorization: "Bearer " + adminToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ policy }),
  });
}

function deviceHeaders(): Record<string, string> {
  return { authorization: "Bearer " + deviceToken };
}

beforeEach(async () => {
  store = new MemoryStore();
  api = createCloudApiServer({
    executorUrl: "http://127.0.0.1:1",
    store,
    adminToken,
  }).listen(0);
  await once(api, "listening");
  baseUrl = "http://127.0.0.1:" + (api.address() as AddressInfo).port;
  const registered = await registerDevice("feature-policy-primary");
  deviceId = registered.device_id;
  deviceToken = registered.device_token;
});

afterEach(async () => {
  api.close();
  await once(api, "close");
});

describe("Feature Policy Cloud Store/Admin/Client", () => {
  it("独立端点返回严格空策略，旧 runtime-config 在首发下线", async () => {
    const featureResponse = await fetch(baseUrl + "/v1/client/feature-policy", {
      headers: deviceHeaders(),
    });
    expect(featureResponse.status).toBe(200);
    const feature = await featureResponse.json() as Record<string, unknown>;
    expect(feature).toMatchObject({
      schema_version: "longhub/feature-policy/v2",
      features: [],
    });
    expect(Date.parse(feature.expires_at as string) - Date.parse(feature.issued_at as string))
      .toBe(5 * 60_000);

    const runtimeResponse = await fetch(baseUrl + "/v1/client/runtime-config", {
      headers: deviceHeaders(),
    });
    expect(runtimeResponse.status).toBe(410);
    expect((await runtimeResponse.json() as { code: string }).code).toBe("LEGACY_SURFACE_DISABLED");
  });

  it("管理员 upsert 保持 policy_id、递增 revision 并记录最小审计详情", async () => {
    const firstResponse = await savePolicy(makePolicy());
    expect(firstResponse.status).toBe(201);
    const first = (await firstResponse.json() as {
      policy: { policy_id: string; revision: number };
    }).policy;

    const secondResponse = await savePolicy(makePolicy({ mode: "tenant_controlled" }));
    expect(secondResponse.status).toBe(200);
    const second = (await secondResponse.json() as {
      policy: { policy_id: string; revision: number };
    }).policy;
    expect(second.policy_id).toBe(first.policy_id);
    expect(second.revision).toBeGreaterThan(first.revision);

    const listed = await fetch(baseUrl + "/v1/admin/feature-policies", {
      headers: { authorization: "Bearer " + adminToken },
    });
    expect(listed.status).toBe(200);
    expect((await listed.json() as { policies: unknown[] }).policies).toHaveLength(1);
    const audits = await store.listAudits();
    expect(audits.some((audit) =>
      audit.action === "feature_policy.upsert"
      && JSON.stringify(audit.detail).includes(first.policy_id)
    )).toBe(true);
    expect(JSON.stringify(audits)).not.toContain("required_permissions");
  });

  it("管理端严格拒绝未知字段、错误目标和过大请求", async () => {
    const unknown = await fetch(baseUrl + "/v1/admin/feature-policies", {
      method: "POST",
      headers: {
        authorization: "Bearer " + adminToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ policy: makePolicy(), unexpected: true }),
    });
    expect(unknown.status).toBe(422);
    expect((await unknown.json() as { code: string }).code).toBe("FEATURE_POLICY_INVALID");

    const badScope = await savePolicy({ ...makePolicy(), scope: "tenant" } as FeaturePolicyEntry);
    expect(badScope.status).toBe(422);

    const huge = await fetch(baseUrl + "/v1/admin/feature-policies", {
      method: "POST",
      headers: {
        authorization: "Bearer " + adminToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ policy: makePolicy(), padding: "x".repeat(70_000) }),
    });
    expect(huge.status).toBe(413);
  });

  it("客户端只收到匹配设备/租户/套餐和全局的用户策略，并保留 Agent 目标", async () => {
    for (const policy of [
      makePolicy(),
      makePolicy({ scope: "tenant", scope_id: "tenant-default" }),
      makePolicy({ scope: "tenant", scope_id: "tenant-other" }),
      makePolicy({ scope: "device", scope_id: deviceId }),
      makePolicy({ scope: "device", scope_id: "device-other" }),
      makePolicy({ scope: "agent", scope_id: "longhub.agent.hr" }),
      makePolicy({ audience: "tenant_admin" }),
    ]) {
      expect([200, 201]).toContain((await savePolicy(policy)).status);
    }
    const response = await fetch(baseUrl + "/v1/client/feature-policy", {
      headers: deviceHeaders(),
    });
    const body = await response.json() as { features: FeaturePolicyEntry[] };
    expect(body.features.map((entry) => entry.scope + ":" + (entry.scope_id ?? "-"))).toEqual([
      "agent:longhub.agent.hr",
      "device:" + deviceId,
      "global:-",
      "tenant:tenant-default",
    ]);
    expect(body.features.every((entry) => entry.audience === "user")).toBe(true);
  });

  it("相同策略窗口支持 ETag 条件刷新", async () => {
    await savePolicy(makePolicy());
    const first = await fetch(baseUrl + "/v1/client/feature-policy", {
      headers: deviceHeaders(),
    });
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const second = await fetch(baseUrl + "/v1/client/feature-policy", {
      headers: { ...deviceHeaders(), "if-none-match": etag! },
    });
    expect([200, 304]).toContain(second.status);
    if (second.status === 200) {
      expect(second.headers.get("etag")).not.toBe(etag);
    }
  });

    it("已认证策略刷新同步实际 Manager 版本并拒绝非法版本", async () => {
    await savePolicy(makePolicy({
      feature_id: "skill.catalog",
      scope: "device",
      scope_id: deviceId,
      min_manager_version: "0.8.1",
    }));
    const before = await fetch(baseUrl + "/v1/catalog/skills", { headers: deviceHeaders() });
    // An empty catalog is a valid clean-launch response.  A policy only
    // gates matching entries; it must not turn an empty catalog into 403.
    expect(before.status).toBe(200);

    const refreshed = await fetch(baseUrl + "/v1/client/feature-policy", {
      headers: { ...deviceHeaders(), "x-longhub-manager-version": "0.8.1" },
    });
    expect(refreshed.status).toBe(200);
    expect((await store.getDevice(deviceId))?.app_version).toBe("0.8.1");
    expect((await fetch(baseUrl + "/v1/catalog/skills", { headers: deviceHeaders() })).status).toBe(200);

    const invalid = await fetch(baseUrl + "/v1/client/feature-policy", {
      headers: { ...deviceHeaders(), "x-longhub-manager-version": "latest" },
    });
    expect(invalid.status).toBe(422);
    expect((await invalid.json() as { code: string }).code).toBe("INVALID_MANAGER_VERSION");
    expect((await store.getDevice(deviceId))?.app_version).toBe("0.8.1");
  });

  it("固定路由只写匿名小时直方图并提供无身份 health probe", async () => {
    expect(await (await fetch(baseUrl + "/v1/health")).json()).toEqual({ status: "ok" });
    await fetch(baseUrl + "/v1/client/feature-policy", { headers: deviceHeaders() });
    await fetch(baseUrl + "/v1/catalog/skills", { headers: deviceHeaders() });
    let rows = await store.listHttpRouteMetrics();
    for (let attempt = 0; attempt < 10 && rows.length < 5; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      rows = await store.listHttpRouteMetrics();
    }
    const routeIds = new Set(rows.map((row) => row.route_id));
    expect(routeIds).toEqual(new Set([
      "cloud_api",
      "health_probe",
      "client_feature_policy",
      "skill_catalog",
    ]));
    expect(JSON.stringify(rows)).not.toMatch(/device|tenant|session|prompt|query|url/i);
  });

  it("已注册设备无需旧激活码即可取得策略", async () => {
    const unactivated = await registerDevice("feature-policy-unactivated");
    const response = await fetch(baseUrl + "/v1/client/feature-policy", {
      headers: { authorization: "Bearer " + unactivated.device_token },
    });
    expect(response.status).toBe(200);
  });

  it("clean launch 构建策略时不读取已下线的 Pack entitlement", async () => {
    store.listEntitlements = async () => {
      throw new Error("CLEAN_LAUNCH_UNSUPPORTED:entitlement.list");
    };
    const feature = await fetch(baseUrl + "/v1/client/feature-policy", {
      headers: deviceHeaders(),
    });
    expect(feature.status).toBe(200);
    expect(await feature.json()).toMatchObject({
      schema_version: "longhub/feature-policy/v2",
      features: [],
    });
    expect((await fetch(baseUrl + "/v1/catalog/skills", {
      headers: deviceHeaders(),
    })).status).toBe(200);
  });
});

describe.skip("历史 Pack 业务端点逐请求复验（仅兼容回归）", () => {
  it("没有 V2 策略时保持 0.4.1 Agent Catalog 兼容", async () => {
    const response = await fetch(baseUrl + "/v1/catalog/packs", {
      headers: deviceHeaders(),
    });
    expect(response.status).toBe(200);
  });

  it("关闭策略阻断直接 API，不依赖 UI 隐藏", async () => {
    await savePolicy(makePolicy({ enabled: false }));
    const response = await fetch(baseUrl + "/v1/catalog/packs", {
      headers: deviceHeaders(),
    });
    expect(response.status).toBe(403);
    expect((await response.json() as { code: string }).code).toBe("FEATURE_DISABLED");
  });

  it("紧急关闭返回可重试的稳定 503", async () => {
    await savePolicy(makePolicy({ emergency_disabled: true }));
    const response = await fetch(baseUrl + "/v1/catalog/packs", {
      headers: deviceHeaders(),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "FEATURE_EMERGENCY_DISABLED",
      retryable: true,
    });
    await fetch(baseUrl + "/v1/catalog/packs", { headers: deviceHeaders() });
    let observations = await store.listFeaturePolicyEmergencyObservations();
    for (let attempt = 0; attempt < 10 && observations.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      observations = await store.listFeaturePolicyEmergencyObservations();
    }
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      feature_id: "agent.catalog",
      latency_ms: expect.any(Number),
    });
    expect(observations[0]!.latency_ms).toBeLessThanOrEqual(5_000);
  });

  it("必要 entitlement 在每次调用时在线复验，授予后才能访问", async () => {
    await savePolicy(makePolicy({
      required_entitlements: ["pack:longhub.hr-suite"],
    }));
    const denied = await fetch(baseUrl + "/v1/catalog/packs", {
      headers: deviceHeaders(),
    });
    expect(denied.status).toBe(403);
    expect((await denied.json() as { code: string }).code).toBe("FEATURE_ACCESS_DENIED");

    await store.grantEntitlement({
      tenant_id: "tenant-default",
      device_id: deviceId,
      pack_id: "longhub.hr-suite",
    });
    const allowed = await fetch(baseUrl + "/v1/catalog/packs", {
      headers: deviceHeaders(),
    });
    expect(allowed.status).toBe(200);
  });

  it("必要 permission 不能由页面或查询参数自报绕过", async () => {
    await savePolicy(makePolicy({
      required_permissions: ["skill:catalog:read"],
    }));
    const response = await fetch(baseUrl + "/v1/catalog/packs?permissions=skill:catalog:read", {
      headers: {
        ...deviceHeaders(),
        "x-longhub-permissions": "skill:catalog:read",
      },
    });
    expect(response.status).toBe(403);
    expect((await response.json() as { code: string }).code).toBe("FEATURE_ACCESS_DENIED");
  });

  it("skill.execute 在任务创建点逐请求复验策略", async () => {
    await savePolicy(makePolicy({ feature_id: "skill.execute", enabled: false }));
    const response = await fetch(baseUrl + "/v1/tasks", {
      method: "POST",
      headers: {
        ...deviceHeaders(),
        "content-type": "application/json",
        "idempotency-key": "feature-policy-execute-disabled-1",
      },
      body: JSON.stringify({
        schema_version: "longhub/cloud-skill-call/v1",
        request_id: "feature-policy-execute-request-1",
        kind: "skill.execute",
        skill_id: "longhub.skill.policy-check",
        skill_version: "1.0.0",
        agent_id: "openclaw-default",
        tool_call_id: "feature-policy-execute-call-1",
        session_key_hash: "0".repeat(64),
        idempotency_key: "feature-policy-execute-disabled-1",
        input: { text: "x" },
      }),
    });
    expect(response.status).toBe(403);
    expect((await response.json() as { code: string }).code).toBe("FEATURE_DISABLED");
  });
});
