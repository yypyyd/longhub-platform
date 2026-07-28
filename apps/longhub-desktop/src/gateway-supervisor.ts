import { spawn, type ChildProcess } from "node:child_process";

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
  /** 意外退出后的最大自动重启次数 */
  maxRestarts?: number;
  /** 重启退避基数（毫秒），第 n 次重启等待 base * 2^(n-1) */
  restartBackoffMs?: number;
  onStateChange?: (state: GatewayState) => void;
}

export type GatewayState =
  | { phase: "starting"; attempt: number }
  | { phase: "running"; pid: number }
  | { phase: "config-error"; exitCode: 78 }
  | { phase: "failed"; exitCode: number | null; restartsExhausted: boolean }
  | { phase: "stopped" };

const EX_CONFIG = 78;

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

  constructor(private readonly options: GatewaySupervisorOptions) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): void {
    this.stopping = false;
    this.spawnChild();
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
        env: { ...process.env, ...EMBEDDING_ENV_PRESET },
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
      this.restartTimer = setTimeout(() => this.spawnChild(), backoff);
      this.restartTimer.unref();
    });
  }

  private emit(state: GatewayState): void {
    this.options.onStateChange?.(state);
  }
}
