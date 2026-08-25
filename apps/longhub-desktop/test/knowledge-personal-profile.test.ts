import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentKnowledgeClient } from "../src/knowledge-client.js";
import { LocalPersonalProfileStore } from "../src/local-personal-profile.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("企业知识引用与当前设备个人资料", () => {
  it("知识引用使用设备 tenant 并绑定发起查询的 Agent", async () => {
    const client = new AgentKnowledgeClient({
      baseUrl: "https://cloud.example",
      deviceToken: "device-token",
      fetchImpl: async (_input, init) => {
        expect(init?.body).toBe(JSON.stringify({ query: "差旅 报销", limit: 5 }));
        return Response.json({ citations: [{
          document_id: "doc-1", title: "差旅制度", source_label: "员工手册", snippet: "十个工作日", score: 2,
        }] });
      },
    });
    expect(await client.query("hr", "差旅 报销")).toEqual([expect.objectContaining({ agentId: "hr", documentId: "doc-1" })]);
    expect(() => new AgentKnowledgeClient({ baseUrl: "http://public.example", deviceToken: "x" })).toThrow("HTTPS");
  });

  it("个人资料按 Windows userData owner 与 Agent 隔离，并支持删除恢复", () => {
    const root = mkdtempSync(join(tmpdir(), "longhub-personal-profile-"));
    roots.push(root);
    const file = join(root, "personal-profile.json");
    const store = new LocalPersonalProfileStore(file, "windows-user/device-1");
    const entry = store.add("hr", "我的简历", "TypeScript 8 年");
    expect(store.list("other")).toEqual([]);
    store.trash("hr", entry.entryId);
    expect(store.list("hr")).toEqual([]);
    expect(store.list("hr", true)[0]?.deletedAt).toBeTruthy();
    store.restore("hr", entry.entryId);
    expect(store.list("hr")).toHaveLength(1);
    expect(() => new LocalPersonalProfileStore(file, "another-windows-user")).toThrow("owner");
  });
});
