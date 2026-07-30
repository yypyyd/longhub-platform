import { createConsoleLogger } from "@longhub/observability";
import { createPublicKey } from "node:crypto";
import { hashPassword } from "./auth.js";
import { createCloudApiServer } from "./server.js";
import { MemoryStore } from "./memory-store.js";
import { PgStore } from "./pg-store.js";
import { parseModelEncryptionKey } from "./model-gateway.js";
import { parseKnowledgeDataKey } from "./knowledge-crypto.js";
import type { SigningKey } from "./server.js";

export { createCloudApiServer, generateSigningKey, type SigningKey } from "./server.js";
export { MemoryStore } from "./memory-store.js";
export { PgStore } from "./pg-store.js";
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
  CloudStore,
  CloudTask,
  CloudTaskEvent,
  CloudTaskStatus,
  DeviceRecord,
  EntitlementRecord,
  OrderRecord,
  ModelGatewayConfigRecord,
  ModelRequestAggregateRecord,
  PackReleaseRecord,
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
  "telemetry",
  "audit",
] as const;

function normalizePem(value: string): string {
  return value.includes("\\n") ? value.replaceAll("\\n", "\n") : value;
}

/** 生产更新密钥必须完整注入；缺一项时不能退回进程内随机密钥。 */
export function parseUpdateSigningKey(env: NodeJS.ProcessEnv): SigningKey | undefined {
  const values = [
    env.CLIENT_UPDATE_SIGNING_KEY_ID,
    env.CLIENT_UPDATE_SIGNING_PRIVATE_KEY_PEM,
    env.CLIENT_UPDATE_SIGNING_PUBLIC_KEY_PEM,
  ];
  if (values.every((value) => value === undefined)) return undefined;
  if (values.some((value) => !value?.trim())) {
    throw new Error("CLIENT_UPDATE_SIGNING_KEY_ID/PRIVATE_KEY_PEM/PUBLIC_KEY_PEM 必须同时配置");
  }
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(values[0]!)) throw new Error("客户端更新签名 key ID 无效");
  return {
    keyId: values[0]!,
    privateKeyPem: normalizePem(values[1]!),
    publicKeyPem: normalizePem(values[2]!),
  };
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

/** DATABASE_URL 存在时使用 PostgreSQL 持久化，否则用内存存储（仅限本地原型） */
export async function bootstrap(
  port = Number(process.env.PORT ?? 8081),
  executorUrl = process.env.EXECUTOR_URL ?? "http://127.0.0.1:8082",
): Promise<void> {
  const logger = createConsoleLogger("cloud-api");
  const databaseUrl = process.env.DATABASE_URL;
  let store;
  if (databaseUrl) {
    const pgStore = new PgStore(databaseUrl);
    await pgStore.init();
    store = pgStore;
  } else {
    logger.warn("store.memory", { reason: "未配置 DATABASE_URL，任务与设备数据不持久化" });
    store = new MemoryStore();
  }
  // 从环境变量播种初始超级管理员（已存在则跳过）
  const seedUsername = process.env.ADMIN_SEED_USERNAME;
  const seedPassword = process.env.ADMIN_SEED_PASSWORD;
  if (seedUsername && seedPassword) {
    const { existed } = await store.createAdmin({
      username: seedUsername,
      password_hash: hashPassword(seedPassword),
      role: "super",
    });
    logger.info("admin.seed", { username: seedUsername, existed });
  }
  const modelEncryptionKey = parseModelEncryptionKey(process.env.MODEL_CONFIG_KEY);
  const knowledgeDataKey = parseKnowledgeDataKey(process.env.KNOWLEDGE_DATA_KEY);
  const updateSigningKey = parseUpdateSigningKey(process.env);
  const updateTrustedPublicKeys = parseUpdateTrustedPublicKeys(
    process.env.CLIENT_UPDATE_TRUSTED_PUBLIC_KEYS_JSON,
  );
  if (databaseUrl && !updateSigningKey) {
    throw new Error("生产 Cloud API 必须配置独立的 CLIENT_UPDATE_SIGNING_* Ed25519 密钥");
  }
  if (databaseUrl && !knowledgeDataKey) {
    throw new Error("生产 Cloud API 必须配置独立的 KNOWLEDGE_DATA_KEY");
  }
  if (modelEncryptionKey && knowledgeDataKey && Buffer.from(modelEncryptionKey).equals(Buffer.from(knowledgeDataKey))) {
    throw new Error("KNOWLEDGE_DATA_KEY 不得与 MODEL_CONFIG_KEY 共用");
  }
  createCloudApiServer({
    executorUrl,
    store,
    adminToken: process.env.ADMIN_TOKEN,
    updateSigningKey,
    updateTrustedPublicKeys,
    modelEncryptionKey,
    knowledgeDataKey,
    allowInsecureModelUpstream: process.env.MODEL_ALLOW_INSECURE_UPSTREAM === "true",
  }).listen(port, () =>
    logger.info("listening", {
      port,
      executorUrl,
      persistent: Boolean(databaseUrl),
      modules: CONTROL_PLANE_MODULES.length,
    }),
  );
}
