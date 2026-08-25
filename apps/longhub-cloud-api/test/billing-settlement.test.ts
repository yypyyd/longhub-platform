import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { BillingSettlementError } from "../src/store.js";
import { MemoryStore } from "../src/memory-store.js";
import { createCloudApiServer } from "../src/server.js";

async function createUser(store: MemoryStore, suffix: string) {
  return (await store.createUser({ email: `${suffix}@settlement.test`, password_hash: "hash" })).user;
}

async function createBoundDevice(store: MemoryStore, userId: string, suffix: string) {
  const { device } = await store.registerDevice({
    tenant_id: "tenant-settlement",
    platform: "windows",
    app_version: "1.0.0",
    device_fingerprint: `fp-${suffix}`,
  });
  await store.bindDevice(device.device_id, userId);
  return device;
}

describe("Billing settlement atomicity (MemoryStore)", () => {
  it("concurrent payment replay writes one wallet transaction and one outbox event", async () => {
    const store = new MemoryStore();
    const user = await createUser(store, "recharge-replay");
    const order = await store.createOrder({ user_id: user.user_id, type: "recharge", amount_fen: 5_000 });
    const request = {
      order_id: order.order_id,
      user_id: user.user_id,
      method: "mock" as const,
      idempotency_key: `pay:${order.order_id}`,
      request_hash: "v1:recharge",
    };

    const [first, second] = await Promise.all([
      store.settleOrderPayment(request),
      store.settleOrderPayment(request),
    ]);

    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(first.settlement.settlement_id).toBe(second.settlement.settlement_id);
    expect(await store.listTransactions(user.user_id)).toHaveLength(1);
    expect((await store.getUser(user.user_id))?.balance_fen).toBe(5_000);
    expect(await store.listBillingOutbox()).toHaveLength(1);
  });

  it("same order with a different key is rejected without a second money movement", async () => {
    const store = new MemoryStore();
    const user = await createUser(store, "key-conflict");
    const order = await store.createOrder({ user_id: user.user_id, type: "recharge", amount_fen: 1_200 });
    await store.settleOrderPayment({
      order_id: order.order_id,
      user_id: user.user_id,
      method: "mock",
      idempotency_key: "payment-one",
      request_hash: "v1:one",
    });

    await expect(store.settleOrderPayment({
      order_id: order.order_id,
      user_id: user.user_id,
      method: "mock",
      idempotency_key: "payment-two",
      request_hash: "v1:one",
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await store.listTransactions(user.user_id)).toHaveLength(1);
    expect(await store.listBillingOutbox()).toHaveLength(1);
  });

  it("concurrent Pack refund credits once and revokes only this order's rows", async () => {
    const store = new MemoryStore();
    const user = await createUser(store, "pack-refund");
    const device = await createBoundDevice(store, user.user_id, "pack-refund");
    const firstOrder = await store.createOrder({
      user_id: user.user_id,
      type: "plan",
      pack_id: "longhub.hr-suite",
      period: "monthly",
      amount_fen: 900,
    });
    const secondOrder = await store.createOrder({
      user_id: user.user_id,
      type: "plan",
      pack_id: "longhub.hr-suite",
      period: "monthly",
      amount_fen: 900,
    });
    await store.settleOrderPayment({
      order_id: firstOrder.order_id, user_id: user.user_id, method: "mock",
      idempotency_key: `pay:${firstOrder.order_id}`, request_hash: "v1:first",
    });
    await store.settleOrderPayment({
      order_id: secondOrder.order_id, user_id: user.user_id, method: "mock",
      idempotency_key: `pay:${secondOrder.order_id}`, request_hash: "v1:second",
    });
    const request = {
      order_id: firstOrder.order_id,
      actor: "admin:test",
      idempotency_key: `refund:${firstOrder.order_id}`,
      request_hash: "v1:refund-first",
    };
    const [first, second] = await Promise.all([
      store.settleOrderRefund(request),
      store.settleOrderRefund(request),
    ]);

    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect((await store.getUser(user.user_id))?.balance_fen).toBe(900);
    expect((await store.listTransactions(user.user_id)).filter((txn) => txn.type === "refund")).toHaveLength(1);
    const rows = await store.listEntitlements(device.device_id);
    expect(rows.find((row) => row.source_order_id === firstOrder.order_id)?.status).toBe("revoked");
    expect(rows.find((row) => row.source_order_id === secondOrder.order_id)?.status).toBe("active");
    expect(await store.listBillingOutbox()).toHaveLength(3);
  });

  it("Cloud Skill refund atomically refunds, revokes subscription and entitlements", async () => {
    const store = new MemoryStore();
    const user = await createUser(store, "cloud-refund");
    await store.createCloudSkillPlan({
      plan_id: "settlement-cloud",
      name: "Settlement Cloud",
      skill_ids: ["longhub.skill.alpha", "longhub.skill.beta"],
      price_monthly_fen: 1_500,
      price_yearly_fen: 15_000,
    });
    const order = await store.createOrder({
      user_id: user.user_id,
      type: "cloud_skill_plan",
      plan_id: "settlement-cloud",
      tenant_id: "tenant-settlement",
      period: "monthly",
      amount_fen: 1_500,
    });
    const paid = await store.settleOrderPayment({
      order_id: order.order_id, user_id: user.user_id, method: "mock",
      idempotency_key: `pay:${order.order_id}`, request_hash: "v1:cloud-pay",
    });
    expect(paid.subscription?.status).toBe("active");
    expect(paid.cloud_skill_entitlements).toHaveLength(2);

    const refunded = await store.settleOrderRefund({
      order_id: order.order_id, actor: "admin:test",
      idempotency_key: `refund:${order.order_id}`, request_hash: "v1:cloud-refund",
    });
    expect(refunded.order.status).toBe("refunded");
    expect(refunded.subscription?.status).toBe("refunded");
    expect(refunded.cloud_skill_entitlements?.every((row) => row.status === "revoked")).toBe(true);
    expect((await store.getUser(user.user_id))?.balance_fen).toBe(1_500);
  });

  it("ambiguous legacy Pack access fails closed without refund side effects", async () => {
    const store = new MemoryStore();
    const user = await createUser(store, "legacy-reconcile");
    const device = await createBoundDevice(store, user.user_id, "legacy-reconcile");
    const order = await store.createOrder({
      user_id: user.user_id,
      type: "plan",
      pack_id: "longhub.hr-suite",
      period: "monthly",
      amount_fen: 700,
    });
    await store.settleOrderPayment({
      order_id: order.order_id, user_id: user.user_id, method: "mock",
      idempotency_key: `pay:${order.order_id}`, request_hash: "v1:legacy-pay",
    });
    await store.grantEntitlement({
      tenant_id: device.tenant_id,
      device_id: device.device_id,
      pack_id: "longhub.hr-suite",
      scope: "user",
    });
    const beforeOutbox = await store.listBillingOutbox();

    try {
      await store.settleOrderRefund({
        order_id: order.order_id, actor: "admin:test",
        idempotency_key: `refund:${order.order_id}`, request_hash: "v1:legacy-refund",
      });
      throw new Error("expected refund to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(BillingSettlementError);
      expect(error).toMatchObject({ code: "REFUND_REQUIRES_RECONCILIATION" });
    }
    expect((await store.getOrder(order.order_id))?.status).toBe("paid");
    expect((await store.getUser(user.user_id))?.balance_fen).toBe(0);
    expect(await store.listTransactions(user.user_id)).toHaveLength(0);
    expect(await store.listBillingOutbox()).toEqual(beforeOutbox);
  });
});

describe("Billing settlement HTTP idempotency", () => {
  it("replays an exact payment and rejects invalid/conflicting keys", async () => {
    const store = new MemoryStore();
    const user = await createUser(store, "http-idempotency");
    const token = "us-settlement-http";
    await store.createSession({
      subject_type: "user",
      subject_id: user.user_id,
      token,
      expires_at: "2099-12-31T00:00:00.000Z",
    });
    const order = await store.createOrder({ user_id: user.user_id, type: "recharge", amount_fen: 333 });
    const invalidOrder = await store.createOrder({ user_id: user.user_id, type: "recharge", amount_fen: 444 });
    const api = createCloudApiServer({ executorUrl: "http://127.0.0.1:9", adminToken: "admin", store, legacySurfaceEnabled: true }).listen(0);
    await once(api, "listening");
    const baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    const pay = async (orderId: string, key: string) => {
      const response = await fetch(`${baseUrl}/v1/orders/${orderId}/pay`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify({ method: "mock" }),
      });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    try {
      const first = await pay(order.order_id, "payment-http-1");
      const replay = await pay(order.order_id, "payment-http-1");
      const conflict = await pay(order.order_id, "payment-http-2");
      const invalid = await pay(invalidOrder.order_id, "contains space");
      expect(first).toMatchObject({ status: 200, body: { status: "paid", replayed: false } });
      expect(replay).toMatchObject({ status: 200, body: { status: "paid", replayed: true } });
      expect(replay.body.settlement_id).toBe(first.body.settlement_id);
      expect(conflict).toMatchObject({ status: 409, body: { code: "IDEMPOTENCY_CONFLICT" } });
      expect(invalid).toMatchObject({ status: 400, body: { code: "IDEMPOTENCY_KEY_INVALID" } });
      expect(await store.listTransactions(user.user_id)).toHaveLength(1);
      expect((await store.getOrder(invalidOrder.order_id))?.status).toBe("pending");
    } finally {
      api.close();
    }
  });
});
