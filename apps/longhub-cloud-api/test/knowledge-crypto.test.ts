import { describe, expect, it } from "vitest";
import {
  decryptKnowledgeContent,
  encryptKnowledgeContent,
  parseKnowledgeDataKey,
} from "../src/knowledge-crypto.js";

describe("知识库独立数据密钥", () => {
  const key = Buffer.alloc(32, 11);

  it("使用随机 IV 加密并只允许原租户认证解密", () => {
    const first = encryptKnowledgeContent("企业内部制度正文", "tenant-a", key);
    const second = encryptKnowledgeContent("企业内部制度正文", "tenant-a", key);
    expect(first).not.toBe(second);
    expect(first).not.toContain("内部制度");
    expect(decryptKnowledgeContent(first, "tenant-a", key)).toBe("企业内部制度正文");
    expect(() => decryptKnowledgeContent(first, "tenant-b", key)).toThrow();
  });

  it("拒绝明文、损坏密文和错误长度密钥", () => {
    expect(() => decryptKnowledgeContent("legacy plaintext", "tenant-a", key)).toThrow("密文格式无效");
    expect(() => encryptKnowledgeContent("content", "tenant-a", Buffer.alloc(16))).toThrow("32 字节");
  });

  it("只接受 base64 编码的 32 字节环境密钥", () => {
    expect(parseKnowledgeDataKey(undefined)).toBeUndefined();
    expect(parseKnowledgeDataKey(key.toString("base64url"))).toEqual(key);
    expect(() => parseKnowledgeDataKey(Buffer.alloc(31).toString("base64url"))).toThrow("32 字节");
  });
});
