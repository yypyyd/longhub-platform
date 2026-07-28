import type { UpstreamEvent, UpstreamRuntimeAdapter, UpstreamSession } from "./adapter.js";

/**
 * 内存 Mock 底座：验证适配层契约与内核集成，不依赖真实上游。
 * 行为：把输入按词流式回显。
 */
export function createMockAdapter(): UpstreamRuntimeAdapter {
  let initialized = false;
  let sessionSeq = 0;
  return {
    adapterVersion: "1.0",
    async init() {
      initialized = true;
    },
    async createSession(agentId: string): Promise<UpstreamSession> {
      if (!initialized) throw new Error("适配器未初始化");
      return { sessionId: `${agentId}#${++sessionSeq}` };
    },
    async *sendMessage(session: UpstreamSession, text: string): AsyncIterable<UpstreamEvent> {
      if (!initialized) {
        yield { type: "error", code: "NOT_INITIALIZED", message: "适配器未初始化", retryable: false };
        return;
      }
      const words = text.split(/\s+/).filter(Boolean);
      let finalText = "";
      for (const word of words) {
        finalText += (finalText ? " " : "") + word;
        yield { type: "delta", text: word };
      }
      yield { type: "done", finalText };
    },
    async dispose() {
      initialized = false;
    },
  };
}
