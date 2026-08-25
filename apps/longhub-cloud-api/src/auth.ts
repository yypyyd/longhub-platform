/** 账号口令与会话凭据工具：异步 scrypt、随机令牌与持久化摘要。 */
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_RE = /^[a-f0-9]{32}$/u;
const SCRYPT_HASH_RE = /^[a-f0-9]{128}$/u;
const scryptAsync = promisify(scrypt);

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = (await scryptAsync(password, salt, SCRYPT_KEYLEN) as Buffer).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 3) return false;
  const [scheme, salt, hash] = parts;
  if (scheme !== "scrypt" || typeof salt !== "string" || !SCRYPT_SALT_RE.test(salt) ||
    typeof hash !== "string" || !SCRYPT_HASH_RE.test(hash)) return false;
  const candidate = await scryptAsync(password, salt, SCRYPT_KEYLEN) as Buffer;
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function newToken(prefix: string): string {
  return `${prefix}-${randomUUID()}${randomBytes(16).toString("hex")}`;
}

/** Persistent stores keep only this domain-separated digest, never the bearer. */
export function hashSessionToken(token: string): string {
  return createHash("sha256")
    .update("longhub/auth-session/v1\0", "utf8")
    .update(token, "utf8")
    .digest("hex");
}

export function isProductionAdminToken(token: string): boolean {
  return token.length >= 32 && new Set(token).size >= 8 && token !== "longhub-dev-admin" &&
    !/change[_-]?me/iu.test(token) && !/[\u0000-\u001f\u007f]/u.test(token);
}

/** 会话有效期：7 天 */
export function sessionExpiry(now = Date.now()): string {
  return new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString();
}
