import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RecoverableSessionTrash, SessionManagementService } from "../src/session-management.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture(now = Date.parse("2026-07-01T00:00:00Z")) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let archived = false;
  const service = new SessionManagementService({
    async call(method, params) {
      calls.push({ method, params });
      if (method === "sessions.list") return { sessions: [{ key: "agent:hr:session-1", agentId: "hr", archived }] };
      if (method === "sessions.describe") return { key: "agent:hr:session-1", agentId: "hr", archived };
      if (method === "sessions.patch") { archived = params.archived === true; return { ok: true }; }
      if (method === "chat.history") return { messages: [{ role: "user", content: "你好" }], hasMore: false };
      if (method === "chat.send") return { accepted: true };
      if (method === "sessions.delete") return { deleted: true };
      throw new Error("unexpected");
    },
  });
  const root = mkdtempSync(join(tmpdir(), "longhub-sessions-"));
  roots.push(root);
  const clock = { value: now };
  const trash = new RecoverableSessionTrash(join(root, "trash.json"), service, 60_000, () => clock.value);
  return { calls, service, trash, clock };
}

describe("公开 RPC 会话管理与可恢复删除", () => {
  it("列表、重命名和导出始终绑定 Agent，并标记非快照导出边界", async () => {
    const ctx = fixture();
    expect(await ctx.service.list("hr", { search: "候选人" })).toHaveLength(1);
    await ctx.service.rename("hr", "agent:hr:session-1", "候选人沟通");
    await ctx.service.setPinned("hr", "agent:hr:session-1", true);
    const exported = await ctx.service.export("hr", "agent:hr:session-1");
    await ctx.service.sendMessage("hr", "agent:hr:session-1", "附件内容");
    expect(exported).toMatchObject({ schemaVersion: "longhub/session-export/v1", incomplete: false });
    expect(ctx.calls.some((call) => call.method === "chat.history")).toBe(true);
    expect(ctx.calls.some((call) => call.method === "chat.send" && call.params.message === "附件内容")).toBe(true);
    expect(ctx.calls.some((call) => call.method === "sessions.patch" && call.params.pinned === true)).toBe(true);
    await expect(ctx.service.describeOwned("other", "agent:hr:session-1")).rejects.toThrow("不属于");
  });

  it("先归档进入回收站，可恢复；保留期后才签发一次性永久删除确认", async () => {
    const ctx = fixture();
    await ctx.trash.trash("hr", "agent:hr:session-1");
    expect(ctx.trash.list("hr")).toHaveLength(1);
    expect(() => ctx.trash.requestPermanentDelete("hr", "agent:hr:session-1")).toThrow("保留期");
    await ctx.trash.restore("hr", "agent:hr:session-1");
    expect(ctx.trash.list("hr")).toHaveLength(0);

    await ctx.trash.trash("hr", "agent:hr:session-1");
    ctx.clock.value += 60_001;
    const confirmation = ctx.trash.requestPermanentDelete("hr", "agent:hr:session-1");
    await ctx.trash.permanentlyDelete("hr", "agent:hr:session-1", confirmation);
    await expect(ctx.trash.permanentlyDelete("hr", "agent:hr:session-1", confirmation)).rejects.toThrow("已使用");
    expect(ctx.calls.at(-1)?.method).toBe("sessions.delete");
  });
});
