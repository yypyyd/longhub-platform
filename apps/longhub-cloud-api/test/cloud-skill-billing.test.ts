import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/memory-store.js";
import { createCloudApiServer } from "../src/server.js";

const ADMIN_TOKEN = "cloud-skill-billing-admin";
const SKILL_ID = "longhub.skill.resume-screen";
const SECOND_SKILL_ID = "longhub.skill.offer-drafter";
const PLAN_ID = "longhub-pro";

describe("Cloud Skill billing：skill_id + plan_id 独立订阅语义", () => {
  let store: MemoryStore;
  let api: ReturnType<typeof createCloudApiServer>;
  let baseUrl: string;
  let userToken: string;
  let userId: string;
  let deviceToken: string;
  let deviceId: string;
  let tenantId: string;

  async function request(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
    const response = await fetch(`${baseUrl}${path}`, init);
    return { status: response.status, body: await response.json() };
  }

  async function post(path: string, body: unknown, token?: string): Promise<{ status: number; body: any }> {
    return request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  beforeAll(async () => {
    store = new MemoryStore();
    api = createCloudApiServer({ executorUrl: "http://127.0.0.1:1", store, adminToken: ADMIN_TOKEN, legacySurfaceEnabled: true }).listen(0);
    await once(api, "listening");
    baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    const registeredUser = await post("/v1/auth/register", {
      email: "cloud-skill-billing@test.cn",
      password: "cloud-skill-pass-1",
    });
    expect(registeredUser.status).toBe(201);
    userToken = registeredUser.body.token;
    userId = registeredUser.body.user.user_id;

    const registeredDevice = await post("/v1/devices/register", {
      platform: "openclaw-plugin-windows",
      app_version: "1.0.0",
      device_fingerprint: "cloud-skill-billing-device",
    });
    expect(registeredDevice.status).toBe(201);
    deviceId = registeredDevice.body.device_id;
    deviceToken = registeredDevice.body.device_token;
    tenantId = "tenant-default";
    // UUID-only HTTP binding is intentionally fail-closed until the pairing
    // proof flow ships. Seed ownership directly in the MemoryStore fixture.
    expect((await store.bindDevice(deviceId, userId))?.user_id).toBe(userId);

    const createdPlan = await post("/v1/admin/cloud-skill-plans", {
      plan_id: PLAN_ID,
      name: "LongHub Pro",
      description: "云端 Skill 专业计划",
      skill_ids: [SKILL_ID, SECOND_SKILL_ID],
      price_monthly_fen: 1_990,
      price_yearly_fen: 19_900,
      included_calls: 100,
      requests_per_minute: 7,
      max_concurrency: 1,
    }, ADMIN_TOKEN);
    expect(createdPlan.status).toBe(201);
  });

  afterAll(async () => {
    api.close();
    await once(api, "close");
  });

  it("公开目录返回 Cloud Skill 计划及限制元数据", async () => {
    const listed = await request("/v1/cloud-skill-plans");
    expect(listed.status).toBe(200);
    expect(listed.body.plans).toEqual([
      expect.objectContaining({
        plan_id: PLAN_ID,
        skill_ids: [SKILL_ID, SECOND_SKILL_ID],
        included_calls: 100,
        requests_per_minute: 7,
        max_concurrency: 1,
      }),
    ]);
  });

  it("购买与支付只创建 Cloud Skill subscription/entitlement，不写 Pack entitlement", async () => {
    const order = await post("/v1/orders", {
      type: "cloud_skill_plan",
      plan_id: PLAN_ID,
      period: "monthly",
      tenant_id: tenantId,
    }, userToken);
    expect(order.status).toBe(201);
    expect(order.body).toMatchObject({ type: "cloud_skill_plan", plan_id: PLAN_ID, tenant_id: tenantId });

    const paid = await post(`/v1/orders/${order.body.order_id}/pay`, { method: "mock" }, userToken);
    expect(paid.status).toBe(200);

    const subscriptions = await request("/v1/me/cloud-skill-subscriptions", {
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(subscriptions.body.subscriptions).toEqual([
      expect.objectContaining({ user_id: userId, tenant_id: tenantId, plan_id: PLAN_ID, status: "active" }),
    ]);
    const subscription = subscriptions.body.subscriptions[0];
    const entitlements = await request("/v1/me/cloud-skill-entitlements", {
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(entitlements.body.entitlements).toHaveLength(2);
    expect(entitlements.body.entitlements).toEqual(expect.arrayContaining([
      expect.objectContaining({ skill_id: SKILL_ID, plan_id: PLAN_ID, subscription_id: subscription.subscription_id }),
      expect.objectContaining({ skill_id: SECOND_SKILL_ID, plan_id: PLAN_ID, subscription_id: subscription.subscription_id }),
    ]));
    expect(await store.listAllEntitlements()).toHaveLength(0);

    const grant = await store.resolveCloudSkillAccess({
      user_id: userId,
      tenant_id: tenantId,
      skill_id: SKILL_ID,
      allowed_plan_ids: [PLAN_ID],
    });
    expect(grant).toMatchObject({ skill_id: SKILL_ID, plan_id: PLAN_ID });
    expect(await store.resolveCloudSkillAccess({
      user_id: userId,
      tenant_id: tenantId,
      skill_id: SKILL_ID,
      allowed_plan_ids: ["another-plan"],
    })).toBeUndefined();
    expect(await store.resolveCloudSkillAccess({
      user_id: userId,
      tenant_id: "tenant-other",
      skill_id: SKILL_ID,
      allowed_plan_ids: [PLAN_ID],
    })).toBeUndefined();

    // An old-shaped envelope may be parsed for the stable entitlement gate,
    // but an active subscriber still cannot execute without the v1 contract.
    const legacyWithAccess = await request("/v1/tasks", {
      method: "POST",
      headers: {
        authorization: `Bearer ${deviceToken}`,
        "content-type": "application/json",
        "idempotency-key": "cloud-skill-legacy-authorized-1",
      },
      body: JSON.stringify({
        kind: "skill.execute",
        input: { skill_id: SKILL_ID, plan_id: PLAN_ID, payload: { text: "legacy" } },
      }),
    });
    expect(legacyWithAccess.status).toBe(422);
    expect(legacyWithAccess.body.code).toBe("INVALID_TASK");
  });

  it("取消立即撤销 Cloud Skill entitlement，旧 Pack 授权不构成访问", async () => {
    const subscription = (await store.listCloudSkillSubscriptions(userId))[0]!;
    const legacy = await store.getDevice(deviceId);
    await store.grantEntitlement({
      tenant_id: tenantId,
      device_id: deviceId,
      pack_id: `skill:${SKILL_ID}`,
    });
    expect(await store.resolveCloudSkillAccess({ user_id: userId, tenant_id: tenantId, skill_id: SKILL_ID, allowed_plan_ids: [PLAN_ID] })).toBeDefined();
    const cancelled = await post(`/v1/me/cloud-skill-subscriptions/${subscription.subscription_id}/cancel`, {}, userToken);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe("cancelled");
    expect(await store.resolveCloudSkillAccess({ user_id: userId, tenant_id: tenantId, skill_id: SKILL_ID, allowed_plan_ids: [PLAN_ID] })).toBeUndefined();
    expect(legacy?.device_id).toBe(deviceId);
  });

  it("未授权任务在 Cloud API 执行点拒绝，且过期/退款状态不能重获访问", async () => {
    const denied = await request("/v1/tasks", {
      method: "POST",
      headers: {
        authorization: `Bearer ${deviceToken}`,
        "content-type": "application/json",
        "idempotency-key": "cloud-skill-denied-1",
      },
      body: JSON.stringify({
        kind: "skill.execute",
        input: { skill_id: SECOND_SKILL_ID, plan_id: PLAN_ID, payload: { text: "x" } },
      }),
    });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("CLOUD_SKILL_SUBSCRIPTION_REQUIRED");

    // Unknown legacy-shaped calls are rejected after the compatibility parse;
    // production never creates a task for a pre-v1 envelope.
    const unknownLegacy = await request("/v1/tasks", {
      method: "POST",
      headers: {
        authorization: `Bearer ${deviceToken}`,
        "content-type": "application/json",
        "idempotency-key": "cloud-skill-legacy-unknown-1",
      },
      body: JSON.stringify({
        kind: "skill.execute",
        input: { skill_id: "longhub.skill.unknown", payload: { text: "x" } },
      }),
    });
    expect(unknownLegacy.status).toBe(422);
    expect(unknownLegacy.body.code).toBe("INVALID_TASK");

    const order = await post("/v1/orders", {
      type: "cloud_skill_plan", plan_id: PLAN_ID, period: "monthly", tenant_id: tenantId,
    }, userToken);
    const paid = await post(`/v1/orders/${order.body.order_id}/pay`, { method: "mock" }, userToken);
    expect(paid.status).toBe(200);
    const subscription = await store.getCloudSkillSubscriptionByOrder(order.body.order_id);
    expect(subscription).toBeDefined();
    await store.updateCloudSkillSubscriptionStatus(subscription!.subscription_id, "expired");
    expect(await store.hasCloudSkillAccess({ user_id: userId, tenant_id: tenantId, skill_id: SECOND_SKILL_ID, allowed_plan_ids: [PLAN_ID] })).toBe(false);

    const refundOrder = await post("/v1/orders", {
      type: "cloud_skill_plan", plan_id: PLAN_ID, period: "monthly", tenant_id: tenantId,
    }, userToken);
    expect((await post(`/v1/orders/${refundOrder.body.order_id}/pay`, { method: "mock" }, userToken)).status).toBe(200);
    const refunded = await post(`/v1/admin/orders/${refundOrder.body.order_id}/refund`, {}, ADMIN_TOKEN);
    expect(refunded.status).toBe(200);
    const refundedSubscription = await store.getCloudSkillSubscriptionByOrder(refundOrder.body.order_id);
    expect(refundedSubscription?.status).toBe("refunded");
    expect(await store.hasCloudSkillAccess({ user_id: userId, tenant_id: tenantId, skill_id: SKILL_ID, allowed_plan_ids: [PLAN_ID] })).toBe(false);
  });
});
