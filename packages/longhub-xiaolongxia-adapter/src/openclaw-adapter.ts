import { randomUUID } from "node:crypto";
import type { UpstreamEvent, UpstreamRuntimeAdapter, UpstreamSession } from "./adapter.js";

/**
 * OpenClaw（小龙虾）Gateway 底座适配器。
 * 协议依据上游 docs/gateway/protocol.md（Gateway WS 协议 v4）：
 * - 帧：req {type,id,method,params} / res {type,id,ok,payload|error} / event {type,event,payload}
 * - 握手：首帧必须为 connect（role=operator，scopes=operator.read/write）
 * - 会话：sessions.create；消息：chat.send（幂等键）；流式输出走 chat 事件
 *   （state=delta 携带 deltaText，state=final/aborted/error 为终态）。
 * 龙枢内核只依赖 adapter.ts 契约，本文件是唯一接触上游协议的地方（ADR-LH-009）。
 */

export interface OpenClawAdapterOptions {
  /** OpenClaw Gateway WebSocket 地址，如 ws://127.0.0.1:18789 */
  gatewayUrl: string;
  token?: string;
  /** 单次握手/RPC 超时（毫秒） */
  timeoutMs?: number;
  /** 注入自定义传输层（测试用）；缺省用全局 WebSocket */
  createTransport?: (url: string) => Promise<GatewayTransport>;
}

/** 最小传输抽象：便于用内存假网关做契约测试 */
export interface GatewayTransport {
  send(text: string): void;
  onMessage(handler: (text: string) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

interface GatewayFrame {
  type: "req" | "res" | "event";
  id?: string;
  method?: string;
  params?: unknown;
  ok?: boolean;
  payload?: unknown;
  error?: { code: string; message: string; retryable?: boolean };
  event?: string;
}

interface ChatEventPayload {
  sessionKey: string;
  state: "status" | "delta" | "final" | "aborted" | "error";
  deltaText?: string;
  replace?: boolean;
  errorKind?: string;
  errorMessage?: string;
}

const PROTOCOL_VERSION = 4;
const DEFAULT_TIMEOUT_MS = 15_000;

/** 把上游 chat 事件映射为适配层契约事件；非本会话或无关状态返回 null */
export function mapChatEvent(
  payload: ChatEventPayload,
  sessionKey: string,
  accumulated: { text: string },
): UpstreamEvent | null {
  if (payload.sessionKey !== sessionKey) return null;
  switch (payload.state) {
    case "delta": {
      const delta = payload.deltaText ?? "";
      accumulated.text = payload.replace ? delta : accumulated.text + delta;
      return { type: "delta", text: delta };
    }
    case "final":
      return { type: "done", finalText: accumulated.text };
    case "aborted":
      return { type: "error", code: "ABORTED", message: "运行已被取消", retryable: false };
    case "error":
      return {
        type: "error",
        code: payload.errorKind ?? "UPSTREAM_ERROR",
        message: payload.errorMessage ?? "上游运行失败",
        retryable: payload.errorKind === "timeout" || payload.errorKind === "rate_limit",
      };
    default:
      return null;
  }
}

async function defaultTransport(url: string): Promise<GatewayTransport> {
  const WS = (globalThis as { WebSocket?: new (url: string) => WebSocket }).WebSocket;
  if (!WS) {
    throw new Error("当前运行时没有全局 WebSocket（需要 Node >= 22，见 AUDIT.md Node 引擎区间）");
  }
  const socket = new WS(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error(`OpenClaw Gateway 连接失败: ${url}`)), {
      once: true,
    });
  });
  return {
    send: (text) => socket.send(text),
    onMessage: (handler) =>
      socket.addEventListener("message", (e) => handler(String((e as MessageEvent).data))),
    onClose: (handler) => socket.addEventListener("close", () => handler(), { once: true }),
    close: () => socket.close(),
  };
}

export function createOpenClawAdapter(options: OpenClawAdapterOptions): UpstreamRuntimeAdapter {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let transport: GatewayTransport | undefined;
  let reqSeq = 0;
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const chatListeners = new Set<(payload: ChatEventPayload) => void>();
  let closed = false;

  function handleFrame(text: string): void {
    let frame: GatewayFrame;
    try {
      frame = JSON.parse(text) as GatewayFrame;
    } catch {
      return;
    }
    if (frame.type === "res" && frame.id) {
      const waiter = pending.get(frame.id);
      if (!waiter) return;
      pending.delete(frame.id);
      if (frame.ok) waiter.resolve(frame.payload);
      else waiter.reject(new Error(frame.error?.message ?? "Gateway 请求失败"));
      return;
    }
    if (frame.type === "event" && frame.event === "chat") {
      const payload = frame.payload as ChatEventPayload;
      for (const listener of chatListeners) listener(payload);
    }
  }

  function request(method: string, params: unknown): Promise<unknown> {
    if (!transport) return Promise.reject(new Error("适配器未初始化"));
    const id = `lh-${++reqSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Gateway 请求超时: ${method}`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      transport!.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  return {
    adapterVersion: "1.0",

    async init(): Promise<void> {
      transport = await (options.createTransport ?? defaultTransport)(options.gatewayUrl);
      transport.onMessage(handleFrame);
      transport.onClose(() => {
        closed = true;
        for (const [, waiter] of pending) waiter.reject(new Error("Gateway 连接已关闭"));
        pending.clear();
      });
      await request("connect", {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        // client.id/mode 是上游封闭枚举（packages/gateway-protocol/src/client-info.ts）；
        // 嵌入宿主走受信 backend 类：本机回环 + 共享网关 token，可免设备配对
        client: { id: "gateway-client", version: "0.1.0", platform: "windows", mode: "backend" },
        role: "operator",
        scopes: ["operator.read", "operator.write"],
        caps: [],
        commands: [],
        permissions: {},
        ...(options.token ? { auth: { token: options.token } } : {}),
        locale: "zh-CN",
        userAgent: "longhub-desktop/0.1.0",
      });
    },

    async createSession(agentId: string): Promise<UpstreamSession> {
      // label 在网关内全局唯一，必须带随机后缀避免 "label already in use"
      const result = (await request("sessions.create", {
        agentId,
        label: `longhub:${agentId}:${randomUUID().slice(0, 8)}`,
      })) as {
        key?: string;
        sessionKey?: string;
      };
      const sessionId = result.sessionKey ?? result.key;
      if (!sessionId) throw new Error("sessions.create 未返回会话键");
      return { sessionId };
    },

    async *sendMessage(session: UpstreamSession, text: string): AsyncIterable<UpstreamEvent> {
      const accumulated = { text: "" };
      const queue: UpstreamEvent[] = [];
      let notify: (() => void) | undefined;
      let terminal = false;

      const listener = (payload: ChatEventPayload) => {
        const event = mapChatEvent(payload, session.sessionId, accumulated);
        if (!event) return;
        if (event.type !== "delta") terminal = true;
        queue.push(event);
        notify?.();
      };
      chatListeners.add(listener);
      try {
        await request("chat.send", {
          sessionKey: session.sessionId,
          message: text,
          idempotencyKey: randomUUID(),
        });
        while (!closed) {
          while (queue.length > 0) {
            const event = queue.shift()!;
            yield event;
            if (event.type !== "delta") return;
          }
          if (terminal) return;
          await new Promise<void>((resolve) => {
            notify = resolve;
            setTimeout(resolve, 250);
          });
          notify = undefined;
        }
        yield { type: "error", code: "CONNECTION_CLOSED", message: "Gateway 连接已关闭", retryable: true };
      } finally {
        chatListeners.delete(listener);
      }
    },

    async dispose(): Promise<void> {
      transport?.close();
      transport = undefined;
      closed = true;
    },
  };
}
