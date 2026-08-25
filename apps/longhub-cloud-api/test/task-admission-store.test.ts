import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/memory-store.js";
import { createCloudTaskAdmissionPlaceholder } from "../src/store.js";

const owner = {
  tenant_id: "tenant-admission",
  device_id: "device-admission",
  agent_id: "agent-admission",
};

describe("MemoryStore task admission cleanup", () => {
  it("admits a placeholder once and protects admitted input from late cleanup", async () => {
    const store = new MemoryStore();
    const fingerprint = `v1:${"a".repeat(64)}`;
    const placeholder = createCloudTaskAdmissionPlaceholder(fingerprint, "b".repeat(64));
    const { task } = await store.createTask("admit-once", "skill.execute", placeholder, owner, fingerprint);
    const input = { text: "admitted secret" };
    const malformed = { ...placeholder, schema_version: "wrong-schema" } as unknown as typeof placeholder;

    expect(await store.admitPendingTaskInput(task.task_id, malformed, { text: "must not persist" })).toBeUndefined();
    expect((await store.getTask(task.task_id))?.input).toEqual(placeholder);

    const admitted = await Promise.all(Array.from({ length: 8 }, () =>
      store.admitPendingTaskInput(task.task_id, placeholder, input)));
    expect(admitted.filter(Boolean)).toHaveLength(1);
    expect((await store.getTask(task.task_id))?.input).toEqual(input);
    expect(await store.discardPendingTask(task.task_id, placeholder)).toBe(false);
    expect((await store.claimPendingTask(task.task_id))?.status).toBe("running");
    expect(await store.discardPendingTask(task.task_id, placeholder)).toBe(false);
  });

  it("deletes only the matching pending placeholder and releases its idempotency key", async () => {
    const store = new MemoryStore();
    const fingerprint = `v1:${"c".repeat(64)}`;
    const placeholder = createCloudTaskAdmissionPlaceholder(fingerprint, "d".repeat(64));
    const { task } = await store.createTask("discard-once", "skill.execute", placeholder, owner, fingerprint);
    const different = createCloudTaskAdmissionPlaceholder(fingerprint, "e".repeat(64));
    const malformed = { ...placeholder, schema_version: "wrong-schema" } as unknown as typeof placeholder;

    expect(await store.discardPendingTask(task.task_id, malformed)).toBe(false);
    expect(await store.discardPendingTask(task.task_id, different)).toBe(false);
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      store.discardPendingTask(task.task_id, placeholder)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.discardPendingTask(task.task_id, placeholder)).toBe(false);
    expect(await store.findTaskByIdempotency("discard-once", owner)).toBeUndefined();

    const recreated = await store.createTask("discard-once", "skill.execute", placeholder, owner, fingerprint);
    expect(recreated.existed).toBe(false);
    expect(recreated.task.task_id).not.toBe(task.task_id);
  });
});
