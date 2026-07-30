import { describe, expect, it, vi } from "vitest";
import {
  GatewayRuntimeRecovery,
  waitForGatewayChatPage,
} from "../src/gateway-runtime-recovery.js";
import type { ProductStatusCode } from "../src/product-error-page.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("GatewayRuntimeRecovery", () => {
  it("退避重启时进入自动恢复页，真实健康后才回到原生聊天页", async () => {
    const statuses: ProductStatusCode[] = [];
    const restore = vi.fn();
    const recovery = new GatewayRuntimeRecovery({
      probeChatPage: async () => true,
      showStatus: (code) => { statuses.push(code); },
      restoreChatPage: restore,
    });

    recovery.handle({ phase: "restarting", attempt: 2, delayMs: 1_000, exitCode: 1 });
    recovery.handle({ phase: "starting", attempt: 2 });
    recovery.handle({ phase: "running", pid: 42 });
    await flush();

    expect(statuses).toEqual(["GATEWAY_RECONNECTING"]);
    expect(restore).toHaveBeenCalledWith(42);
  });

  it("配置错误和重启耗尽进入不同的固定安全错误页", () => {
    const statuses: ProductStatusCode[] = [];
    const recovery = new GatewayRuntimeRecovery({
      probeChatPage: async () => false,
      showStatus: (code) => { statuses.push(code); },
      restoreChatPage: vi.fn(),
    });

    recovery.handle({ phase: "config-error", exitCode: 78 });
    recovery.handle({ phase: "failed", exitCode: 1, restartsExhausted: true });

    expect(statuses).toEqual(["GATEWAY_CONFIG_ERROR", "GATEWAY_RESTART_EXHAUSTED"]);
  });

  it("丢弃旧进程迟到的健康结果，不能覆盖终止错误页", async () => {
    const health = deferred<boolean>();
    const statuses: ProductStatusCode[] = [];
    const restore = vi.fn();
    const recovery = new GatewayRuntimeRecovery({
      probeChatPage: () => health.promise,
      showStatus: (code) => { statuses.push(code); },
      restoreChatPage: restore,
    });

    recovery.handle({ phase: "running", pid: 42 });
    recovery.handle({ phase: "config-error", exitCode: 78 });
    health.resolve(true);
    await flush();

    expect(statuses.at(-1)).toBe("GATEWAY_CONFIG_ERROR");
    expect(restore).not.toHaveBeenCalled();
  });

  it("子进程存在但真实聊天页不健康时显示服务不可用", async () => {
    const statuses: ProductStatusCode[] = [];
    const recovery = new GatewayRuntimeRecovery({
      probeChatPage: async () => false,
      showStatus: (code) => { statuses.push(code); },
      restoreChatPage: vi.fn(),
    });

    recovery.handle({ phase: "running", pid: 42 });
    await flush();
    expect(statuses).toEqual(["SERVICE_UNAVAILABLE"]);
  });

  it("休眠恢复后先复检真实聊天页，健康时直接恢复界面", async () => {
    const statuses: ProductStatusCode[] = [];
    const restore = vi.fn();
    const restart = vi.fn(async () => {});
    const recovery = new GatewayRuntimeRecovery({
      probeChatPage: async () => true,
      showStatus: (code) => { statuses.push(code); },
      restoreChatPage: restore,
    });

    recovery.handleHostResume(42, restart);
    await flush();

    expect(statuses).toEqual(["GATEWAY_RECONNECTING"]);
    expect(restore).toHaveBeenCalledWith(42);
    expect(restart).not.toHaveBeenCalled();
  });

  it("休眠恢复后页面不健康或 PID 已消失时受控重启", async () => {
    const restart = vi.fn(async () => {});
    const recovery = new GatewayRuntimeRecovery({
      probeChatPage: async () => false,
      showStatus: vi.fn(),
      restoreChatPage: vi.fn(),
    });

    recovery.handleHostResume(42, restart);
    await flush();
    recovery.handleHostResume(undefined, restart);
    await flush();

    expect(restart).toHaveBeenCalledTimes(2);
  });

  it("休眠复检的迟到结果不能覆盖新的终止状态", async () => {
    const health = deferred<boolean>();
    const restore = vi.fn();
    const recovery = new GatewayRuntimeRecovery({
      probeChatPage: () => health.promise,
      showStatus: vi.fn(),
      restoreChatPage: restore,
    });

    recovery.handleHostResume(42, vi.fn(async () => {}));
    recovery.handle({ phase: "failed", exitCode: 1, restartsExhausted: true });
    health.resolve(true);
    await flush();

    expect(restore).not.toHaveBeenCalled();
  });
});

describe("waitForGatewayChatPage", () => {
  it("只有 2xx HTML `/chat` 才视为真实健康，并且不发送 fragment Token", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      seen.push(String(input));
      if (seen.length === 1) return new Response("busy", { status: 503 });
      return new Response("<!doctype html>", { headers: { "content-type": "text/html; charset=utf-8" } });
    }) as typeof fetch;

    await expect(waitForGatewayChatPage(
      "http://127.0.0.1:18789/chat?gatewayUrl=ws%3A%2F%2F127.0.0.1%3A18789#token=secret",
      100,
      { fetchImpl, retryIntervalMs: 1 },
    )).resolves.toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen.every((url) => url.includes("/chat"))).toBe(true);
    expect(seen.every((url) => !url.includes("secret"))).toBe(true);
  });

  it("JSON 健康响应不能冒充产品聊天页", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", {
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    await expect(waitForGatewayChatPage("http://127.0.0.1:18789/chat", 5, {
      fetchImpl,
      retryIntervalMs: 1,
      requestTimeoutMs: 2,
    })).resolves.toBe(false);
  });

  it("进程已退出时立即终止健康探测", async () => {
    let aborted = false;
    let requests = 0;
    const fetchImpl = vi.fn(async () => {
      requests += 1;
      aborted = true;
      return new Response("busy", { status: 503 });
    }) as typeof fetch;
    await expect(waitForGatewayChatPage("http://127.0.0.1:18789/chat", 10_000, {
      fetchImpl,
      shouldAbort: () => aborted,
    })).resolves.toBe(false);
    expect(requests).toBe(1);
  });
});
