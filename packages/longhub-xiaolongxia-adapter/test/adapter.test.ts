import { describe, expect, it } from "vitest";
import { createMockAdapter } from "../src/mock-adapter.js";
import type { UpstreamEvent } from "../src/adapter.js";

describe("适配层契约（Mock 底座）", () => {
  it("init → createSession → sendMessage 流式输出 → done", async () => {
    const adapter = createMockAdapter();
    await adapter.init();
    const session = await adapter.createSession("longhub.agent.hr");
    expect(session.sessionId).toContain("longhub.agent.hr");

    const events: UpstreamEvent[] = [];
    for await (const event of adapter.sendMessage(session, "查询 张三 年假")) {
      events.push(event);
    }
    expect(events.filter((e) => e.type === "delta")).toHaveLength(3);
    const done = events.at(-1);
    expect(done).toEqual({ type: "done", finalText: "查询 张三 年假" });
    await adapter.dispose();
  });

  it("未初始化时拒绝创建会话", async () => {
    const adapter = createMockAdapter();
    await expect(adapter.createSession("x")).rejects.toThrow("未初始化");
  });

  it("dispose 后拒绝继续使用", async () => {
    const adapter = createMockAdapter();
    await adapter.init();
    await adapter.dispose();
    await expect(adapter.createSession("x")).rejects.toThrow("未初始化");
  });
});
