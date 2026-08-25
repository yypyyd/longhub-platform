import { CORE_RPC_VERSION, HARD_LIMITS, type CoreBudget } from "./index.js";
import {
  bridgeConfirmationBinding,
  buildBridgeConfirmationDisplay,
  bridgePayloadDigest,
  clampBudget,
  createBridgeConfirmationRequest,
  intersectBridgePermissions,
  permissionRequiresConfirmation,
  type BridgeConfirmationRecord,
  type BridgeConfirmationRequest,
  type BridgeConfirmationResponse,
  type BridgeEntitlementVerifier,
  type BridgeExecutionPolicy,
} from "./authorization.js";
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
  bridgePolicy?: BridgeExecutionPolicy;
  verifyBridgeEntitlement?: BridgeEntitlementVerifier;
  onConfirmationRequest?(request: BridgeConfirmationRequest): void;
  now?: () => number;
}

export interface BridgeToolContext {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  toolCallId: string;
}

export class BridgeAuthorizationError extends Error {
  readonly code = "BRIDGE_FORBIDDEN";
}

export class BridgeConfirmationRequiredError extends Error {
  readonly code = "BRIDGE_CONFIRMATION_REQUIRED";

  constructor(readonly request: BridgeConfirmationRequest) {
    super(`操作需要用户确认: ${request.confirmationId}`);
  }
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
  private readonly confirmations = new Map<string, BridgeConfirmationRecord>();
  private readonly confirmationIdsByBinding = new Map<string, string>();
  private bridgePolicy: BridgeExecutionPolicy;

  constructor(private readonly options: CoreRuntimeOptions) {
    this.bridgePolicy = options.bridgePolicy ?? {};
  }

  hello(): { coreRpcVersion: string; limits: typeof HARD_LIMITS } {
    return { coreRpcVersion: CORE_RPC_VERSION, limits: HARD_LIMITS };
  }

  submitTask(params: {
    idempotencyKey: string;
    skillId: string;
    input: unknown;
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

  /** Desktop 生命周期协调器原子替换有效 Agent 策略；已打开会话不会因此取得旧授权。 */
  replaceBridgePolicy(policy: BridgeExecutionPolicy): { agentIds: string[] } {
    this.bridgePolicy = policy;
    // 策略变更跨越安全纪元；旧确认即使仍在 TTL 内也不能在重新启用后复用。
    this.confirmations.clear();
    this.confirmationIdsByBinding.clear();
    return { agentIds: Object.keys(policy).sort() };
  }

  /** OpenClaw Tool Bridge 专用入口：调用方不能提交身份、权限、确认或预算。 */
  async executeBridgeSkill(params: {
    skillId: string;
    input: unknown;
    context: BridgeToolContext;
  }): Promise<unknown> {
    const { agentId, sessionKey, sessionId, toolCallId } = params.context;
    if (![agentId, sessionKey, sessionId, toolCallId].every(
      (value) => typeof value === "string" && value.length > 0,
    )) {
      throw new BridgeAuthorizationError("缺少可信 OpenClaw agent/session 上下文");
    }
    const grant = this.bridgePolicy[agentId]?.find((item) => item.skillId === params.skillId);
    if (!grant) {
      throw new BridgeAuthorizationError(`Agent ${agentId} 未获准调用技能 ${params.skillId}`);
    }

    const verifier = this.options.verifyBridgeEntitlement;
    if (!verifier) throw new BridgeAuthorizationError("未配置 Bridge entitlement 复验器");
    let entitlement;
    try {
      entitlement = await verifier({
        agentId,
        packId: grant.packId,
        packVersion: grant.packVersion,
        skillId: grant.skillId,
      });
    } catch {
      throw new BridgeAuthorizationError("Bridge entitlement 在线复验失败");
    }
    const now = this.options.now?.() ?? Date.now();
    const entitlementExpiry = entitlement.expiresAt === undefined
      ? undefined
      : Date.parse(entitlement.expiresAt);
    if (
      !entitlement.active ||
      entitlementExpiry === undefined ||
      !Number.isFinite(entitlementExpiry) ||
      entitlementExpiry <= now
    ) {
      throw new BridgeAuthorizationError(entitlement.reason ?? "Pack entitlement 已失效");
    }

    const effectivePermissions = intersectBridgePermissions(grant);
    if (effectivePermissions.length !== new Set(grant.requiredPermissions).size) {
      throw new BridgeAuthorizationError("Profile/Pack/租户/设备权限交集不足");
    }
    const sensitivePermissions = effectivePermissions.filter(permissionRequiresConfirmation);
    if (sensitivePermissions.length > 0) {
      this.pruneConfirmations(now);
      if (!grant.confirmation) {
        throw new BridgeAuthorizationError("写权限 Skill 缺少可信确认展示声明");
      }
      let display;
      try {
        display = buildBridgeConfirmationDisplay(grant.confirmation, params.input);
      } catch {
        throw new BridgeAuthorizationError("写权限 Skill 确认展示参数无效");
      }
      const bindingRequest = {
        agentId,
        skillId: params.skillId,
        profileVersion: grant.profileVersion,
        sessionId,
        toolCallId,
        permissions: sensitivePermissions,
        payloadDigest: bridgePayloadDigest(params.skillId, params.input),
        display,
      };
      const binding = bridgeConfirmationBinding(bindingRequest);
      const existingId = this.confirmationIdsByBinding.get(binding);
      let confirmation = existingId ? this.confirmations.get(existingId) : undefined;
      if (confirmation && Date.parse(confirmation.expiresAt) <= now) {
        this.confirmations.delete(confirmation.confirmationId);
        this.confirmationIdsByBinding.delete(binding);
        confirmation = undefined;
      }
      if (!confirmation) {
        confirmation = createBridgeConfirmationRequest(bindingRequest, now, 5 * 60_000);
        this.confirmations.set(confirmation.confirmationId, confirmation);
        this.confirmationIdsByBinding.set(binding, confirmation.confirmationId);
        const { status: _status, ...request } = confirmation;
        this.options.onConfirmationRequest?.(request);
      }
      if (confirmation.status === "denied") {
        throw new BridgeAuthorizationError("用户已拒绝该操作");
      }
      if (confirmation.status !== "approved") {
        throw new BridgeConfirmationRequiredError(confirmation);
      }
      confirmation.status = "consumed";
      this.confirmationIdsByBinding.delete(binding);
      this.confirmations.delete(confirmation.confirmationId);
    }

    return this.options.executor.execute(
      params.skillId,
      params.input,
      effectivePermissions,
      clampBudget(grant.budget, this.options.defaultBudget ?? DEFAULT_BUDGET),
    );
  }

  respondBridgeConfirmation(response: BridgeConfirmationResponse): BridgeConfirmationRecord {
    const confirmation = this.confirmations.get(response.confirmationId);
    const now = this.options.now?.() ?? Date.now();
    if (!confirmation || confirmation.status !== "pending" || Date.parse(confirmation.expiresAt) <= now) {
      throw new BridgeAuthorizationError("确认记录不存在、已过期或已使用");
    }
    confirmation.status = response.approved ? "approved" : "denied";
    return { ...confirmation, permissions: [...confirmation.permissions] };
  }

  private pruneConfirmations(now: number): void {
    for (const confirmation of this.confirmations.values()) {
      if (confirmation.status !== "consumed" && Date.parse(confirmation.expiresAt) > now) continue;
      this.confirmations.delete(confirmation.confirmationId);
      this.confirmationIdsByBinding.delete(bridgeConfirmationBinding(confirmation));
    }
  }

  private async run(
    task: TaskRecord,
    params: {
      skillId: string;
      input: unknown;
      budget?: CoreBudget;
    },
  ): Promise<void> {
    this.transition(task, "running");
    const budget = clampBudget(params.budget, this.options.defaultBudget ?? DEFAULT_BUDGET);
    try {
      const output = await this.options.executor.execute(
        params.skillId,
        params.input,
        [],
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
