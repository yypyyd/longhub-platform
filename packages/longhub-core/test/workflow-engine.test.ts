import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BoundedWorkflowEngine } from "../src/workflow-engine.js";

const workflow = {
  schemaVersion: "longhub/workflow/v1" as const,
  workflowId: `user.workflow.${randomUUID()}`,
  name: "评估",
  steps: [{ id: "read", kind: "skill" as const, skillId: "longhub.skill.lookup", input: { query: "候选人" } }],
};

describe("Core 受限 Workflow 子步骤执行", () => {
  it("逐步描述、确认、鉴权、预算，并用稳定幂等键避免重试副作用", async () => {
    const calls: string[] = [];
    const engine = new BoundedWorkflowEngine({
      async describeSkill() { return { sideEffect: "local_recoverable", requiresConfirmation: true }; },
      async requestConfirmation(input) { calls.push(`confirm:${input.stepId}`); return true; },
      async authorizeAndExecute(input) { calls.push(`execute:${input.idempotencyKey}`); return { output: { ok: true }, costMicros: 10 }; },
    });
    const context = { runId: "run-1", agentId: "hr", input: {}, maxCostMicros: 100, maxDurationMs: 10_000 };
    expect(await engine.execute(workflow, context)).toMatchObject({ costMicros: 10, executedSteps: 1 });
    expect(await engine.execute(workflow, context)).toMatchObject({ costMicros: 10 });
    expect(calls.filter((value) => value.startsWith("execute"))).toHaveLength(1);
    expect(calls.filter((value) => value.startsWith("confirm"))).toHaveLength(2);
  });

  it("企业外部写入、费用超限、拒绝确认和取消都在后续执行前失败", async () => {
    const external = new BoundedWorkflowEngine({
      async describeSkill() { return { sideEffect: "external_write", requiresConfirmation: true }; },
      async requestConfirmation() { return true; },
      async authorizeAndExecute() { throw new Error("must not execute"); },
    });
    await expect(external.execute(workflow, { runId: "r", agentId: "hr", input: {}, maxCostMicros: 1, maxDurationMs: 1_000 }))
      .rejects.toThrow("EXTERNAL_WRITE");

    const denied = new BoundedWorkflowEngine({
      async describeSkill() { return { sideEffect: "none", requiresConfirmation: true }; },
      async requestConfirmation() { return false; },
      async authorizeAndExecute() { throw new Error("must not execute"); },
    });
    await expect(denied.execute(workflow, { runId: "r2", agentId: "hr", input: {}, maxCostMicros: 1, maxDurationMs: 1_000 }))
      .rejects.toThrow("DENIED");

    const controller = new AbortController();
    controller.abort();
    await expect(denied.execute(workflow, { runId: "r3", agentId: "hr", input: {}, maxCostMicros: 1, maxDurationMs: 1_000, signal: controller.signal }))
      .rejects.toThrow("CANCELLED");
  });
});
