import type { GatewayState } from "./gateway-supervisor.js";
import type { ProductStatusCode } from "./product-error-page.js";

export interface GatewayRuntimeRecoveryOptions {
  /** 必须验证真实 `/chat` HTTP 页面，不能只依据子进程 PID 或 TCP 端口。 */
  probeChatPage: (pid: number, reason: "runtime" | "resume") => Promise<boolean>;
  showStatus: (code: ProductStatusCode) => void | Promise<void>;
  restoreChatPage: (pid: number) => void | Promise<void>;
}

/**
 * 把 Supervisor 进程状态转换为产品页面状态。使用 cycle 丢弃旧进程的异步健康结果，
 * 避免一次迟到的成功探测覆盖更新后的终止错误页。
 */
export class GatewayRuntimeRecovery {
  private cycle = 0;

  constructor(private readonly options: GatewayRuntimeRecoveryOptions) {}

  handle(state: GatewayState): void {
    if (state.phase === "restarting") {
      this.cycle += 1;
      void this.options.showStatus("GATEWAY_RECONNECTING");
      return;
    }
    if (state.phase === "config-error") {
      this.cycle += 1;
      void this.options.showStatus("GATEWAY_CONFIG_ERROR");
      return;
    }
    if (state.phase === "failed") {
      this.cycle += 1;
      void this.options.showStatus("GATEWAY_RESTART_EXHAUSTED");
      return;
    }
    if (state.phase === "stopped") {
      this.cycle += 1;
      return;
    }
    if (state.phase !== "running") return;
    const expectedCycle = this.cycle;
    void this.recover(state.pid, expectedCycle);
  }

  /**
   * Windows 从休眠恢复后，旧 PID 仍存在也不能证明网络和 `/chat` 可用。
   * 先复检真实页面；失败时由宿主受控重启，后续仍走正常 Supervisor 状态机。
   */
  handleHostResume(pid: number | undefined, restartGateway: () => Promise<void>): void {
    const expectedCycle = ++this.cycle;
    void this.options.showStatus("GATEWAY_RECONNECTING");
    void this.recoverHostResume(pid, restartGateway, expectedCycle);
  }

  private async recover(pid: number, expectedCycle: number): Promise<void> {
    const ready = await this.options.probeChatPage(pid, "runtime");
    if (this.cycle !== expectedCycle) return;
    if (!ready) {
      await this.options.showStatus("SERVICE_UNAVAILABLE");
      return;
    }
    await this.options.restoreChatPage(pid);
  }

  private async recoverHostResume(
    pid: number | undefined,
    restartGateway: () => Promise<void>,
    expectedCycle: number,
  ): Promise<void> {
    try {
      if (pid !== undefined && await this.options.probeChatPage(pid, "resume")) {
        if (this.cycle === expectedCycle) await this.options.restoreChatPage(pid);
        return;
      }
      if (this.cycle !== expectedCycle) return;
      await restartGateway();
    } catch {
      if (this.cycle === expectedCycle) await this.options.showStatus("SERVICE_UNAVAILABLE");
    }
  }
}

export interface ChatPageProbeOptions {
  fetchImpl?: typeof fetch;
  retryIntervalMs?: number;
  requestTimeoutMs?: number;
  shouldAbort?: () => boolean;
}

/** 等待真实 HTML `/chat` 响应；fragment Token 不进入 HTTP 请求。 */
export async function waitForGatewayChatPage(
  controlUiUrl: string,
  timeoutMs: number,
  options: ChatPageProbeOptions = {},
): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const retryIntervalMs = options.retryIntervalMs ?? 500;
  const requestTimeoutMs = options.requestTimeoutMs ?? 3_000;
  const requestUrl = new URL(controlUiUrl);
  requestUrl.hash = "";
  const deadline = Date.now() + timeoutMs;
  do {
    if (options.shouldAbort?.()) return false;
    const remaining = Math.max(1, deadline - Date.now());
    try {
      const response = await fetchImpl(requestUrl, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(requestTimeoutMs, remaining)),
      });
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (response.ok && contentType.includes("text/html")) return true;
    } catch {
      // 服务重启窗口内连接拒绝和请求超时都属于预期状态，继续限频探测。
    }
    if (options.shouldAbort?.()) return false;
    if (Date.now() >= deadline) break;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(retryIntervalMs, deadline - Date.now())));
  } while (Date.now() < deadline);
  return false;
}
