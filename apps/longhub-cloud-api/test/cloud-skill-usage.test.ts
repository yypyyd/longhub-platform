import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/memory-store.js";
import type { CloudSkillExecutionReservationRequest } from "../src/store.js";

const USER_ID = "user-usage";
const TENANT_ID = "tenant-usage";
const DEVICE_ID = "device-usage";
const AGENT_ID = "agent-usage";
const SKILL_ID = "longhub.skill.usage.skill";
const SECOND_SKILL_ID = "longhub.skill.other.skill";
const PLAN_ID = "usage-plan";
const START = "2026-01-01T00:00:00.000Z";
const END = "2026-02-01T00:00:00.000Z";

async function createUsageStore(options: {
  included_calls?: number;
  requests_per_minute?: number;
  max_concurrency?: number;
  skill_ids?: string[];
} = {}): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.createUser({ email: `${USER_ID}-${Math.random()}@example.test`, password_hash: "hash" });
  await store.createCloudSkillPlan({
    plan_id: PLAN_ID,
    name: "Usage test plan",
    skill_ids: options.skill_ids ?? [SKILL_ID],
    price_monthly_fen: 1,
    price_yearly_fen: 1,
    included_calls: options.included_calls ?? 10,
    requests_per_minute: options.requests_per_minute ?? 10,
    max_concurrency: options.max_concurrency ?? 2,
  });
  const { subscription } = await store.createCloudSkillSubscription({
    user_id: USER_ID,
    tenant_id: TENANT_ID,
    plan_id: PLAN_ID,
    period: "monthly",
    starts_at: START,
    expires_at: END,
    source_order_id: `order-${Math.random()}`,
  });
  await store.grantCloudSkillEntitlement({
    subscription_id: subscription.subscription_id,
    skill_id: SKILL_ID,
    plan_id: PLAN_ID,
  });
  return store;
}

function request(
  taskId: string,
  now: string,
  extra: Partial<CloudSkillExecutionReservationRequest> = {},
): CloudSkillExecutionReservationRequest {
  return {
    task_id: taskId,
    user_id: USER_ID,
    tenant_id: TENANT_ID,
    device_id: DEVICE_ID,
    agent_id: AGENT_ID,
    skill_id: SKILL_ID,
    plan_id: PLAN_ID,
    now,
    lease_ttl_ms: 10_000,
    input_digest: "a".repeat(64),
    ...extra,
  };
}

describe("Cloud Skill execution usage admission", () => {
  it("builds anonymous per-plan/per-Skill operational counts for the last 24 hours", async () => {
    const store = await createUsageStore({ included_calls: 25, max_concurrency: 3 });
    const owner = { tenant_id: TENANT_ID, device_id: DEVICE_ID, agent_id: AGENT_ID };
    const succeededTask = (await store.createTask("ops-succeeded", SKILL_ID, {}, owner)).task;
    const runningTask = (await store.createTask("ops-running", SKILL_ID, {}, owner)).task;
    expect((await store.reserveCloudSkillExecution(request(
      succeededTask.task_id,
      "2026-01-02T12:00:00.000Z",
    ))).ok).toBe(true);
    expect((await store.reserveCloudSkillExecution(request(
      runningTask.task_id,
      "2026-01-02T12:00:01.000Z",
    ))).ok).toBe(true);
    await store.transitionIfStatus(succeededTask.task_id, ["pending"], "succeeded");
    await store.releaseCloudSkillExecution({
      task_id: succeededTask.task_id,
      now: "2026-01-02T12:00:02.000Z",
    });
    await store.transitionIfStatus(runningTask.task_id, ["pending"], "running");

    const summary = await store.getCloudSkillOperationalSummary("2026-01-02T12:00:03.000Z");
    expect(summary).toEqual({
      window_hours: 24,
      generated_at: "2026-01-02T12:00:03.000Z",
      skills: [{
        plan_id: PLAN_ID,
        skill_id: SKILL_ID,
        calls: 2,
        active_concurrency: 1,
        succeeded: 1,
        failed: 0,
        cancelled: 0,
        active_subscriptions: 1,
        included_calls_per_subscription: 25,
      }],
    });
    expect(JSON.stringify(summary)).not.toContain(USER_ID);
    expect(JSON.stringify(summary)).not.toContain(DEVICE_ID);
    expect(JSON.stringify(summary)).not.toContain(AGENT_ID);
  });

  it("is task-idempotent and detects binding/input conflicts", async () => {
    const store = await createUsageStore();
    const first = await store.reserveCloudSkillExecution(request("task-1", "2026-01-02T00:00:00.000Z"));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const retry = await store.reserveCloudSkillExecution(request("task-1", "2026-01-02T00:00:01.000Z"));
    expect(retry).toEqual(first);
    const conflict = await store.reserveCloudSkillExecution(request("task-1", "2026-01-02T00:00:02.000Z", {
      input_digest: "b".repeat(64),
    }));
    expect(conflict).toEqual({ ok: false, reason: "IDEMPOTENCY_CONFLICT" });
  });

  it("enforces cycle quota and does not refund usage on release", async () => {
    const store = await createUsageStore({ included_calls: 1, max_concurrency: 2 });
    const first = await store.reserveCloudSkillExecution(request("task-q1", "2026-01-02T00:00:00.000Z"));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect((await store.releaseCloudSkillExecution({
      reservation_id: first.reservation.reservation_id,
      now: "2026-01-02T00:00:00.500Z",
    })).released).toBe(true);
    expect(await store.reserveCloudSkillExecution(request("task-q2", "2026-01-02T00:00:01.000Z"))).toEqual({
      ok: false,
      reason: "QUOTA_EXCEEDED",
    });
  });

  it("enforces per-minute rate and returns a bounded retry hint", async () => {
    const store = await createUsageStore({ requests_per_minute: 1, max_concurrency: 2 });
    const first = await store.reserveCloudSkillExecution(request("task-r1", "2026-01-02T00:00:00.000Z"));
    expect(first.ok).toBe(true);
    const second = await store.reserveCloudSkillExecution(request("task-r2", "2026-01-02T00:00:10.000Z"));
    expect(second).toMatchObject({ ok: false, reason: "RATE_LIMITED", retry_after_seconds: 50 });
    const nextMinute = await store.reserveCloudSkillExecution(request("task-r3", "2026-01-02T00:01:00.000Z"));
    expect(nextMinute.ok).toBe(true);
  });

  it("counts included calls per subscription+Skill, while sharing rate/concurrency across Agents", async () => {
    const store = await createUsageStore({
      included_calls: 2,
      requests_per_minute: 10,
      max_concurrency: 2,
      skill_ids: [SKILL_ID, SECOND_SKILL_ID],
    });
    // The helper grants only the first Skill; grant the second explicitly.
    const subscription = (await store.listCloudSkillSubscriptions(USER_ID))[0]!;
    await store.grantCloudSkillEntitlement({
      subscription_id: subscription.subscription_id,
      skill_id: SECOND_SKILL_ID,
      plan_id: PLAN_ID,
    });
    const first = await store.reserveCloudSkillExecution(request("task-scope-1", "2026-01-02T00:00:00.000Z"));
    expect(first.ok).toBe(true);
    const second = await store.reserveCloudSkillExecution(request("task-scope-2", "2026-01-02T00:00:01.000Z", {
      skill_id: SECOND_SKILL_ID,
    }));
    expect(second.ok).toBe(true);

    // A second Agent on the same device shares the device concurrency bucket.
    const third = await store.reserveCloudSkillExecution(request("task-scope-3", "2026-01-02T00:00:02.000Z", {
      agent_id: "agent-other",
    }));
    expect(third).toMatchObject({ ok: false, reason: "CONCURRENCY_LIMIT" });

    const cycleStore = await createUsageStore({
      included_calls: 1,
      max_concurrency: 10,
      skill_ids: [SKILL_ID, SECOND_SKILL_ID],
    });
    const cycleSubscription = (await cycleStore.listCloudSkillSubscriptions(USER_ID))[0]!;
    await cycleStore.grantCloudSkillEntitlement({
      subscription_id: cycleSubscription.subscription_id,
      skill_id: SECOND_SKILL_ID,
      plan_id: PLAN_ID,
    });
    expect((await cycleStore.reserveCloudSkillExecution(request("task-cycle-1", "2026-01-02T00:00:00.000Z"))).ok).toBe(true);
    expect(await cycleStore.reserveCloudSkillExecution(request("task-cycle-2", "2026-01-02T00:00:01.000Z"))).toEqual({
      ok: false,
      reason: "QUOTA_EXCEEDED",
    });
    const cycleSecondSkill = await cycleStore.reserveCloudSkillExecution(request("task-cycle-3", "2026-01-02T00:00:02.000Z", {
      skill_id: SECOND_SKILL_ID,
    }));
    expect(cycleSecondSkill).toEqual(expect.objectContaining({ ok: true }));
  });

  it("releases concurrency and expires stale leases fail-safe", async () => {
    const store = await createUsageStore({ max_concurrency: 1 });
    const first = await store.reserveCloudSkillExecution(request("task-c1", "2026-01-02T00:00:00.000Z", {
      lease_ttl_ms: 1_000,
    }));
    expect(first.ok).toBe(true);
    expect(await store.reserveCloudSkillExecution(request("task-c2", "2026-01-02T00:00:00.500Z"))).toMatchObject({
      ok: false,
      reason: "CONCURRENCY_LIMIT",
    });
    const afterExpiry = await store.reserveCloudSkillExecution(request("task-c3", "2026-01-02T00:00:01.001Z"));
    expect(afterExpiry.ok).toBe(true);
  });

  it("fails closed for missing or revoked access", async () => {
    const store = await createUsageStore();
    expect(await store.reserveCloudSkillExecution(request("task-missing", "2026-01-02T00:00:00.000Z", {
      skill_id: "longhub.skill.other.skill",
    }))).toEqual({ ok: false, reason: "SKILL_NOT_ENTITLED" });
    const subscriptions = await store.listCloudSkillSubscriptions(USER_ID);
    await store.updateCloudSkillSubscriptionStatus(subscriptions[0]!.subscription_id, "refunded");
    expect(await store.reserveCloudSkillExecution(request("task-revoked", "2026-01-02T00:00:01.000Z"))).toEqual({
      ok: false,
      reason: "SUBSCRIPTION_INACTIVE",
    });
  });
});
