import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

/**
 * OpenClaw Gateway 进程托管（Windows 桌面端）。
 * 依据上游 docs/gateway/embedding.md：宿主用真实 Node 运行时拉起 openclaw 包入口，
 * 通过嵌入式环境变量预设关闭 Bonjour/自重启/渠道，退出码 78（EX_CONFIG）表示配置类
 * 启动失败，应走 doctor 修复而不是盲目重启。
 */

export interface GatewaySupervisorOptions {
  /** 真实 Node 运行时绝对路径（Electron 下不能用 process.execPath） */
  nodeExecutable: string;
  /** openclaw 包入口脚本绝对路径（openclaw.mjs） */
  entryScript: string;
  /** 额外 CLI 参数，缺省 ["gateway", "--allow-unconfigured"] */
  args?: readonly string[];
  /** 仅注入 Gateway 子进程的环境变量（例如本机共享令牌） */
  env?: NodeJS.ProcessEnv;
  /** 意外退出后的最大自动重启次数 */
  maxRestarts?: number;
  /** 重启退避基数（毫秒），第 n 次重启等待 base * 2^(n-1) */
  restartBackoffMs?: number;
  onStateChange?: (state: GatewayState) => void;
}

export type GatewayState =
  | { phase: "starting"; attempt: number }
  | { phase: "running"; pid: number }
  | { phase: "restarting"; attempt: number; delayMs: number; exitCode: number | null }
  | { phase: "config-error"; exitCode: 78 }
  | { phase: "failed"; exitCode: number | null; restartsExhausted: boolean }
  | { phase: "stopped" };

const EX_CONFIG = 78;
const execFileAsync = promisify(execFile);

interface OpenClawGatewayLock {
  pid?: number;
  configPath?: string;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** OpenClaw 的临时 Gateway 锁含 PID 与 configPath，可避免误清理仍在迁移的活进程。 */
function hasLiveGatewayForConfig(configPath: string): boolean {
  const lockDir = join(tmpdir(), "openclaw");
  if (!existsSync(lockDir)) return false;
  const expected = resolve(configPath).toLowerCase();
  for (const name of readdirSync(lockDir)) {
    if (!name.startsWith("gateway.") || !name.endsWith(".lock")) continue;
    try {
      const lock = JSON.parse(readFileSync(join(lockDir, name), "utf8")) as OpenClawGatewayLock;
      if (
        typeof lock.pid === "number" &&
        typeof lock.configPath === "string" &&
        resolve(lock.configPath).toLowerCase() === expected &&
        processIsAlive(lock.pid)
      ) return true;
    } catch {
      // 其他 OpenClaw 实例留下的损坏/空锁不属于本客户端，忽略即可。
    }
  }
  return false;
}

const RECOVER_STARTUP_LEASE_SCRIPT = String.raw`
const { DatabaseSync } = require("node:sqlite");
const [dbPath, minAgeRaw] = process.argv.slice(1);
const minAge = Number(minAgeRaw);
const db = new DatabaseSync(dbPath);
const result = { removed: 0, retryAfterMs: 0 };
try {
  const row = db.prepare("SELECT owner, heartbeat_at FROM state_leases WHERE scope = 'startup-migrations' AND lease_key = 'global'").get();
  if (row) {
    const age = Date.now() - Number(row.heartbeat_at);
    if (age >= minAge) {
      const changed = db.prepare("DELETE FROM state_leases WHERE scope = 'startup-migrations' AND lease_key = 'global' AND owner = ? AND heartbeat_at = ?").run(row.owner, row.heartbeat_at);
      result.removed = Number(changed.changes);
    } else {
      result.retryAfterMs = Math.max(0, minAge - age);
    }
  }
} catch (error) {
  if (!String(error && error.message || error).includes("no such table")) throw error;
} finally {
  db.close();
}
process.stdout.write(JSON.stringify(result));
`;

interface LeaseRecoveryResult {
  removed: number;
  retryAfterMs: number;
}

async function recoverLeaseOnce(
  nodeExecutable: string,
  databasePath: string,
  minHeartbeatAgeMs: number,
): Promise<LeaseRecoveryResult> {
  const { stdout } = await execFileAsync(
    nodeExecutable,
    ["-e", RECOVER_STARTUP_LEASE_SCRIPT, databasePath, String(minHeartbeatAgeMs)],
    { encoding: "utf8", timeout: 10_000, windowsHide: true },
  );
  return JSON.parse(stdout) as LeaseRecoveryResult;
}

/**
 * 清理仅属于 LongHub 状态目录、且已无活 Gateway 持有的启动迁移租约。
 * 崩溃后十秒内会先等待，给仍在建立临时 Gateway 锁的合法进程一个安全窗口。
 */
export async function recoverStaleOpenClawStartupLease(options: {
  nodeExecutable: string;
  stateDir: string;
  configPath: string;
  minHeartbeatAgeMs?: number;
}): Promise<boolean> {
  const databasePath = join(options.stateDir, "state", "openclaw.sqlite");
  if (!existsSync(databasePath) || hasLiveGatewayForConfig(options.configPath)) return false;
  const minAge = options.minHeartbeatAgeMs ?? 10_000;
  let result = await recoverLeaseOnce(options.nodeExecutable, databasePath, minAge);
  if (!result.removed && result.retryAfterMs > 0) {
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, result.retryAfterMs + 100));
    if (hasLiveGatewayForConfig(options.configPath)) return false;
    result = await recoverLeaseOnce(options.nodeExecutable, databasePath, minAge);
  }
  return result.removed > 0;
}

/**
 * 探测一个仅绑定回环地址的端口；返回实际端口后立即释放，由 Gateway 随后占用。
 * port=0 时由操作系统分配临时空闲端口。
 */
function probeLoopbackPort(port: number): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    const onError = () => resolve(undefined);
    server.unref();
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.removeListener("error", onError);
      const address = server.address() as AddressInfo;
      server.close((err) => {
        if (err) reject(err);
        else resolve(address.port);
      });
    });
  });
}

/** 优先使用约定端口；被其他程序占用时可回退到操作系统分配的安全空闲端口。 */
export async function resolveGatewayPort(preferredPort = 18789, allowFallback = true): Promise<number> {
  if (!Number.isSafeInteger(preferredPort) || preferredPort < 1 || preferredPort > 65_535) {
    throw new Error(`无效的 Gateway 端口: ${preferredPort}`);
  }
  if ((await probeLoopbackPort(preferredPort)) !== undefined) return preferredPort;
  if (!allowFallback) throw new Error(`Gateway 端口 ${preferredPort} 已被占用`);
  const fallback = await probeLoopbackPort(0);
  if (fallback === undefined) throw new Error("无法分配本机 Gateway 端口");
  return fallback;
}

/** 嵌入式预设：宿主自己负责发现、重启和渠道生命周期 */
export const EMBEDDING_ENV_PRESET: Readonly<Record<string, string>> = {
  OPENCLAW_DISABLE_BONJOUR: "1",
  OPENCLAW_EXEC_SHELL_SNAPSHOT: "0",
  OPENCLAW_NO_RESPAWN: "1",
  OPENCLAW_SKIP_CHANNELS: "1",
};

export class GatewaySupervisor {
  private child: ChildProcess | undefined;
  private restarts = 0;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | undefined;
  private restartOperation: Promise<void> | undefined;

  constructor(private readonly options: GatewaySupervisorOptions) {}

  get pid(): number | undefined {
    return this.child?.exitCode === null ? this.child.pid : undefined;
  }

  start(): void {
    if (this.pid !== undefined) return;
    this.stopping = false;
    this.spawnChild();
  }

  /** 休眠恢复等宿主事件触发的受控重启；并发请求合并为一次，且重新计算连续失败次数。 */
  async restart(): Promise<void> {
    if (this.restartOperation) return this.restartOperation;
    const operation = (async () => {
      await this.stop();
      this.restarts = 0;
      this.start();
    })();
    this.restartOperation = operation;
    try {
      await operation;
    } finally {
      if (this.restartOperation === operation) this.restartOperation = undefined;
    }
  }

  /** 只有真实 `/chat` 健康后才清零，保证阈值表达连续失败而非进程全生命周期累计退出。 */
  markHealthy(): void {
    this.restarts = 0;
  }

  /** 停止并回收子进程；随龙枢退出时必须调用，避免遗留孤儿 Gateway */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.emit({ phase: "stopped" });
      return;
    }
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill();
      // Windows 下 kill 即 TerminateProcess；其他平台兜底强杀
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 3000).unref();
    });
    this.child = undefined;
    this.emit({ phase: "stopped" });
  }

  private spawnChild(): void {
    this.emit({ phase: "starting", attempt: this.restarts + 1 });
    const child = spawn(
      this.options.nodeExecutable,
      [this.options.entryScript, ...(this.options.args ?? ["gateway", "--allow-unconfigured"])],
      {
        env: { ...process.env, ...this.options.env, ...EMBEDDING_ENV_PRESET },
        stdio: ["ignore", "inherit", "inherit"],
        windowsHide: true,
      },
    );
    this.child = child;
    if (child.pid !== undefined) this.emit({ phase: "running", pid: child.pid });

    child.once("exit", (code) => {
      if (this.stopping) return;
      if (code === EX_CONFIG) {
        // 配置类失败：重启无意义，交由上层跑 doctor --fix 后再 start()
        this.emit({ phase: "config-error", exitCode: EX_CONFIG });
        return;
      }
      const maxRestarts = this.options.maxRestarts ?? 3;
      if (this.restarts >= maxRestarts) {
        this.emit({ phase: "failed", exitCode: code, restartsExhausted: true });
        return;
      }
      this.restarts += 1;
      const backoff = (this.options.restartBackoffMs ?? 1000) * 2 ** (this.restarts - 1);
      this.emit({
        phase: "restarting",
        attempt: this.restarts + 1,
        delayMs: backoff,
        exitCode: code,
      });
      this.restartTimer = setTimeout(() => this.spawnChild(), backoff);
      this.restartTimer.unref();
    });
  }

  private emit(state: GatewayState): void {
    this.options.onStateChange?.(state);
  }
}
