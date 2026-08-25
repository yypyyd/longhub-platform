import { describe, expect, it } from "vitest";
import { BillingOutboxWorker, type BillingPublishedEvent } from "../src/billing-outbox.js";
import { MemoryStore } from "../src/memory-store.js";

async function paidOutbox(store: MemoryStore, suffix: string) {
  const user = (await store.createUser({ email: `${suffix}@outbox.test`, password_hash: "hash" })).user;
  await store.createCloudSkillPlan({
    plan_id: `outbox-${suffix}`,
    name: "Outbox",
    skill_ids: [`longhub.skill.${suffix}`],
    price_monthly_fen: 500,
    price_yearly_fen: 5_000,
  });
  const order = await store.createOrder({
    user_id: user.user_id,
    type: "cloud_skill_plan",
    plan_id: `outbox-${suffix}`,
    tenant_id: "tenant-outbox",
    period: "monthly",
    amount_fen: 500,
  });
  return store.settleOrderPayment({
    order_id: order.order_id,
    user_id: user.user_id,
    method: "provider",
    provider_reference: `provider-${suffix}`,
    idempotency_key: `pay:${order.order_id}`,
    request_hash: `v1:${"a".repeat(64)}`,
    paid_at: "2026-08-16T00:00:00.000Z",
  });
}

describe("billing outbox lease worker", () => {
  it("fences concurrent claims and publishes an event without lease metadata", async () => {
    const store = new MemoryStore();
    const settled = await paidOutbox(store, "claim");
    const availableAt = Date.parse(settled.outbox.available_at);
    const claimAt = new Date(availableAt + 1_000);
    const [first, second] = await Promise.all([
      store.claimBillingOutbox({ now: claimAt.toISOString() }),
      store.claimBillingOutbox({ now: claimAt.toISOString() }),
    ]);
    expect(first.length + second.length).toBe(1);
    const claimed = (first[0] ?? second[0])!;
    expect(claimed.lock_token).toMatch(/^bol-/u);
    expect(await store.completeBillingOutbox(claimed.outbox_id, "bol-00000000-0000-0000-0000-000000000000",
      new Date(availableAt + 2_000).toISOString())).toBe(false);

    const events: BillingPublishedEvent[] = [];
    let now = new Date(availableAt + 32_000);
    const worker = new BillingOutboxWorker({
      store,
      publisher: { publish: async (event) => { events.push(event); } },
      now: () => now,
    });
    const result = await worker.runOnce();
    expect(result).toMatchObject({ claimed: 1, published: 1, lease_lost: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty("lock_token");
    expect(events[0]).not.toHaveProperty("locked_until");
    now = new Date(availableAt + 33_000);
    expect((await worker.runOnce()).claimed).toBe(0);
  });

  it("retries with backoff, rejects expired acknowledgements and dead-letters at the limit", async () => {
    const store = new MemoryStore();
    const settled = await paidOutbox(store, "retry");
    const availableAt = Date.parse(settled.outbox.available_at);
    let now = new Date(availableAt + 1_000);
    const worker = new BillingOutboxWorker({
      store,
      publisher: { publish: async () => { throw new Error("secret upstream detail"); } },
      max_attempts: 2,
      retry_base_ms: 1_000,
      now: () => now,
    });
    expect(await worker.runOnce()).toMatchObject({ claimed: 1, retried: 1, dead_lettered: 0 });
    let row = (await store.listBillingOutbox())[0]!;
    expect(row.last_error).toBe("PUBLISH_FAILED");
    expect(JSON.stringify(row)).not.toContain("secret upstream detail");
    expect(row.available_at).toBe(new Date(availableAt + 2_000).toISOString());

    now = new Date(availableAt + 2_000);
    expect(await worker.runOnce()).toMatchObject({ claimed: 1, retried: 0, dead_lettered: 1 });
    row = (await store.listBillingOutbox())[0]!;
    expect(row.attempts).toBe(2);
    expect(row.dead_lettered_at).toBe(new Date(availableAt + 2_000).toISOString());
    now = new Date(availableAt + 24 * 60 * 60_000);
    expect((await worker.runOnce()).claimed).toBe(0);

    const other = new MemoryStore();
    const otherSettled = await paidOutbox(other, "expired");
    const otherAvailableAt = Date.parse(otherSettled.outbox.available_at);
    const lease = (await other.claimBillingOutbox({
      now: new Date(otherAvailableAt + 1_000).toISOString(),
      lease_ms: 1_000,
    }))[0]!;
    expect(await other.completeBillingOutbox(
      lease.outbox_id,
      lease.lock_token!,
      new Date(otherAvailableAt + 2_000).toISOString(),
    )).toBe(false);
    expect(await other.failBillingOutbox({
      outbox_id: lease.outbox_id,
      lock_token: lease.lock_token!,
      failed_at: new Date(otherAvailableAt + 2_000).toISOString(),
      retry_at: new Date(otherAvailableAt + 3_000).toISOString(),
      error_code: "PUBLISH_FAILED",
    })).toBe(false);
  });
});
