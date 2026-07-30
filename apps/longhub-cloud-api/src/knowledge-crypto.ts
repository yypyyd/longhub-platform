import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const FORMAT = "longhub-kb-v1";

/** KNOWLEDGE_DATA_KEY 使用 base64/base64url 编码的独立 32 字节随机值。 */
export function parseKnowledgeDataKey(value: string | undefined): Buffer | undefined {
  if (!value) return undefined;
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32) throw new Error("KNOWLEDGE_DATA_KEY 必须是 base64 编码的 32 字节密钥");
  return key;
}

export function encryptKnowledgeContent(content: string, tenantId: string, key: Uint8Array): string {
  if (key.byteLength !== 32) throw new Error("知识库数据加密密钥长度必须为 32 字节");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(tenantId, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(content, "utf8"), cipher.final()]);
  return [
    FORMAT,
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(":");
}

export function decryptKnowledgeContent(encrypted: string, tenantId: string, key: Uint8Array): string {
  if (key.byteLength !== 32) throw new Error("知识库数据加密密钥长度必须为 32 字节");
  const [format, ivText, ciphertextText, tagText] = encrypted.split(":");
  if (format !== FORMAT || !ivText || !ciphertextText || !tagText) throw new Error("知识库正文密文格式无效");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
  decipher.setAAD(Buffer.from(tenantId, "utf8"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
