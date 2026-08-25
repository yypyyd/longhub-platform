import { describe, expect, it } from "vitest";
import { computeExecutorInputDigest } from "longhub-executor";
import { MemoryStore } from "../src/memory-store.js";
import {
  CloudTaskIdempotencyConflictError,
  type CloudTaskOwner,
} from "../src/store.js";
import {
  computeCloudTaskRequestFingerprint,
  type CloudTaskRequestFingerprintInput,
} from "../src/task-fingerprint.js";

const OWNER: CloudTaskOwner = {
  tenant_id: "tenant-fingerprint",
  device_id: "device-fingerprint",
  agent_id: "agent-fingerprint",
};

function fingerprintInput(
  patch: Partial<CloudTaskRequestFingerprintInput> = {},
): CloudTaskRequestFingerprintInput {
  return {
    schema_version: "longhub/cloud-skill-call/v1",
    request_id: "request-1",
    kind: "skill.execute",
    ...OWNER,
    skill_id: "longhub.skill.fingerprint.skill",
    skill_version: "1.2.3",
    tool_call_id: "tool-1",
    session_key_hash: "a".repeat(64),
    idempotency_key: "fingerprint-key",
    requested_plan_id: "fingerprint-plan",
    input_digest: computeExecutorInputDigest({ alpha: 1, nested: { beta: 2 } }),
    ...patch,
  };
}

describe("Cloud Task request fingerprint", () => {
  it("is versioned and stable for semantically identical JSON input", () => {
    const first = computeCloudTaskRequestFingerprint(fingerprintInput({
      input_digest: computeExecutorInputDigest({ alpha: 1, nested: { beta: 2, gamma: 3 } }),
    }));
    const reordered = computeCloudTaskRequestFingerprint(fingerprintInput({
      input_digest: computeExecutorInputDigest({ nested: { gamma: 3, beta: 2 }, alpha: 1 }),
    }));

    expect(first).toMatch(/^v1:[a-f0-9]{64}$/);
    expect(reordered).toBe(first);
  });

  it("changes when any bound protocol, owner, Skill, plan or call field changes", () => {
    const base = fingerprintInput();
    const original = computeCloudTaskRequestFingerprint(base);
    const variants: CloudTaskRequestFingerprintInput[] = [
      { ...base, schema_version: "longhub/cloud-skill-call/v2" },
      { ...base, request_id: "request-2" },
      { ...base, kind: "skill.other" },
      { ...base, tenant_id: "tenant-other" },
      { ...base, device_id: "device-other" },
      { ...base, agent_id: "agent-other" },
      { ...base, skill_id: "longhub.skill.other.skill" },
      { ...base, skill_version: "1.2.4" },
      { ...base, tool_call_id: "tool-2" },
      { ...base, session_key_hash: "b".repeat(64) },
      { ...base, idempotency_key: "fingerprint-key-2" },
      { ...base, requested_plan_id: "other-plan" },
      { ...base, requested_plan_id: null },
      { ...base, input_digest: "b".repeat(64) },
    ];

    for (const variant of variants) {
      expect(computeCloudTaskRequestFingerprint(variant)).not.toBe(original);
    }
  });

  it("atomically replays only the same fingerprint without extra task events", async () => {
    const store = new MemoryStore();
    const key = "memory-fingerprint-key";
    const input = { nested: { beta: 2, alpha: 1 } };
    const fingerprint = computeCloudTaskRequestFingerprint(fingerprintInput({
      idempotency_key: key,
      input_digest: computeExecutorInputDigest(input),
    }));

    const created = await store.createTask(key, "skill.execute", input, OWNER, fingerprint);
    const replayed = await store.createTask(
      key,
      "skill.execute",
      { nested: { alpha: 1, beta: 2 } },
      OWNER,
      fingerprint,
    );

    expect(created.existed).toBe(false);
    expect(replayed).toMatchObject({ existed: true, task: { task_id: created.task.task_id } });
    expect(await store.findTaskByIdempotency(key, OWNER)).toEqual({
      task: created.task,
      request_fingerprint: fingerprint,
    });
    expect(created.task).not.toHaveProperty("request_fingerprint");
    expect(await store.eventsAfter(created.task.task_id)).toHaveLength(1);

    const conflictingFingerprint = computeCloudTaskRequestFingerprint(fingerprintInput({
      idempotency_key: key,
      skill_version: "9.9.9",
      input_digest: computeExecutorInputDigest(input),
    }));
    await expect(store.createTask(key, "skill.execute", input, OWNER, conflictingFingerprint))
      .rejects.toBeInstanceOf(CloudTaskIdempotencyConflictError);
    expect(await store.eventsAfter(created.task.task_id)).toHaveLength(1);
  });

  it("fails closed when a legacy-unbound row is replayed", async () => {
    const store = new MemoryStore();
    const created = await store.createTask("legacy-unbound-key", "skill.execute", { value: 1 }, OWNER);
    expect(created.existed).toBe(false);

    await expect(store.createTask("legacy-unbound-key", "skill.execute", { value: 1 }, OWNER))
      .rejects.toBeInstanceOf(CloudTaskIdempotencyConflictError);
    expect(await store.eventsAfter(created.task.task_id)).toHaveLength(1);
  });

  it("keeps the same idempotency token isolated across owners", async () => {
    const store = new MemoryStore();
    const key = "owner-scoped-fingerprint";
    const firstInput = fingerprintInput({ idempotency_key: key, requested_plan_id: null });
    const first = await store.createTask(
      key,
      "skill.execute",
      {},
      OWNER,
      computeCloudTaskRequestFingerprint(firstInput),
    );
    const otherOwner = { ...OWNER, device_id: "device-other" };
    const second = await store.createTask(
      key,
      "skill.execute",
      {},
      otherOwner,
      computeCloudTaskRequestFingerprint({ ...firstInput, device_id: otherOwner.device_id }),
    );

    expect(second.existed).toBe(false);
    expect(second.task.task_id).not.toBe(first.task.task_id);
  });
});
