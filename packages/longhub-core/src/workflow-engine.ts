import { randomUUID } from "node:crypto";
import { parseBoundedWorkflow, type BoundedWorkflow, type WorkflowLiteral, type WorkflowStep } from "@longhub/pack-schema";

export interface WorkflowSkillDescriptor {
  readonly sideEffect: "none" | "local_recoverable" | "external_write";
  readonly requiresConfirmation: boolean;
}

export interface WorkflowStepResult {
  readonly output: unknown;
  readonly costMicros: number;
}

export interface WorkflowExecutionContext {
  readonly runId: string;
  readonly agentId: string;
  readonly input: Readonly<Record<string, WorkflowLiteral>>;
  readonly maxCostMicros: number;
  readonly maxDurationMs: number;
  readonly signal?: AbortSignal;
}

export interface WorkflowEngineDependencies {
  describeSkill(skillId: string): Promise<WorkflowSkillDescriptor>;
  requestConfirmation(input: {
    runId: string;
    stepId: string;
    agentId: string;
    title: string;
    summary: string;
  }): Promise<boolean>;
  authorizeAndExecute(input: {
    runId: string;
    stepId: string;
    agentId: string;
    skillId: string;
    payload: Readonly<Record<string, WorkflowLiteral>>;
    idempotencyKey: string;
  }): Promise<WorkflowStepResult>;
}

export interface WorkflowExecutionResult {
  readonly runId: string;
  readonly outputs: Readonly<Record<string, unknown>>;
  readonly costMicros: number;
  readonly executedSteps: number;
}

/** 1.0 Workflow 不执行企业外部写入；每个子 Skill 都重新描述、确认、鉴权、预算并使用稳定幂等键。 */
export class BoundedWorkflowEngine {
  private readonly completed = new Map<string, WorkflowStepResult>();

  constructor(private readonly dependencies: WorkflowEngineDependencies) {}

  async execute(workflowInput: BoundedWorkflow, context: WorkflowExecutionContext): Promise<WorkflowExecutionResult> {
    const workflow = parseBoundedWorkflow(workflowInput);
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(context.runId) || !/^[A-Za-z0-9._:-]{1,160}$/.test(context.agentId) ||
      !Number.isSafeInteger(context.maxCostMicros) || context.maxCostMicros < 0 ||
      !Number.isSafeInteger(context.maxDurationMs) || context.maxDurationMs < 100 || context.maxDurationMs > 10 * 60_000) {
      throw new Error("Workflow 执行上下文无效");
    }
    const startedAt = Date.now();
    const state = { costMicros: 0, executedSteps: 0, outputs: {} as Record<string, unknown> };
    const check = (): void => {
      if (context.signal?.aborted) throw new Error("WORKFLOW_CANCELLED");
      if (Date.now() - startedAt > context.maxDurationMs) throw new Error("WORKFLOW_TIMEOUT");
      if (state.executedSteps >= 20) throw new Error("WORKFLOW_STEP_BUDGET_EXCEEDED");
    };
    const runSteps = async (steps: readonly WorkflowStep[], path: string): Promise<void> => {
      for (let index = 0; index < steps.length; index += 1) {
        check();
        const step = steps[index]!;
        const stepPath = `${path}.${index}.${step.id}`;
        state.executedSteps += 1;
        if (step.kind === "confirm") {
          const approved = await this.dependencies.requestConfirmation({
            runId: context.runId, stepId: stepPath, agentId: context.agentId, title: step.title, summary: step.summary,
          });
          if (!approved) throw new Error("WORKFLOW_CONFIRMATION_DENIED");
        } else if (step.kind === "skill") {
          const descriptor = await this.dependencies.describeSkill(step.skillId);
          if (descriptor.sideEffect === "external_write") throw new Error("WORKFLOW_EXTERNAL_WRITE_FORBIDDEN");
          if (descriptor.requiresConfirmation) {
            const approved = await this.dependencies.requestConfirmation({
              runId: context.runId,
              stepId: stepPath,
              agentId: context.agentId,
              title: `执行 ${step.skillId}`,
              summary: descriptor.sideEffect === "local_recoverable" ? "将产生可恢复的本机变更" : "执行只读能力",
            });
            if (!approved) throw new Error("WORKFLOW_CONFIRMATION_DENIED");
          }
          const idempotencyKey = `${context.runId}:${stepPath}`;
          let result = this.completed.get(idempotencyKey);
          if (!result) {
            result = await this.dependencies.authorizeAndExecute({
              runId: context.runId, stepId: stepPath, agentId: context.agentId,
              skillId: step.skillId, payload: step.input, idempotencyKey,
            });
            if (!Number.isSafeInteger(result.costMicros) || result.costMicros < 0) throw new Error("Workflow 子步骤费用无效");
            this.completed.set(idempotencyKey, structuredClone(result));
          }
          if (state.costMicros + result.costMicros > context.maxCostMicros) throw new Error("WORKFLOW_COST_BUDGET_EXCEEDED");
          state.costMicros += result.costMicros;
          state.outputs[step.id] = structuredClone(result.output);
        } else if (step.kind === "branch") {
          await runSteps(context.input[step.inputKey] === step.equals ? step.then : step.else, `${stepPath}.branch`);
        } else {
          for (let iteration = 0; iteration < step.iterations; iteration += 1) {
            await runSteps(step.steps, `${stepPath}.loop-${iteration}`);
          }
        }
      }
    };
    await runSteps(workflow.steps, workflow.workflowId);
    return { runId: context.runId, outputs: state.outputs, costMicros: state.costMicros, executedSteps: state.executedSteps };
  }
}

export function newWorkflowRunId(): string {
  return `workflow-run-${randomUUID()}`;
}
