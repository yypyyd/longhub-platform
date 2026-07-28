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
} from "@longhub/core";

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
  onEvent(event) {
    mainChannel.send({ rpc: RPC_VERSION, method: "event.task", params: { ...event } });
  },
});

const mainChannel = createLineChannel(process.stdin, process.stdout, (msg: RpcMessage) => {
  if (!isRequest(msg)) return;
  try {
    let result: unknown;
    switch (msg.method) {
      case "core.hello":
        result = runtime.hello();
        break;
      case "task.submit":
        result = runtime.submitTask(
          msg.params as Parameters<CoreRuntime["submitTask"]>[0],
        );
        break;
      case "task.get":
        result = runtime.getTask((msg.params as { taskId: string }).taskId);
        break;
      case "task.cancel":
        result = runtime.cancelTask((msg.params as { taskId: string }).taskId);
        break;
      default:
        mainChannel.send({
          rpc: RPC_VERSION,
          id: msg.id,
          error: { code: "METHOD_NOT_FOUND", message: `方法不在白名单: ${msg.method}`, retryable: false },
        });
        return;
    }
    mainChannel.send({ rpc: RPC_VERSION, id: msg.id, result });
  } catch (err) {
    mainChannel.send({
      rpc: RPC_VERSION,
      id: msg.id,
      error: {
        code: "INTERNAL",
        message: err instanceof Error ? err.message : String(err),
        retryable: false,
      },
    });
  }
});

process.on("exit", () => worker.kill());
