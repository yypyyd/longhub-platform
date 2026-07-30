import { createServer, type Server } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GatewaySupervisor, EMBEDDING_ENV_PRESET, recoverStaleOpenClawStartupLease, resolveGatewayPort, type GatewayState } from "../src/gateway-supervisor.js";

function listenOnRandomLoopbackPort(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("未取得测试端口"));
      resolve({ server, port: address.port });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}

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
  it("清理无活 Gateway 持有的启动迁移租约", async () => {
    const root = mkdtempSync(join(tmpdir(), "longhub-lease-recovery-"));
    const stateDir = join(root, "openclaw");
    const databasePath = join(stateDir, "state", "openclaw.sqlite");
    mkdirSync(join(stateDir, "state"), { recursive: true });
    const initScript = `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1]);
      db.exec("CREATE TABLE state_leases (scope TEXT, lease_key TEXT, owner TEXT, expires_at INTEGER, heartbeat_at INTEGER, payload_json TEXT, created_at INTEGER, updated_at INTEGER)");
      db.prepare("INSERT INTO state_leases VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("startup-migrations", "global", "dead-owner", Date.now() + 300000, Date.now() - 20000, "{}", Date.now(), Date.now());
      db.close();
    `;
    try {
      execFileSync(process.execPath, ["-e", initScript, databasePath]);
      expect(await recoverStaleOpenClawStartupLease({
        nodeExecutable: process.execPath,
        stateDir,
        configPath: join(stateDir, "openclaw.json"),
        minHeartbeatAgeMs: 0,
      })).toBe(true);
      const count = execFileSync(process.execPath, ["-e", `
        const { DatabaseSync } = require("node:sqlite");
        const db = new DatabaseSync(process.argv[1]);
        process.stdout.write(String(db.prepare("SELECT count(*) AS count FROM state_leases").get().count));
        db.close();
      `, databasePath], { encoding: "utf8" });
      expect(count).toBe("0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("默认端口被占用时自动选择其他回环端口，且不复用未知服务", async () => {
    const { server, port } = await listenOnRandomLoopbackPort();
    try {
      const selected = await resolveGatewayPort(port);
      expect(selected).toBeGreaterThan(0);
      expect(selected).not.toBe(port);
      await expect(resolveGatewayPort(port, false)).rejects.toThrow(`Gateway 端口 ${port} 已被占用`);
    } finally {
      await closeServer(server);
    }
  });

  it("约定端口空闲时保持使用该端口", async () => {
    const { server, port } = await listenOnRandomLoopbackPort();
    await closeServer(server);
    expect(await resolveGatewayPort(port)).toBe(port);
  });

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

  it("向 Gateway 子进程注入宿主提供的环境变量", async () => {
    const states: GatewayState[] = [];
    const supervisor = new GatewaySupervisor({
      nodeExecutable: process.execPath,
      entryScript: "-e",
      args: [
        "if (process.env.LONGHUB_TEST_GATEWAY_TOKEN !== 'injected') process.exit(2); setInterval(() => {}, 1000)",
      ],
      env: { LONGHUB_TEST_GATEWAY_TOKEN: "injected" },
      onStateChange: (s) => states.push(s),
    });
    supervisor.start();
    const running = await waitFor(states, (s) => s.phase === "running");
    expect(running.phase).toBe("running");
    await supervisor.stop();
    expect(states.some((s) => s.phase === "failed")).toBe(false);
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
    expect(states.filter((s) => s.phase === "restarting")).toEqual([
      { phase: "restarting", attempt: 2, delayMs: 10, exitCode: 1 },
      { phase: "restarting", attempt: 3, delayMs: 20, exitCode: 1 },
    ]);
    await supervisor.stop();
  });

  it("真实健康确认会清零连续失败计数", async () => {
    const states: GatewayState[] = [];
    const supervisor = new GatewaySupervisor({
      nodeExecutable: process.execPath,
      entryScript: "-e",
      args: ["setTimeout(() => process.exit(1), 80)"],
      maxRestarts: 1,
      restartBackoffMs: 10,
      onStateChange: (s) => states.push(s),
    });
    supervisor.start();
    await waitFor(states, (s) => s.phase === "running");
    await waitFor(
      states,
      (s) => s.phase === "running" && states.filter((item) => item.phase === "running").length >= 2,
    );
    supervisor.markHealthy();
    await waitFor(
      states,
      (s) => s.phase === "running" && states.filter((item) => item.phase === "running").length >= 3,
    );
    expect(states.some((s) => s.phase === "failed")).toBe(false);
    await supervisor.stop();
  });

  it("宿主受控重启会合并并发请求且只保留一个 Gateway", async () => {
    const states: GatewayState[] = [];
    const supervisor = new GatewaySupervisor({
      nodeExecutable: process.execPath,
      entryScript: "-e",
      args: ["setInterval(() => {}, 1000)"],
      onStateChange: (state) => states.push(state),
    });
    supervisor.start();
    const first = await waitFor(states, (state) => state.phase === "running");

    await Promise.all([supervisor.restart(), supervisor.restart()]);
    const second = await waitFor(
      states,
      (state) => state.phase === "running" && state.pid !== first.pid,
    );

    expect(second.phase).toBe("running");
    expect(states.filter((state) => state.phase === "stopped")).toHaveLength(1);
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
