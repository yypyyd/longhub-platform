import { CORE_RPC_VERSION, HARD_LIMITS, type CoreBudget } from "./index.js";
import type { RpcError } from "./rpc.js";

export type TaskStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface TaskRecord {
  taskId: string;
  kind: string;
  status: TaskStatus;
  input: unknown;
  output?: unknown;
  error?: RpcError;
  createdAt: string;
  updatedAt: string;
}

export interface TaskEvent {
  event_id: string;
  task_id: string;
  type: string;
  ts: string;
  error?: RpcError;
}

/** 本地技能执行接口，由 Skill Worker 进程实现 */
export interface SkillExecutor {
  execute(
    skillId: string,
    input: unknown,
    grantedPermissions: readonly string[],
    budget: CoreBudget,
  ): Promise<unknown>;
  abort(taskId: string): void;
}

export interface CoreRuntimeOptions {
  executor: SkillExecutor;
  onEvent(event: TaskEvent): void;
  defaultBudget?: CoreBudget;
}

const DEFAULT_BUDGET: CoreBudget = {
  maxTokens: 100_000,
  maxCostCents: 100,
  maxDurationMs: 60_000,
};

/** 龙枢内核运行时原型：任务提交（幂等）、执行、取消、事件通知 */
export class CoreRuntime {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly idempotency = new Map<string, string>();
  private eventSeq = 0;
  private taskSeq = 0;

  constructor(private readonly options: CoreRuntimeOptions) {}

  hello(): { coreRpcVersion: string; limits: typeof HARD_LIMITS } {
    return { coreRpcVersion: CORE_RPC_VERSION, limits: HARD_LIMITS };
  }

  submitTask(params: {
    idempotencyKey: string;
    skillId: string;
    input: unknown;
    grantedPermissions?: readonly string[];
    budget?: CoreBudget;
  }): TaskRecord {
    const existingId = this.idempotency.get(params.idempotencyKey);
    if (existingId !== undefined) {
      return this.mustGet(existingId);
    }
    const now = new Date().toISOString();
    const task: TaskRecord = {
      taskId: `task-${++this.taskSeq}`,
      kind: "skill.execute",
      status: "pending",
      input: params.input,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.taskId, task);
    this.idempotency.set(params.idempotencyKey, task.taskId);
    this.emit(task.taskId, "task.accepted");
    void this.run(task, params);
    return task;
  }

  getTask(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  cancelTask(taskId: string): TaskRecord {
    const task = this.mustGet(taskId);
    if (task.status === "pending" || task.status === "running") {
      this.options.executor.abort(taskId);
      this.transition(task, "cancelled");
    }
    return task;
  }

  private async run(
    task: TaskRecord,
    params: {
      skillId: string;
      input: unknown;
      grantedPermissions?: readonly string[];
      budget?: CoreBudget;
    },
  ): Promise<void> {
    this.transition(task, "running");
    const budget = params.budget ?? this.options.defaultBudget ?? DEFAULT_BUDGET;
    try {
      const output = await this.options.executor.execute(
        params.skillId,
        params.input,
        params.grantedPermissions ?? [],
        budget,
      );
      if (task.status !== "cancelled") {
        task.output = output;
        this.transition(task, "succeeded");
      }
    } catch (err) {
      if (task.status !== "cancelled") {
        task.error = {
          code: "SKILL_EXECUTION_FAILED",
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
        };
        this.transition(task, "failed");
      }
    }
  }

  private transition(task: TaskRecord, status: TaskStatus): void {
    task.status = status;
    task.updatedAt = new Date().toISOString();
    this.emit(task.taskId, `task.${status === "running" ? "started" : status}`, task.error);
  }

  private emit(taskId: string, type: string, error?: RpcError): void {
    this.options.onEvent({
      event_id: String(++this.eventSeq),
      task_id: taskId,
      type,
      ts: new Date().toISOString(),
      ...(error ? { error } : {}),
    });
  }

  private mustGet(taskId: string): TaskRecord {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    return task;
  }
}
