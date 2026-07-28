import { createHash, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import type { PackManifest } from "./manifest.js";

/** LongHub Agent Pack 制品文件：manifest + 文件内容（原型用 JSON 包，正式版换归档格式） */
export interface PackFile {
  manifest: PackManifest;
  files: Record<string, string>;
  signature: string;
}

/** 键序稳定的 JSON 序列化，保证摘要可复现 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
      );
    }
    return v;
  });
}

/** 摘要覆盖 files 全部内容（manifest.integrity.digest 之外的部分） */
export function computePackDigest(files: Record<string, string>): string {
  return createHash("sha256").update(canonicalStringify(files), "utf-8").digest("hex");
}

/** 用发布私钥（Ed25519 PEM）对摘要签名 */
export function signPackDigest(digest: string, privateKeyPem: string): string {
  return cryptoSign(null, Buffer.from(digest, "utf-8"), privateKeyPem).toString("base64");
}

/** 用发布公钥验签 */
export function verifyPackSignature(digest: string, signature: string, publicKeyPem: string): boolean {
  try {
    return cryptoVerify(null, Buffer.from(digest, "utf-8"), publicKeyPem, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

/** 语义化版本比较：a >= b */
export function semverGte(a: string, b: string): boolean {
  const pa = a.split("-")[0]!.split(".").map(Number);
  const pb = b.split("-")[0]!.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return true;
}
