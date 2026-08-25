/**
 * Cloud API -> Executor 的内部单任务凭据。
 *
 * 这是一个有明确版本的 HMAC 信封，而不是用户设备 Token：凭据只包含
 * 请求绑定元数据和输入摘要，不包含 Skill 实现、提示词或任何业务秘密。
 * 生产环境必须由 Cloud API 与 Executor 通过 EXECUTOR_CREDENTIAL_SECRET
 * 注入同一随机密钥；进程内开发密钥只用于同进程契约测试。
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const EXECUTOR_CREDENTIAL_SCHEMA = "longhub/executor-credential/v1" as const;
export const EXECUTOR_REQUEST_SCHEMA = "longhub/executor-request/v1" as const;
export const EXECUTOR_CREDENTIAL_HEADER = "x-longhub-executor-credential" as const;
export const EXECUTOR_CREDENTIAL_TTL_MS = 60_000;
export const EXECUTOR_CREDENTIAL_MAX_TTL_MS = 5 * 60_000;
export const EXECUTOR_CLOCK_SKEW_MS = 10_000;

const CREDENTIAL_PREFIX = "lhx1";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,127}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~:-]{0,127}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

/** HMAC key material is intentionally not serialised into a credential. */
export interface ExecutorCredentialKey {
  readonly keyId: string;
  readonly secret: Uint8Array;
}

export interface ExecutorCredentialClaims {
  readonly schema_version: typeof EXECUTOR_CREDENTIAL_SCHEMA;
  readonly credential_id: string;
  readonly key_id: string;
  readonly task_id: string;
  readonly tenant_id: string;
  readonly skill_id: string;
  readonly idempotency_key: string;
  readonly input_digest: string;
  /** Unix epoch milliseconds. */
  readonly issued_at: number;
  /** Unix epoch milliseconds. */
  readonly expires_at: number;
}

export interface IssueExecutorCredentialInput {
  readonly taskId: string;
  readonly tenantId: string;
  readonly skillId: string;
  readonly idempotencyKey: string;
  readonly input: unknown;
}

export interface IssueExecutorCredentialOptions {
  readonly key: ExecutorCredentialKey;
  readonly nowMs?: number;
  readonly ttlMs?: number;
}

export type ExecutorCredentialErrorCode =
  | "CREDENTIAL_INVALID"
  | "CREDENTIAL_EXPIRED";

/** Internal parser error. Callers must map this to a fixed public error message. */
export class ExecutorCredentialError extends Error {
  readonly code: ExecutorCredentialErrorCode;

  constructor(code: ExecutorCredentialErrorCode) {
    super(code);
    this.name = "ExecutorCredentialError";
    this.code = code;
  }
}

function assertKey(key: ExecutorCredentialKey): void {
  if (!KEY_ID_PATTERN.test(key.keyId) || key.secret.byteLength < 32 || key.secret.byteLength > 64) {
    throw new Error("执行器凭据密钥配置无效");
  }
}

function assertText(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value) || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} 格式无效`);
  }
}

function base64urlEncode(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function base64urlDecode(value: string): Buffer {
  // Node's decoder is deliberately permissive, so validate the alphabet and
  // canonical round trip before accepting an untrusted token part.
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 4096) {
    throw new ExecutorCredentialError("CREDENTIAL_INVALID");
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    throw new ExecutorCredentialError("CREDENTIAL_INVALID");
  }
  if (decoded.byteLength === 0 || decoded.toString("base64url") !== value) {
    throw new ExecutorCredentialError("CREDENTIAL_INVALID");
  }
  return decoded;
}

/** Deterministic JSON for binding an input without putting the input in a token. */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 100) throw new Error("输入嵌套层级超过限制");
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("输入包含非有限数字");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry, depth + 1)).join(",")}]`;
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("输入必须是 JSON 对象");
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort((left, right) => left.localeCompare(right, "en"))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], depth + 1)}`)
      .join(",")}}`;
  }
  throw new Error("输入必须是 JSON 值");
}

export function computeExecutorInputDigest(input: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(input), "utf8")
    .digest("hex");
}

function signEnvelope(payload: string, key: ExecutorCredentialKey): string {
  return createHmac("sha256", key.secret).update(`${CREDENTIAL_PREFIX}.${payload}`, "utf8").digest("base64url");
}

function parseEnvelope(token: string): { payload: string; signature: string } {
  if (typeof token !== "string" || token.length < 16 || token.length > 8192) {
    throw new ExecutorCredentialError("CREDENTIAL_INVALID");
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== CREDENTIAL_PREFIX || !parts[1] || !parts[2]) {
    throw new ExecutorCredentialError("CREDENTIAL_INVALID");
  }
  // Validate both parts before signature comparison. This also prevents
  // accidental acceptance of padded/non-canonical encodings.
  base64urlDecode(parts[1]!);
  const signatureBytes = base64urlDecode(parts[2]!);
  if (signatureBytes.byteLength !== 32) throw new ExecutorCredentialError("CREDENTIAL_INVALID");
  return { payload: parts[1]!, signature: parts[2]! };
}

function parseClaims(value: unknown): ExecutorCredentialClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExecutorCredentialError("CREDENTIAL_INVALID");
  }
  const record = value as Record<string, unknown>;
  const expected = [
    "schema_version",
    "credential_id",
    "key_id",
    "task_id",
    "tenant_id",
    "skill_id",
    "idempotency_key",
    "input_digest",
    "issued_at",
    "expires_at",
  ];
  if (Object.keys(record).sort().join("|") !== expected.slice().sort().join("|")) {
    throw new ExecutorCredentialError("CREDENTIAL_INVALID");
  }
  if (
    record.schema_version !== EXECUTOR_CREDENTIAL_SCHEMA ||
    typeof record.credential_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.credential_id) ||
    typeof record.key_id !== "string" ||
    typeof record.task_id !== "string" ||
    typeof record.tenant_id !== "string" ||
    typeof record.skill_id !== "string" ||
    typeof record.idempotency_key !== "string" ||
    typeof record.input_digest !== "string" ||
    typeof record.issued_at !== "number" ||
    !Number.isSafeInteger(record.issued_at) ||
    typeof record.expires_at !== "number" ||
    !Number.isSafeInteger(record.expires_at)
  ) {
    throw new ExecutorCredentialError("CREDENTIAL_INVALID");
  }
  try {
    assertText(record.key_id, KEY_ID_PATTERN, "key_id");
    assertText(record.task_id, ID_PATTERN, "task_id");
    assertText(record.tenant_id, ID_PATTERN, "tenant_id");
    assertText(record.skill_id, SKILL_ID_PATTERN, "skill_id");
    assertText(record.idempotency_key, IDEMPOTENCY_PATTERN, "idempotency_key");
  } catch {
    throw new ExecutorCredentialError("CREDENTIAL_INVALID");
  }
  if (!DIGEST_PATTERN.test(record.input_digest)) {
    throw new ExecutorCredentialError("CREDENTIAL_INVALID");
  }
  if (record.expires_at <= record.issued_at || record.expires_at - record.issued_at > EXECUTOR_CREDENTIAL_MAX_TTL_MS) {
    throw new ExecutorCredentialError("CREDENTIAL_INVALID");
  }
  return record as unknown as ExecutorCredentialClaims;
}

export function issueExecutorCredential(
  input: IssueExecutorCredentialInput,
  options: IssueExecutorCredentialOptions,
): string {
  assertKey(options.key);
  assertText(input.taskId, ID_PATTERN, "taskId");
  assertText(input.tenantId, ID_PATTERN, "tenantId");
  assertText(input.skillId, SKILL_ID_PATTERN, "skillId");
  assertText(input.idempotencyKey, IDEMPOTENCY_PATTERN, "idempotencyKey");
  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = options.ttlMs ?? EXECUTOR_CREDENTIAL_TTL_MS;
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > EXECUTOR_CREDENTIAL_MAX_TTL_MS) {
    throw new Error("执行器凭据时间参数无效");
  }
  const claims: ExecutorCredentialClaims = {
    schema_version: EXECUTOR_CREDENTIAL_SCHEMA,
    credential_id: randomUUID(),
    key_id: options.key.keyId,
    task_id: input.taskId,
    tenant_id: input.tenantId,
    skill_id: input.skillId,
    idempotency_key: input.idempotencyKey,
    input_digest: computeExecutorInputDigest(input.input),
    issued_at: nowMs,
    expires_at: nowMs + ttlMs,
  };
  const payload = base64urlEncode(Buffer.from(JSON.stringify(claims), "utf8"));
  return `${CREDENTIAL_PREFIX}.${payload}.${signEnvelope(payload, options.key)}`;
}

export interface VerifyExecutorCredentialOptions {
  readonly key: ExecutorCredentialKey;
  /** Optional overlap set used during key rotation; key_id selects one entry. */
  readonly trustedKeys?: ReadonlyMap<string, ExecutorCredentialKey>;
  readonly nowMs?: number;
}

export function verifyExecutorCredential(
  token: string,
  options: VerifyExecutorCredentialOptions,
): ExecutorCredentialClaims {
  assertKey(options.key);
  const envelope = parseEnvelope(token);
  const payloadBytes = base64urlDecode(envelope.payload);
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    throw new ExecutorCredentialError("CREDENTIAL_INVALID");
  }
  const claims = parseClaims(parsed);
  const verificationKey = options.trustedKeys?.get(claims.key_id) ??
    (claims.key_id === options.key.keyId ? options.key : undefined);
  if (!verificationKey) throw new ExecutorCredentialError("CREDENTIAL_INVALID");
  assertKey(verificationKey);
  const expected = Buffer.from(signEnvelope(envelope.payload, verificationKey), "base64url");
  const actual = Buffer.from(envelope.signature, "base64url");
  if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual)) {
    throw new ExecutorCredentialError("CREDENTIAL_INVALID");
  }
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs)) throw new ExecutorCredentialError("CREDENTIAL_INVALID");
  if (claims.issued_at > nowMs + EXECUTOR_CLOCK_SKEW_MS) {
    throw new ExecutorCredentialError("CREDENTIAL_INVALID");
  }
  if (claims.expires_at <= nowMs) throw new ExecutorCredentialError("CREDENTIAL_EXPIRED");
  return claims;
}

/** Parse the production shared secret. Returning undefined makes bootstrap fail closed. */
export function parseExecutorCredentialKey(
  env: NodeJS.ProcessEnv = process.env,
): ExecutorCredentialKey | undefined {
  const rawSecret = env.EXECUTOR_CREDENTIAL_SECRET?.trim();
  const rawKeyId = env.EXECUTOR_CREDENTIAL_KEY_ID?.trim() || "executor-v1";
  if (!rawSecret) return undefined;
  if (!KEY_ID_PATTERN.test(rawKeyId) || !/^[A-Za-z0-9_-]{43,86}$/.test(rawSecret)) {
    throw new Error("EXECUTOR_CREDENTIAL_KEY_ID/SECRET 配置无效");
  }
  const secret = Buffer.from(rawSecret, "base64url");
  if (secret.byteLength < 32 || secret.byteLength > 64 || secret.toString("base64url") !== rawSecret) {
    throw new Error("EXECUTOR_CREDENTIAL_SECRET 必须是 32-64 字节 base64url 密钥");
  }
  return { keyId: rawKeyId, secret };
}

/**
 * Parse an optional key overlap set for rotation. Values are key_id -> base64url
 * secret and never appear in logs or credentials. The active key is configured
 * separately through EXECUTOR_CREDENTIAL_KEY_ID/SECRET.
 */
export function parseExecutorCredentialTrustedKeys(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyMap<string, ExecutorCredentialKey> {
  const raw = env.EXECUTOR_CREDENTIAL_TRUSTED_KEYS_JSON?.trim();
  if (!raw) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("EXECUTOR_CREDENTIAL_TRUSTED_KEYS_JSON 必须是合法 JSON 对象");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("EXECUTOR_CREDENTIAL_TRUSTED_KEYS_JSON 必须是 key ID 到密钥的对象");
  }
  const entries = Object.entries(parsed);
  if (entries.length > 16) throw new Error("执行器历史凭据密钥不能超过 16 个");
  const keys = new Map<string, ExecutorCredentialKey>();
  for (const [keyId, value] of entries) {
    if (typeof value !== "string" || !KEY_ID_PATTERN.test(keyId) || !/^[A-Za-z0-9_-]{43,86}$/.test(value)) {
      throw new Error(`执行器历史凭据密钥配置无效: ${keyId}`);
    }
    const secret = Buffer.from(value, "base64url");
    if (secret.byteLength < 32 || secret.byteLength > 64 || secret.toString("base64url") !== value) {
      throw new Error(`执行器历史凭据密钥长度无效: ${keyId}`);
    }
    keys.set(keyId, { keyId, secret });
  }
  return keys;
}

// Deliberately process-local and random: this is only a convenience for in-process
// tests. Production bootstrap refuses to run without an explicitly injected key.
const developmentKey: ExecutorCredentialKey = Object.freeze({
  keyId: "longhub-dev-process",
  secret: randomBytes(32),
});

export function getDevelopmentExecutorCredentialKey(): ExecutorCredentialKey {
  return { keyId: developmentKey.keyId, secret: Buffer.from(developmentKey.secret) };
}
