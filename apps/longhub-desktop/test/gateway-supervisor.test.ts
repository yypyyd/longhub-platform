import { describe, expect, it } from "vitest";
import { GatewaySupervisor, EMBEDDING_ENV_PRESET, type GatewayState } from "../src/gateway-supervisor.js";

function waitFor(states: GatewayState[], predicate: (s: GatewayState) => boolean, timeoutMs = 8000) {
  return new Promise<GatewayState>((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      const hit = states.find(predicate);
      if (hit) {
        clearInterval(timer);
        resolve(hit);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`等待状态超时: ${JSON.stringify(states)}`));
      }
    }, 20);
  });
}

describe("GatewaySupervisor", () => {
  it("启动常驻子进程并在 stop 时回收", async () => {
    const states: GatewayState[] = [];
    const supervisor = new GatewaySupervisor({
      nodeExecutable: process.execPath,
      entryScript: "-e",
      args: ["setInterval(() => {}, 1000)"],
      onStateChange: (s) => states.push(s),
    });
    supervisor.start();
    const running = await waitFor(states, (s) => s.phase === "running");
    expect(running.phase).toBe("running");
    expect(supervisor.pid).toBeGreaterThan(0);

    await supervisor.stop();
    expect(states.at(-1)?.phase).toBe("stopped");
  });

  it("退出码 78 视为配置错误且不自动重启", async () => {
    const states: GatewayState[] = [];
    const supervisor = new GatewaySupervisor({
      nodeExecutable: process.execPath,
      entryScript: "-e",
      args: ["process.exit(78)"],
      restartBackoffMs: 10,
      onStateChange: (s) => states.push(s),
    });
    supervisor.start();
    await waitFor(states, (s) => s.phase === "config-error");
    expect(states.filter((s) => s.phase === "starting")).toHaveLength(1);
    await supervisor.stop();
  });

  it("意外退出按退避重启，超过上限后报 failed", async () => {
    const states: GatewayState[] = [];
    const supervisor = new GatewaySupervisor({
      nodeExecutable: process.execPath,
      entryScript: "-e",
      args: ["process.exit(1)"],
      maxRestarts: 2,
      restartBackoffMs: 10,
      onStateChange: (s) => states.push(s),
    });
    supervisor.start();
    const failed = await waitFor(states, (s) => s.phase === "failed");
    expect(failed).toEqual({ phase: "failed", exitCode: 1, restartsExhausted: true });
    expect(states.filter((s) => s.phase === "starting")).toHaveLength(3);
    await supervisor.stop();
  });

  it("嵌入式环境变量预设与上游 embedding 文档一致", () => {
    expect(EMBEDDING_ENV_PRESET).toEqual({
      OPENCLAW_DISABLE_BONJOUR: "1",
      OPENCLAW_EXEC_SHELL_SNAPSHOT: "0",
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
    });
  });
});
