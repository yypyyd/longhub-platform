import { describe, expect, it } from "vitest";
import { UserDataCenterService } from "../src/user-data-center-service.js";

describe("用户数据中心 Agent 隔离", () => {
  it("显式选择 Agent，隐藏个人正文并把知识引用绑定该 Agent", async () => {
    const calls: string[] = [];
    const service = new UserDataCenterService({
      agents: () => [{ agentId: "hr", name: "招聘" }, { agentId: "main", name: "助手" }],
      sessions: {
        async list(agentId: string) { calls.push(`list:${agentId}`); return [{ key: `${agentId}:s`, agentId, archived: false }]; },
        async rename() {}, async setArchived() {}, async setPinned() {},
        async export(agentId: string, key: string) {
          return { schemaVersion: "longhub/session-export/v1" as const, exportedAt: new Date().toISOString(), session: { key, agentId, archived: false }, messages: [], incomplete: false };
        },
        async sendMessage() {},
      },
      trash: {
        list: () => [], async trash() {}, async restore() {}, requestPermanentDelete: () => "delete-token",
        async permanentlyDelete() {},
      },
      personal: {
        list: (agentId: string) => [{ entryId: "entry-1", agentId, title: "简历", content: "敏感正文", createdAt: new Date().toISOString() }],
        add() {}, trash() {}, restore() {},
      },
      knowledge: {
        async query(agentId: string) { return [{ agentId, documentId: "doc-1", title: "制度", sourceLabel: "手册", snippet: "引用" }]; },
      },
    });
    const queried = await service.perform({ action: "knowledge.query", agentId: "hr", query: "差旅" });
    expect(queried.citations[0]?.agentId).toBe("hr");
    expect(queried.personalEntries[0]).not.toHaveProperty("content");
    await expect(service.read("unknown")).rejects.toThrow("Agent");
    expect(calls).toContain("list:hr");
  });

  it("附件预览绑定 Agent/会话，发送后清空且只向公开 chat.send 适配层交付文本", async () => {
    const sent: Array<{ agentId: string; key: string; message: string }> = [];
    const service = new UserDataCenterService({
      agents: () => [{ agentId: "hr", name: "招聘" }, { agentId: "main", name: "助手" }],
      sessions: {
        async list(agentId: string) { return [{ key: `${agentId}:s`, agentId, archived: false }]; },
        async rename() {}, async setArchived() {}, async setPinned() {},
        async export() { throw new Error("unused"); },
        async sendMessage(agentId, key, message) { sent.push({ agentId, key, message }); },
      },
      trash: { list: () => [], async trash() {}, async restore() {}, requestPermanentDelete: () => "x", async permanentlyDelete() {} },
      personal: { list: () => [], add() { throw new Error("unused"); }, trash() {}, restore() {} },
      knowledge: { async query() { return []; } },
      attachments: { async selectAndParse() { return [{ filename: "resume.md", kind: "markdown", text: "TypeScript 8 年", truncated: false }]; } },
    });
    let snapshot = await service.perform({ action: "file.select", agentId: "hr", sessionId: "hr:s" });
    expect(snapshot.attachments).toHaveLength(1);
    expect((await service.read("main")).attachments).toEqual([]);
    await expect(service.perform({ action: "file.send", agentId: "main", sessionId: "hr:s" })).rejects.toThrow("不属于");
    snapshot = await service.perform({ action: "file.send", agentId: "hr", sessionId: "hr:s" });
    expect(sent[0]).toMatchObject({ agentId: "hr", key: "hr:s" });
    expect(sent[0]?.message).toContain("TypeScript 8 年");
    expect(snapshot.attachments).toEqual([]);
  });
});
