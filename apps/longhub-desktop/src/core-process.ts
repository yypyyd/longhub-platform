/**
 * Core 进程：承载 CoreRuntime，向下拉起 Skill Worker 进程，
 * 向上通过 stdin/stdout NDJSON 服务 Desktop Main（core.hello / task.submit / task.get / task.cancel）。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  CoreRuntime,
  createLineChannel,
  isRequest,
  isResponse,
  RPC_VERSION,
  type CoreBudget,
  type RpcMessage,
  type SkillExecutor,
  type BridgeExecutionPolicy,
} from "@longhub/core";
import { createEntitlementVerifier } from "./bridge-entitlement.js";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isBudget(value: unknown): value is CoreBudget {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const budget = value as Record<string, unknown>;
  return (
    Object.keys(budget).sort().join("|") === "maxCostCents|maxDurationMs|maxTokens" &&
    [budget.maxTokens, budget.maxCostCents, budget.maxDurationMs].every(
      (item) => Number.isSafeInteger(item) && (item as number) > 0,
    )
  );
}

function parseBridgePolicy(parsed: unknown): BridgeExecutionPolicy {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("LONGHUB_BRIDGE_POLICY 必须是对象");
  }
  for (const [agentId, grants] of Object.entries(parsed)) {
    if (!agentId || !Array.isArray(grants)) throw new Error("Bridge policy agent 条目无效");
    for (const grant of grants) {
      if (typeof grant !== "object" || grant === null || Array.isArray(grant)) {
        throw new Error(`Bridge policy grant 无效: ${agentId}`);
      }
      const item = grant as Record<string, unknown>;
      const expectedKeys = [
        "budget", "devicePermissions", "packId", "packPermissions", "packVersion",
        "profilePermissions", "profileVersion", "requiredPermissions", "skillId", "tenantPermissions",
      ];
      if (
        Object.keys(item).sort().join("|") !== expectedKeys.sort().join("|") ||
        ![item.skillId, item.packId, item.packVersion, item.profileVersion].every(
          (value) => typeof value === "string" && value.length > 0,
        ) ||
        ![
          item.requiredPermissions,
          item.profilePermissions,
          item.packPermissions,
          item.tenantPermissions,
          item.devicePermissions,
        ].every(isStringArray) ||
        !isBudget(item.budget)
      ) throw new Error(`Bridge policy grant 无效: ${agentId}`);
    }
  }
  return parsed as BridgeExecutionPolicy;
}

function loadBridgePolicy(): BridgeExecutionPolicy {
  const raw = process.env.LONGHUB_BRIDGE_POLICY;
  if (!raw) return {};
  if (raw.length > 1_000_000) throw new Error("LONGHUB_BRIDGE_POLICY 超出大小限制");
  return parseBridgePolicy(JSON.parse(raw) as unknown);
}

function parseTaskSubmitParams(value: unknown): Parameters<CoreRuntime["submitTask"]>[0] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("task.submit 参数必须是对象");
  }
  const params = value as Record<string, unknown>;
  const allowed = new Set(["idempotencyKey", "skillId", "input", "budget"]);
  const unexpected = Object.keys(params).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) throw new Error(`task.submit 包含禁止字段: ${unexpected.join(", ")}`);
  if (
    typeof params.idempotencyKey !== "string" || params.idempotencyKey.length === 0 ||
    typeof params.skillId !== "string" || params.skillId.length === 0 ||
    (params.budget !== undefined && !isBudget(params.budget))
  ) throw new Error("task.submit 参数无效");
  return params as unknown as Parameters<CoreRuntime["submitTask"]>[0];
}

function parseConfirmationResponse(
  value: unknown,
): Parameters<CoreRuntime["respondBridgeConfirmation"]>[0] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("confirm.respond 参数必须是对象");
  }
  const params = value as Record<string, unknown>;
  if (
    Object.keys(params).sort().join("|") !== "approved|confirmationId" ||
    typeof params.confirmationId !== "string" || params.confirmationId.length === 0 ||
    typeof params.approved !== "boolean"
  ) throw new Error("confirm.respond 参数无效");
  return params as unknown as Parameters<CoreRuntime["respondBridgeConfirmation"]>[0];
}

const workerPath = fileURLToPath(new URL("./skill-worker.js", import.meta.url));
const worker = spawn(process.execPath, [workerPath], {
  stdio: ["pipe", "pipe", "inherit"],
});

let workerReqSeq = 0;
const pendingWorker = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (err: Error) => void }
>();

const workerChannel = createLineChannel(worker.stdout!, worker.stdin!, (msg: RpcMessage) => {
  if (!isResponse(msg)) return;
  const pending = pendingWorker.get(msg.id);
  if (!pending) return;
  pendingWorker.delete(msg.id);
  if (msg.error) pending.reject(new Error(msg.error.message));
  else pending.resolve(msg.result);
});

const executor: SkillExecutor = {
  execute(skillId, input, grantedPermissions, budget: CoreBudget) {
    const id = `w-${++workerReqSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingWorker.delete(id);
        reject(new Error(`技能执行超出预算时长 ${budget.maxDurationMs}ms`));
      }, budget.maxDurationMs);
      pendingWorker.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      workerChannel.send({
        rpc: RPC_VERSION,
        id,
        method: "skill.execute",
        params: { skillId, input, grantedPermissions, taskId: id },
      });
    });
  },
  abort() {
    // 原型阶段：取消由 Core 状态机处理，Worker 中止在阶段 1 实现
  },
};

const runtime = new CoreRuntime({
  executor,
  bridgePolicy: loadBridgePolicy(),
  verifyBridgeEntitlement: createEntitlementVerifier(process.env),
  onEvent(event) {
    mainChannel.send({ rpc: RPC_VERSION, method: "event.task", params: { ...event } });
  },
  onConfirmationRequest(request) {
    mainChannel.send({ rpc: RPC_VERSION, method: "event.confirm.request", params: { ...request } });
  },
});

const mainChannel = createLineChannel(process.stdin, process.stdout, (msg: RpcMessage) => {
  if (!isRequest(msg)) return;
  void (async () => {
    try {
      let result: unknown;
      switch (msg.method) {
        case "core.hello":
          result = runtime.hello();
          break;
        case "task.submit":
          result = runtime.submitTask(parseTaskSubmitParams(msg.params));
          break;
        case "task.get":
          result = runtime.getTask((msg.params as { taskId: string }).taskId);
          break;
        case "task.cancel":
          result = runtime.cancelTask((msg.params as { taskId: string }).taskId);
          break;
        case "bridge.execute":
          result = await runtime.executeBridgeSkill(
            msg.params as Parameters<CoreRuntime["executeBridgeSkill"]>[0],
          );
          break;
        case "bridge.policy.replace":
          result = runtime.replaceBridgePolicy(parseBridgePolicy(msg.params));
          break;
        case "confirm.respond":
          result = runtime.respondBridgeConfirmation(parseConfirmationResponse(msg.params));
          break;
        default:
          mainChannel.send({
            rpc: RPC_VERSION,
            id: msg.id,
            error: {
              code: "METHOD_NOT_FOUND",
              message: `方法不在白名单: ${msg.method}`,
              retryable: false,
            },
          });
          return;
      }
      mainChannel.send({ rpc: RPC_VERSION, id: msg.id, result });
    } catch (err) {
      mainChannel.send({
        rpc: RPC_VERSION,
        id: msg.id,
        error: {
          code: err instanceof Error && "code" in err ? String(err.code) : "INTERNAL",
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
        },
      });
    }
  })();
});

process.on("exit", () => worker.kill());
