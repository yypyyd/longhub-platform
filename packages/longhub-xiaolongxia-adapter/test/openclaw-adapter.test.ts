import { describe, expect, it } from "vitest";
import { createOpenClawAdapter, mapChatEvent, type GatewayTransport } from "../src/openclaw-adapter.js";
import type { UpstreamEvent } from "../src/adapter.js";

/** 内存假网关：按 Gateway WS 协议 v4 帧格式应答 connect / sessions.create / chat.send */
function createFakeGateway(behavior?: {
  chatEvents?: (sessionKey: string) => Array<Record<string, unknown>>;
  rejectConnect?: boolean;
}) {
  let deliver: (text: string) => void = () => {};
  const received: Array<{ method: string; params: Record<string, unknown> }> = [];

  const transport: GatewayTransport = {
    send(text) {
      const frame = JSON.parse(text) as { id: string; method: string; params: Record<string, unknown> };
      received.push({ method: frame.method, params: frame.params });
      const respond = (ok: boolean, payload?: unknown, error?: unknown) =>
        deliver(JSON.stringify({ type: "res", id: frame.id, ok, payload, error }));

      if (frame.method === "connect") {
        if (behavior?.rejectConnect) {
          respond(false, undefined, { code: "UNAVAILABLE", message: "startup-sidecars", retryable: true });
        } else {
          respond(true, { type: "hello-ok", protocol: 4 });
        }
        return;
      }
      if (frame.method === "sessions.create") {
        respond(true, { key: `sess-${String(frame.params.agentId)}` });
        return;
      }
      if (frame.method === "chat.send") {
        respond(true, { runId: "run-1" });
        const sessionKey = String(frame.params.sessionKey);
        for (const payload of behavior?.chatEvents?.(sessionKey) ?? []) {
          deliver(JSON.stringify({ type: "event", event: "chat", payload }));
        }
      }
    },
    onMessage(handler) {
      deliver = handler;
    },
    onClose() {},
    close() {},
  };
  return { transport, received };
}

describe("OpenClaw Gateway 适配器", () => {
  it("init 握手 → 建会话 → chat.send 流式 delta → done", async () => {
    const gateway = createFakeGateway({
      chatEvents: (sessionKey) => [
        { sessionKey, runId: "run-1", seq: 0, state: "delta", deltaText: "你好" },
        { sessionKey, runId: "run-1", seq: 1, state: "delta", deltaText: "，龙枢" },
        { sessionKey: "other", runId: "run-x", seq: 0, state: "delta", deltaText: "串话" },
        { sessionKey, runId: "run-1", seq: 2, state: "final" },
      ],
    });
    const adapter = createOpenClawAdapter({
      gatewayUrl: "ws://fake",
      createTransport: async () => gateway.transport,
    });
    await adapter.init();
    const session = await adapter.createSession("longhub.agent.hr");
    expect(session.sessionId).toBe("sess-longhub.agent.hr");

    const events: UpstreamEvent[] = [];
    for await (const event of adapter.sendMessage(session, "查询年假")) events.push(event);

    expect(events).toEqual([
      { type: "delta", text: "你好" },
      { type: "delta", text: "，龙枢" },
      { type: "done", finalText: "你好，龙枢" },
    ]);

    const connect = gateway.received[0]!;
    expect(connect.method).toBe("connect");
    expect(connect.params.role).toBe("operator");
    expect(connect.params.minProtocol).toBe(4);
    const send = gateway.received.find((r) => r.method === "chat.send")!;
    expect(send.params.idempotencyKey).toBeTruthy();
    await adapter.dispose();
  });

  it("上游 error 事件映射为契约 error（timeout 可重试）", async () => {
    const gateway = createFakeGateway({
      chatEvents: (sessionKey) => [
        { sessionKey, runId: "run-1", seq: 0, state: "error", errorKind: "timeout", errorMessage: "运行超时" },
      ],
    });
    const adapter = createOpenClawAdapter({
      gatewayUrl: "ws://fake",
      createTransport: async () => gateway.transport,
    });
    await adapter.init();
    const session = await adapter.createSession("a");
    const events: UpstreamEvent[] = [];
    for await (const event of adapter.sendMessage(session, "x")) events.push(event);
    expect(events).toEqual([{ type: "error", code: "timeout", message: "运行超时", retryable: true }]);
  });

  it("connect 被拒时 init 抛错", async () => {
    const gateway = createFakeGateway({ rejectConnect: true });
    const adapter = createOpenClawAdapter({
      gatewayUrl: "ws://fake",
      createTransport: async () => gateway.transport,
    });
    await expect(adapter.init()).rejects.toThrow("startup-sidecars");
  });

  it("未初始化时拒绝建会话", async () => {
    const adapter = createOpenClawAdapter({ gatewayUrl: "ws://fake" });
    await expect(adapter.createSession("a")).rejects.toThrow("未初始化");
  });
});

describe("mapChatEvent", () => {
  it("replace=true 时用 deltaText 整体替换累计文本", () => {
    const acc = { text: "旧内容" };
    const event = mapChatEvent(
      { sessionKey: "s", state: "delta", deltaText: "新内容", replace: true },
      "s",
      acc,
    );
    expect(event).toEqual({ type: "delta", text: "新内容" });
    expect(acc.text).toBe("新内容");
  });

  it("aborted 映射为不可重试的 ABORTED", () => {
    expect(mapChatEvent({ sessionKey: "s", state: "aborted" }, "s", { text: "" })).toEqual({
      type: "error",
      code: "ABORTED",
      message: "运行已被取消",
      retryable: false,
    });
  });
});
