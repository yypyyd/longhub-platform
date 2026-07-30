/**
 * 阶段 0 多进程原型驱动：模拟 Desktop Main 拉起 Core 进程，
 * 完成 core.hello → task.submit（本地技能）→ 收取任务事件 → 校验结果。
 * 运行：node dist/prototype.js
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createConsoleLogger } from "@longhub/observability";
import {
  createLineChannel,
  isResponse,
  RPC_VERSION,
  type RpcMessage,
} from "@longhub/core";

const corePath = fileURLToPath(new URL("./core-process.js", import.meta.url));
const logger = createConsoleLogger("desktop-prototype");
const core = spawn(process.execPath, [corePath], { stdio: ["pipe", "pipe", "inherit"] });

let reqSeq = 0;
const pending = new Map<string, (msg: RpcMessage & { result?: unknown }) => void>();
const events: string[] = [];

const channel = createLineChannel(core.stdout!, core.stdin!, (msg) => {
  if (isResponse(msg)) {
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  } else if ("method" in msg && msg.method === "event.task") {
    const params = msg.params as { type: string; task_id: string };
    events.push(params.type);
    logger.info("prototype.task_event", { task_id: params.task_id, event_type: params.type });
  }
});

function call(method: string, params?: Record<string, unknown>): Promise<unknown> {
  const id = `m-${++reqSeq}`;
  return new Promise((resolve, reject) => {
    pending.set(id, (msg) => {
      if ("error" in msg && msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    });
    channel.send({ rpc: RPC_VERSION, id, method, params });
  });
}

async function main(): Promise<void> {
  const hello = (await call("core.hello")) as { coreRpcVersion: string };
  logger.info("prototype.core_ready", { core_rpc_version: hello.coreRpcVersion });

  const task = (await call("task.submit", {
    idempotencyKey: "proto-1",
    skillId: "longhub.skill.echo-upper",
    input: { text: "longhub" },
  })) as { taskId: string };
  logger.info("prototype.task_submitted", { task_id: task.taskId });

  // 幂等验证：同一幂等键必须返回同一任务
  const dup = (await call("task.submit", {
    idempotencyKey: "proto-1",
    skillId: "longhub.skill.echo-upper",
    input: { text: "longhub" },
  })) as { taskId: string };
  if (dup.taskId !== task.taskId) throw new Error("幂等键未生效");

  // 轮询到终态
  for (let i = 0; i < 50; i++) {
    const t = (await call("task.get", { taskId: task.taskId })) as {
      status: string;
      output?: { text: string };
    };
    if (t.status === "succeeded") {
      if (t.output?.text !== "LONGHUB") throw new Error(`输出错误: ${JSON.stringify(t.output)}`);
      logger.info("prototype.task_succeeded", { task_id: task.taskId, event_types: events });
      core.kill();
      process.exit(0);
    }
    if (["failed", "cancelled", "timed_out"].includes(t.status)) {
      throw new Error(`任务终态异常: ${t.status}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("任务超时未完成");
}

main().catch((err) => {
  logger.error("prototype.failed", { error: err });
  core.kill();
  process.exit(1);
});
