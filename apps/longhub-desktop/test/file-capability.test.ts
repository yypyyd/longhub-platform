import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileCapabilityStore, parseStrictAttachment } from "../src/file-capability.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "longhub-file-capability-"));
  roots.push(value);
  return value;
}

describe("一次性文件句柄与解析门禁", () => {
  it("原生选择后复制到受管暂存，只允许绑定 Agent/Session 消费一次", () => {
    const base = root();
    const source = join(base, "resume.md");
    writeFileSync(source, "# 简历\nTypeScript");
    const store = new FileCapabilityStore(join(base, "staging"));
    const context = { agentId: "hr", sessionId: "session-1" };
    const issued = store.issueFromTrustedPicker([source], context)[0]!;
    expect(issued).not.toHaveProperty("stagedPath");
    expect(() => store.consume(issued.handleId, { ...context, agentId: "other" })).toThrow("句柄");
    const consumed = store.consume(issued.handleId, context);
    expect(parseStrictAttachment(consumed.stagedPath)).toMatchObject({ kind: "markdown", truncated: false });
    expect(() => store.consume(issued.handleId, context)).toThrow("已使用");
  });

  it("拒绝符号链接、未知扩展、压缩容器、二进制和超大文件", () => {
    const base = root();
    const target = join(base, "target.txt");
    writeFileSync(target, "safe");
    const link = join(base, "link.txt");
    symlinkSync(target, link, "file");
    const store = new FileCapabilityStore(join(base, "staging"), { maxFileBytes: 1_024 });
    expect(() => store.issueFromTrustedPicker([link], { agentId: "hr", sessionId: "s" })).toThrow("类型");
    const executable = join(base, "evil.exe");
    writeFileSync(executable, "MZ");
    expect(() => store.issueFromTrustedPicker([executable], { agentId: "hr", sessionId: "s" })).toThrow("不受支持");
    const archive = join(base, "fake.md");
    writeFileSync(archive, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]));
    expect(() => parseStrictAttachment(archive)).toThrow("压缩");
    const binary = join(base, "binary.txt");
    writeFileSync(binary, Buffer.from([1, 0, 2]));
    expect(() => parseStrictAttachment(binary)).toThrow("二进制");
  });

  it("过期或取消会清理暂存且句柄不再可用", () => {
    const base = root();
    const source = join(base, "data.json");
    writeFileSync(source, "{\"ok\":true}");
    const clock = { value: 1_000_000 };
    const store = new FileCapabilityStore(join(base, "staging"), { ttlMs: 60_000, now: () => clock.value });
    const context = { agentId: "hr", sessionId: "s" };
    const issued = store.issueFromTrustedPicker([source], context)[0]!;
    clock.value += 60_001;
    expect(store.cleanupExpired()).toBe(1);
    expect(() => store.consume(issued.handleId, context)).toThrow("句柄");
  });
});
