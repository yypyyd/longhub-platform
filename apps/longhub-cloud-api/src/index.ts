import { createConsoleLogger } from "@longhub/observability";
import { createPublicKey } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { isAbsolute, join } from "node:path";
import { hashPassword, isProductionAdminToken } from "./auth.js";
import { createCloudApiServer } from "./server.js";
import { MemoryStore } from "./memory-store.js";
import { PgStore } from "./pg-store.js";
import { parseModelEncryptionKey } from "./model-gateway.js";
import { parseKnowledgeDataKey } from "./knowledge-crypto.js";
import type { SigningKey } from "./server.js";
import { parseExecutorCredentialKey } from "longhub-executor";

export { createCloudApiServer, generateSigningKey, type SigningKey } from "./server.js";
export { MemoryStore } from "./memory-store.js";
export { PgStore } from "./pg-store.js";
export {
  BillingOutboxWorker,
  type BillingEventPublisher,
  type BillingOutboxRunResult,
  type BillingOutboxWorkerOptions,
  type BillingPublishedEvent,
} from "./billing-outbox.js";
export {
  decryptModelApiKey,
  encryptModelApiKey,
  normalizeUpstreamBaseUrl,
  parseModelEncryptionKey,
} from "./model-gateway.js";
export { decryptKnowledgeContent, encryptKnowledgeContent, parseKnowledgeDataKey } from "./knowledge-crypto.js";
export type {
  AdminRecord,
  AdminRole,
  AuditLogRecord,
  ClientTelemetryAggregateRecord,
  CloudSkillAccessGrant,
  CloudSkillAccessQuery,
  CloudSkillEntitlementQuery,
  CloudSkillEntitlementRecord,
  CloudSkillEntitlementStatus,
  CloudSkillExecutionRejectionReason,
  CloudSkillExecutionReleaseRequest,
  CloudSkillExecutionReleaseResult,
  CloudSkillExecutionReservation,
  CloudSkillExecutionReservationRequest,
  CloudSkillExecutionReservationResult,
  CloudSkillOperationalMetric,
  CloudSkillOperationalSummary,
  CloudSkillPlanRecord,
  CloudSkillPlanStatus,
  CloudSkillSubscriptionRecord,
  CloudSkillSubscriptionStatus,
  CloudStore,
  CloudTask,
  CloudTaskOwner,
  CloudTaskEvent,
  CloudTaskStatus,
  DeviceRecord,
  EntitlementRecord,
  FeaturePolicyRecord,
  OrderRecord,
  ModelGatewayConfigRecord,
  ModelRequestAggregateRecord,
  PackReleaseRecord,
  SkillReleaseRecord,
  ProductRecord,
  SessionRecord,
  UserRecord,
  WalletTransactionRecord,
} from "./store.js";

/** 控制面模块清单：Identity/Agent Catalog/Entitlement/Release/Artifact/Task/Execution/Model Gateway/Audit */
export const CONTROL_PLANE_MODULES = [
  "identity",
  "agent-catalog",
  "entitlement",
  "release",
  "artifact",
  "task",
  "execution",
  "model-gateway",
  "feature-policy",
  "telemetry",
  "audit",
] as const;

function normalizePem(value: string): string {
  return value.includes("\\n") ? value.replaceAll("\\n", "\n") : value;
}

const SIGNING_CREDENTIAL_MAX_BYTES = 64 * 1024;

function readSigningCredential(directory: string, filename: string, label: string): string {
  if (!isAbsolute(directory) || directory !== directory.trim() || CONTROL_CHARACTERS.test(directory)) {
    throw new Error("CREDENTIALS_DIRECTORY 必须是绝对路径且不含首尾空白或控制字符");
  }
  const path = join(directory, filename);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > SIGNING_CREDENTIAL_MAX_BYTES) {
      throw new Error("invalid credential file");
    }
    const value = readFileSync(path, "utf8");
    if (!value.trim()) throw new Error("empty credential file");
    return value;
  } catch {
    throw new Error(`${label} systemd 凭据缺失、不是普通文件或超过 64 KiB`);
  }
}

function parseSigningKey(
  env: NodeJS.ProcessEnv,
  params: {
    keyIdName: string;
    privateKeyName: string;
    publicKeyName: string;
    privateCredentialName: string;
    publicCredentialName: string;
    label: string;
  },
): SigningKey | undefined {
  const keyId = env[params.keyIdName];
  const inlinePrivateKey = env[params.privateKeyName];
  const inlinePublicKey = env[params.publicKeyName];
  const credentialDirectory = env.CREDENTIALS_DIRECTORY;
  const hasInlinePem = inlinePrivateKey !== undefined || inlinePublicKey !== undefined;

  if (credentialDirectory !== undefined && hasInlinePem) {
    throw new Error(`${params.label} 签名密钥不能同时使用环境 PEM 与 systemd 凭据`);
  }
  if (keyId === undefined && !hasInlinePem) return undefined;

  const privateKey = credentialDirectory !== undefined
    ? readSigningCredential(credentialDirectory, params.privateCredentialName, `${params.label} 私钥`)
    : inlinePrivateKey;
  const publicKey = credentialDirectory !== undefined
    ? readSigningCredential(credentialDirectory, params.publicCredentialName, `${params.label} 公钥`)
    : inlinePublicKey;
  if (!keyId?.trim() || !privateKey?.trim() || !publicKey?.trim()) {
    throw new Error(`${params.keyIdName}/${params.privateKeyName}/${params.publicKeyName} 必须同时配置`);
  }
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(keyId)) throw new Error(`${params.label}签名 key ID 无效`);
  return {
    keyId,
    privateKeyPem: normalizePem(privateKey),
    publicKeyPem: normalizePem(publicKey),
  };
}

/** 生产更新密钥必须完整注入；缺一项时不能退回进程内随机密钥。 */
export function parseUpdateSigningKey(env: NodeJS.ProcessEnv): SigningKey | undefined {
  return parseSigningKey(env, {
    keyIdName: "CLIENT_UPDATE_SIGNING_KEY_ID",
    privateKeyName: "CLIENT_UPDATE_SIGNING_PRIVATE_KEY_PEM",
    publicKeyName: "CLIENT_UPDATE_SIGNING_PUBLIC_KEY_PEM",
    privateCredentialName: "client-update-private.pem",
    publicCredentialName: "client-update-public.pem",
    label: "客户端更新",
  });
}

/** 生产 Skill 发布密钥必须完整注入；独立于 Agent Pack 与客户端更新用途域。 */
export function parseSkillSigningKey(env: NodeJS.ProcessEnv): SigningKey | undefined {
  return parseSigningKey(env, {
    keyIdName: "SKILL_SIGNING_KEY_ID",
    privateKeyName: "SKILL_SIGNING_PRIVATE_KEY_PEM",
    publicKeyName: "SKILL_SIGNING_PUBLIC_KEY_PEM",
    privateCredentialName: "cloud-skill-private.pem",
    publicCredentialName: "cloud-skill-public.pem",
    label: "Skill ",
  });
}

/** Cloud Plugin release trust domain. It must not reuse any other release key. */
export function parseCloudPluginSigningKey(env: NodeJS.ProcessEnv): SigningKey | undefined {
  return parseSigningKey(env, {
    keyIdName: "CLOUD_PLUGIN_SIGNING_KEY_ID",
    privateKeyName: "CLOUD_PLUGIN_SIGNING_PRIVATE_KEY_PEM",
    publicKeyName: "CLOUD_PLUGIN_SIGNING_PUBLIC_KEY_PEM",
    privateCredentialName: "cloud-plugin-private.pem",
    publicCredentialName: "cloud-plugin-public.pem",
    label: "Cloud Plugin release ",
  });
}

/** Standalone Cloud CLI release trust domain. */
export function parseCloudCliSigningKey(env: NodeJS.ProcessEnv): SigningKey | undefined {
  return parseSigningKey(env, {
    keyIdName: "CLOUD_CLI_SIGNING_KEY_ID",
    privateKeyName: "CLOUD_CLI_SIGNING_PRIVATE_KEY_PEM",
    publicKeyName: "CLOUD_CLI_SIGNING_PUBLIC_KEY_PEM",
    privateCredentialName: "cloud-cli-private.pem",
    publicCredentialName: "cloud-cli-public.pem",
    label: "Cloud CLI release ",
  });
}

/** 解析密钥轮换期间保留的历史公钥；只接受 key ID 到 Ed25519 SPKI PEM 的严格 JSON 对象。 */
export function parseUpdateTrustedPublicKeys(value: string | undefined): ReadonlyMap<string, string> {
  if (!value?.trim()) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("CLIENT_UPDATE_TRUSTED_PUBLIC_KEYS_JSON 必须是合法 JSON 对象");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("CLIENT_UPDATE_TRUSTED_PUBLIC_KEYS_JSON 必须是 key ID 到公钥 PEM 的对象");
  }
  const entries = Object.entries(parsed);
  if (entries.length > 32) throw new Error("客户端更新历史公钥不能超过 32 个");
  const trustedKeys = new Map<string, string>();
  for (const [keyId, rawPem] of entries) {
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(keyId) || typeof rawPem !== "string" || !rawPem.trim()) {
      throw new Error(`客户端更新历史公钥配置无效: ${keyId}`);
    }
    const pem = normalizePem(rawPem);
    if (pem.includes("PRIVATE KEY")) throw new Error(`客户端更新历史密钥只能配置公钥: ${keyId}`);
    let publicKey;
    try {
      publicKey = createPublicKey(pem);
    } catch {
      throw new Error(`客户端更新历史公钥 PEM 无效: ${keyId}`);
    }
    if (publicKey.asymmetricKeyType !== "ed25519") {
      throw new Error(`客户端更新历史公钥必须是 Ed25519: ${keyId}`);
    }
    trustedKeys.set(keyId, publicKey.export({ type: "spki", format: "pem" }).toString());
  }
  return trustedKeys;
}

/**
 * Parse the browser origin allowlist.  Production deliberately treats a
 * missing value as an empty list (same-origin/no CORS), while development may
 * leave it undefined to retain the local wildcard used by the Vite apps.
 */
export function parseCorsAllowOrigins(value: string | undefined): readonly string[] {
  if (!value?.trim()) return [];
  const origins = [...new Set(value.split(",").map((origin) => origin.trim()).filter(Boolean))];
  if (origins.length > 32) throw new Error("CORS_ALLOW_ORIGINS 不能超过 32 个 origin");
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`CORS_ALLOW_ORIGINS origin 无效: ${origin}`);
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin ||
      parsed.username !== "" || parsed.password !== "") {
      throw new Error(`CORS_ALLOW_ORIGINS 必须是无路径的 HTTP(S) origin: ${origin}`);
    }
  }
  return origins;
}

function parseProductionAdminToken(value: string | undefined, required: boolean): string | undefined {
  const token = value?.trim() || undefined;
  if (required && token && !isProductionAdminToken(token)) {
    throw new Error("生产 Cloud API 的 ADMIN_TOKEN 必须是至少 32 字符的非占位高熵值");
  }
  return token;
}

export interface AdminSeedCredentials {
  username: string;
  password: string;
}

const ADMIN_SEED_USERNAME_MAX_LENGTH = 128;
const ADMIN_SEED_PASSWORD_MAX_LENGTH = 256;
const ADMIN_SEED_PLACEHOLDER = /change[_. -]?me|placeholder|example|your[_. -]?(?:admin|username|password)/iu;
const ADMIN_SEED_WEAK_PASSWORD = /(?:password|123456|qwerty|letmein|admin|root)/iu;

/** Validate the optional one-time administrator seed before database startup. */
export function parseAdminSeedCredentials(
  usernameValue: string | undefined,
  passwordValue: string | undefined,
  productionMode: boolean,
): AdminSeedCredentials | undefined {
  const usernameConfigured = usernameValue !== undefined;
  const passwordConfigured = passwordValue !== undefined;
  if (usernameConfigured !== passwordConfigured) {
    throw new Error("ADMIN_SEED_USERNAME 和 ADMIN_SEED_PASSWORD 必须同时配置");
  }
  if (!usernameConfigured || !passwordConfigured) return undefined;

  const username = usernameValue!;
  const password = passwordValue!;
  if (username !== username.trim() || username.length < 1 ||
    username.length > ADMIN_SEED_USERNAME_MAX_LENGTH || CONTROL_CHARACTERS.test(username)) {
    throw new Error("ADMIN_SEED_USERNAME 必须是 1-128 字符且不含首尾空白或控制字符");
  }
  if (password !== password.trim() || password.length < 1 ||
    password.length > ADMIN_SEED_PASSWORD_MAX_LENGTH || CONTROL_CHARACTERS.test(password)) {
    throw new Error("ADMIN_SEED_PASSWORD 必须是 1-256 字符且不含首尾空白或控制字符");
  }
  if (productionMode) {
    const characterClasses = [/[a-z]/u, /[A-Z]/u, /\d/u, /[^a-zA-Z\d]/u]
      .filter((pattern) => pattern.test(password)).length;
    if (ADMIN_SEED_PLACEHOLDER.test(username) || ADMIN_SEED_PLACEHOLDER.test(password) ||
      ADMIN_SEED_WEAK_PASSWORD.test(password) || password.length < 16 || characterClasses < 3 ||
      password.toLowerCase() === username.toLowerCase()) {
      throw new Error("生产 ADMIN_SEED_* 必须使用非占位用户名和至少 16 字符的随机强密码");
    }
  }
  return { username, password };
}

const DEFAULT_CLOUD_API_PORT = 8081;
const DEFAULT_CLOUD_API_BIND_HOST = "127.0.0.1";
const DEFAULT_EXECUTOR_URL = "http://127.0.0.1:8082";
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

interface AddressClassification {
  ipVersion: 0 | 4 | 6;
  loopback: boolean;
  privateNetwork: boolean;
  unspecified: boolean;
}

function ipv4Octets(address: string): readonly number[] | undefined {
  if (isIP(address) !== 4) return undefined;
  return address.split(".").map(Number);
}

function ipv6Words(address: string): readonly number[] | undefined {
  if (isIP(address) !== 6) return undefined;
  let normalized = address.toLowerCase();
  const ipv4TailStart = normalized.lastIndexOf(":");
  if (normalized.includes(".") && ipv4TailStart >= 0) {
    const tail = ipv4Octets(normalized.slice(ipv4TailStart + 1));
    if (!tail) return undefined;
    const highWord = ((tail[0]! << 8) | tail[1]!).toString(16);
    const lowWord = ((tail[2]! << 8) | tail[3]!).toString(16);
    normalized = `${normalized.slice(0, ipv4TailStart)}:${highWord}:${lowWord}`;
  }
  const compressed = normalized.split("::");
  if (compressed.length > 2) return undefined;
  const head = compressed[0] ? compressed[0].split(":").map((part) => Number.parseInt(part, 16)) : [];
  const tail = compressed[1] ? compressed[1].split(":").map((part) => Number.parseInt(part, 16)) : [];
  const missing = 8 - head.length - tail.length;
  if ((compressed.length === 1 && missing !== 0) || (compressed.length === 2 && missing < 1)) return undefined;
  return [...head, ...Array.from({ length: missing }, () => 0), ...tail];
}

function classifyIpAddress(address: string): AddressClassification {
  const octets = ipv4Octets(address);
  if (octets) {
    const [a = 0, b = 0] = octets;
    return {
      ipVersion: 4,
      loopback: a === 127,
      privateNetwork: a === 10 || (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) || (a === 169 && b === 254),
      unspecified: octets.every((octet) => octet === 0),
    };
  }
  const words = ipv6Words(address);
  if (!words) return { ipVersion: 0, loopback: false, privateNetwork: false, unspecified: false };
  const mappedIpv4 = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff
    ? `${words[6]! >>> 8}.${words[6]! & 0xff}.${words[7]! >>> 8}.${words[7]! & 0xff}`
    : undefined;
  if (mappedIpv4) return classifyIpAddress(mappedIpv4);
  return {
    ipVersion: 6,
    loopback: words.slice(0, 7).every((word) => word === 0) && words[7] === 1,
    privateNetwork: (words[0]! & 0xfe00) === 0xfc00 || (words[0]! & 0xffc0) === 0xfe80,
    unspecified: words.every((word) => word === 0),
  };
}

function withoutIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || classifyIpAddress(withoutIpv6Brackets(hostname)).loopback;
}

/** Executor HTTP is only safe for an explicit loopback endpoint; every remote endpoint must use TLS. */
export function parseExecutorUrl(value: string | undefined): string {
  const raw = value ?? DEFAULT_EXECUTOR_URL;
  if (!raw || raw !== raw.trim() || CONTROL_CHARACTERS.test(raw)) {
    throw new Error("EXECUTOR_URL 包含非法空白或控制字符");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("EXECUTOR_URL 必须是合法的 HTTP(S) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("EXECUTOR_URL 必须使用 HTTP(S)");
  }
  const authorityStart = raw.indexOf("//") + 2;
  const authorityEnd = [
    raw.indexOf("/", authorityStart),
    raw.indexOf("?", authorityStart),
    raw.indexOf("#", authorityStart),
  ]
    .filter((index) => index >= 0)
    .reduce((earliest, index) => Math.min(earliest, index), raw.length);
  const hasUserInfo = raw.slice(authorityStart, authorityEnd).includes("@");
  if (hasUserInfo || parsed.username || parsed.password || raw.includes("?") || raw.includes("#")) {
    throw new Error("EXECUTOR_URL 不能包含凭据、查询参数或 fragment");
  }
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    throw new Error("非 loopback EXECUTOR_URL 必须使用 HTTPS");
  }
  return parsed.toString().replace(/\/+$/u, "");
}

function validHostname(hostname: string): boolean {
  return hostname.length <= 253 && hostname.split(".").every((label) =>
    label.length >= 1 && label.length <= 63 && /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/u.test(label));
}

/** Production binds only to a literal loopback, RFC1918, ULA or link-local address. */
export function parseCloudApiBindHost(value: string | undefined, productionMode: boolean): string {
  const host = value === undefined || value === "" ? DEFAULT_CLOUD_API_BIND_HOST : value;
  if (host !== host.trim() || CONTROL_CHARACTERS.test(host)) {
    throw new Error("CLOUD_API_BIND_HOST 包含非法空白或控制字符");
  }
  const classification = classifyIpAddress(host);
  if (classification.unspecified) throw new Error("CLOUD_API_BIND_HOST 不允许 unspecified 地址");
  if (productionMode && (classification.ipVersion === 0 ||
    (!classification.loopback && !classification.privateNetwork))) {
    throw new Error("生产 CLOUD_API_BIND_HOST 必须是 loopback、RFC1918、ULA 或 link-local IP");
  }
  if (classification.ipVersion === 0 && !validHostname(host)) {
    throw new Error("CLOUD_API_BIND_HOST 不是合法主机名或 IP");
  }
  return host;
}

function parseCloudApiPort(value: string | undefined, override: number | undefined): number {
  if (override !== undefined) {
    if (!Number.isInteger(override) || override < 1 || override > 65_535) {
      throw new Error("PORT 必须是 1-65535 的十进制整数");
    }
    return override;
  }

  const rawPort = value ?? String(DEFAULT_CLOUD_API_PORT);
  if (!/^[1-9]\d{0,4}$/u.test(rawPort)) {
    throw new Error("PORT 必须是 1-65535 的十进制整数");
  }
  const port = Number(rawPort);
  if (port > 65_535) throw new Error("PORT 必须是 1-65535 的十进制整数");
  return port;
}

export interface CloudApiEnvironment {
  port: number;
  bindHost: string;
  executorUrl: string;
  databaseUrl?: string;
  productionMode: boolean;
  legacySurfaceEnabled: boolean;
  adminToken?: string;
  corsAllowOrigins?: readonly string[];
  seedUsername?: string;
  seedPassword?: string;
  modelEncryptionKey?: Buffer;
  knowledgeDataKey?: Buffer;
  updateSigningKey?: SigningKey;
  skillSigningKey?: SigningKey;
  cloudPluginSigningKey?: SigningKey;
  cloudCliSigningKey?: SigningKey;
  cloudPluginReleaseDir?: string;
  cloudCliReleaseDir?: string;
  executorCredentialKey: NonNullable<ReturnType<typeof parseExecutorCredentialKey>>;
  updateTrustedPublicKeys: ReadonlyMap<string, string>;
  allowInsecureModelUpstream: boolean;
}

function parseReleaseDirectory(value: string | undefined, name: string, required: boolean): string | undefined {
  if (value === undefined || value === "") {
    if (required) throw new Error(`生产 Cloud API 必须配置 ${name}`);
    return undefined;
  }
  if (value !== value.trim() || CONTROL_CHARACTERS.test(value) || !isAbsolute(value)) {
    throw new Error(`${name} 必须是无首尾空白、无控制字符的绝对路径`);
  }
  return value;
}

export interface CloudApiEnvironmentOverrides {
  port?: number;
  executorUrl?: string;
}

/** Parse and validate every startup environment value before any database or network side effect. */
export function parseCloudApiEnvironment(
  env: NodeJS.ProcessEnv,
  overrides: CloudApiEnvironmentOverrides = {},
): CloudApiEnvironment {
  const databaseUrl = env.DATABASE_URL?.trim() || undefined;
  const productionEnvironment = env.NODE_ENV === "production";
  if (productionEnvironment && !databaseUrl) throw new Error("生产 Cloud API 必须配置 DATABASE_URL");
  const productionMode = productionEnvironment || Boolean(databaseUrl);

  const modelEncryptionKey = parseModelEncryptionKey(env.MODEL_CONFIG_KEY);
  if (productionMode && !modelEncryptionKey) {
    throw new Error("生产 Cloud API 必须配置 MODEL_CONFIG_KEY");
  }
  const allowInsecureModelUpstream = env.MODEL_ALLOW_INSECURE_UPSTREAM === "true";
  if (productionMode && allowInsecureModelUpstream) {
    throw new Error("生产 Cloud API 不允许启用 MODEL_ALLOW_INSECURE_UPSTREAM");
  }

  const requestedLegacySurface = env.LONGHUB_LEGACY_SURFACE_ENABLED === "true";
  if (productionMode && requestedLegacySurface) {
    throw new Error("生产 Cloud API 不允许启用 LONGHUB_LEGACY_SURFACE_ENABLED");
  }
  const adminToken = parseProductionAdminToken(env.ADMIN_TOKEN, productionMode);
  if (productionMode && !adminToken) throw new Error("生产 Cloud API 必须配置高熵 ADMIN_TOKEN");
  const adminSeed = parseAdminSeedCredentials(
    env.ADMIN_SEED_USERNAME,
    env.ADMIN_SEED_PASSWORD,
    productionMode,
  );

  const knowledgeDataKey = parseKnowledgeDataKey(env.KNOWLEDGE_DATA_KEY);
  if (modelEncryptionKey && knowledgeDataKey && modelEncryptionKey.equals(knowledgeDataKey)) {
    throw new Error("KNOWLEDGE_DATA_KEY 不得与 MODEL_CONFIG_KEY 共用");
  }
  const updateSigningKey = parseUpdateSigningKey(env);
  const skillSigningKey = parseSkillSigningKey(env);
  const cloudPluginSigningKey = parseCloudPluginSigningKey(env);
  const cloudCliSigningKey = parseCloudCliSigningKey(env);
  if (productionMode && !updateSigningKey) {
    throw new Error("生产 Cloud API 必须配置独立的 CLIENT_UPDATE_SIGNING_* Ed25519 密钥");
  }
  if (productionMode && !skillSigningKey) {
    throw new Error("生产 Cloud API 必须配置独立的 SKILL_SIGNING_* Ed25519 密钥");
  }
  if (productionMode && !cloudPluginSigningKey) {
    throw new Error("生产 Cloud API 必须配置独立的 CLOUD_PLUGIN_SIGNING_* Ed25519 密钥");
  }
  if (productionMode && !cloudCliSigningKey) {
    throw new Error("生产 Cloud API 必须配置独立的 CLOUD_CLI_SIGNING_* Ed25519 密钥");
  }
  const executorCredentialKey = parseExecutorCredentialKey(env);
  if (!executorCredentialKey) throw new Error("Cloud API 启动需要配置 EXECUTOR_CREDENTIAL_SECRET");

  const corsValue = env.CORS_ALLOW_ORIGINS ?? env.LONGHUB_CORS_ALLOWED_ORIGINS;
  return {
    port: parseCloudApiPort(env.PORT, overrides.port),
    bindHost: parseCloudApiBindHost(env.CLOUD_API_BIND_HOST, productionMode),
    executorUrl: parseExecutorUrl(overrides.executorUrl ?? env.EXECUTOR_URL),
    databaseUrl,
    productionMode,
    legacySurfaceEnabled: !productionMode && requestedLegacySurface,
    adminToken,
    corsAllowOrigins: productionMode || corsValue ? parseCorsAllowOrigins(corsValue) : undefined,
    seedUsername: adminSeed?.username,
    seedPassword: adminSeed?.password,
    modelEncryptionKey,
    knowledgeDataKey,
    updateSigningKey,
    skillSigningKey,
    cloudPluginSigningKey,
    cloudCliSigningKey,
    cloudPluginReleaseDir: parseReleaseDirectory(env.CLOUD_PLUGIN_RELEASE_DIR, "CLOUD_PLUGIN_RELEASE_DIR", productionMode),
    cloudCliReleaseDir: parseReleaseDirectory(env.CLOUD_CLI_RELEASE_DIR, "CLOUD_CLI_RELEASE_DIR", productionMode),
    executorCredentialKey,
    updateTrustedPublicKeys: parseUpdateTrustedPublicKeys(env.CLIENT_UPDATE_TRUSTED_PUBLIC_KEYS_JSON),
    allowInsecureModelUpstream,
  };
}

/** DATABASE_URL 存在时使用 PostgreSQL 持久化，否则用内存存储（仅限本地原型） */
export async function bootstrap(
  port?: number,
  executorUrl?: string,
): Promise<void> {
  const logger = createConsoleLogger("cloud-api");
  const config = parseCloudApiEnvironment(process.env, { port, executorUrl });
  let store;
  if (config.databaseUrl) {
    const pgStore = new PgStore(config.databaseUrl);
    await pgStore.init();
    store = pgStore;
  } else {
    logger.warn("store.memory", { reason: "未配置 DATABASE_URL，任务与设备数据不持久化" });
    store = new MemoryStore();
  }
  // 从环境变量播种初始超级管理员（已存在则跳过）
  if (config.seedUsername && config.seedPassword) {
    const { existed } = await store.createAdmin({
      username: config.seedUsername,
      password_hash: await hashPassword(config.seedPassword),
      role: "super",
    });
    logger.info("admin.seed", { username: config.seedUsername, existed });
  }
  createCloudApiServer({
    executorUrl: config.executorUrl,
    executorCredentialKey: config.executorCredentialKey,
    store,
    adminToken: config.adminToken,
    skillSigningKey: config.skillSigningKey,
    updateSigningKey: config.updateSigningKey,
    cloudPluginSigningKey: config.cloudPluginSigningKey,
    cloudCliSigningKey: config.cloudCliSigningKey,
    cloudPluginReleaseDir: config.cloudPluginReleaseDir,
    cloudCliReleaseDir: config.cloudCliReleaseDir,
    updateTrustedPublicKeys: config.updateTrustedPublicKeys,
    modelEncryptionKey: config.modelEncryptionKey,
    knowledgeDataKey: config.knowledgeDataKey,
    allowInsecureModelUpstream: config.allowInsecureModelUpstream,
    legacySurfaceEnabled: config.legacySurfaceEnabled,
    corsAllowedOrigins: config.corsAllowOrigins,
    productionMode: config.productionMode,
  }).listen(config.port, config.bindHost, () =>
    logger.info("listening", {
      port: config.port,
      host: config.bindHost,
      executorUrl: config.executorUrl,
      persistent: Boolean(config.databaseUrl),
      modules: CONTROL_PLANE_MODULES.length,
    }),
  );
}
