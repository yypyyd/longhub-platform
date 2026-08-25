/**
 * 云台控制面（契约见 contracts/openapi/longhub-cloud-v1.yaml）：
 * - Identity：POST /v1/devices/register（颁发设备凭据）
 * - Entitlement：GET /v1/entitlements；管理面 /v1/admin/entitlements（授予/撤销）
 * - Task：POST /v1/tasks（Idempotency-Key 幂等）、查询、取消、SSE（Last-Event-ID 断线恢复）
 * - Release/Artifact：管理面 /v1/admin/packs（上传→云端签名→发布/吊销）；
 *   设备面 /v1/catalog/packs、/v1/packs/{packId}/download（验授权）、/v1/releases/check、/v1/packs/signing-key
 * 任务与授权接口要求 Bearer 设备凭据；高价值技能转发给龙枢执行器执行。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isAbsolute } from "node:path";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  computePackDigest,
  computeSkillPackageDigest,
  signPackDigest,
  signSkillPackageDigest,
  validatePackContent,
  validatePackManifest,
  validateSkillPackage,
  type PackFile,
  type PackManifest,
  type SkillPackage,
} from "@longhub/pack-schema";
import { compareSemver } from "@longhub/feature-policy";
import {
  CLOUD_SKILL_ADAPTER_RELEASE_MAX_BYTES,
  prepareCloudSkillAdapterRelease,
  verifyStoredCloudSkillAdapterRelease,
} from "./cloud-skill-adapter-release.js";
import {
  CLIENT_TELEMETRY_MAX_BYTES,
  ClientTelemetryValidationError,
  createConsoleLogger,
  parseClientTelemetryBatch,
  type ClientTelemetryEvent,
} from "@longhub/observability";
import { MemoryStore } from "./memory-store.js";
import { handleAccountRoutes } from "./account-routes.js";
import { handleAdminRoutes, requireAdmin, type AdminRouteContext } from "./admin-routes.js";
import { handleClientReleaseRoutes, type ClientReleaseContext } from "./client-release-routes.js";
import { handleCloudArtifactReleaseRoutes, type CloudArtifactReleaseContext } from "./cloud-artifact-release-routes.js";
import { handleModelGatewayRoutes, type UpstreamHostnameResolver } from "./model-gateway.js";
import {
  checkDeviceFeaturePolicy,
  enforceDeviceFeaturePolicy,
  handleFeaturePolicyRoutes,
  type FeaturePolicyRouteContext,
} from "./feature-policy-routes.js";
import { deviceActivationStatus, hashActivationCode, publicActivationCode } from "./activation-code.js";
import {
  DEFAULT_REQUEST_BODY_MAX_BYTES,
  readBody,
  readBoundedBody,
  readJson,
  requireJsonContentType,
  RequestBodyError,
} from "./http-util.js";
import { scanThirdPartyPack } from "./pack-review.js";
import { decryptKnowledgeContent, encryptKnowledgeContent } from "./knowledge-crypto.js";
import { observeHttpRoute } from "./http-route-metrics.js";
import {
  EXECUTOR_CREDENTIAL_HEADER,
  EXECUTOR_CREDENTIAL_MAX_TTL_MS,
  EXECUTOR_REQUEST_SCHEMA,
  computeExecutorInputDigest,
  getDevelopmentExecutorCredentialKey,
  issueExecutorCredential,
  type ExecutorCredentialKey,
} from "longhub-executor";
import { computeCloudTaskRequestFingerprint } from "./task-fingerprint.js";
import { isProductionAdminToken } from "./auth.js";
import {
  createCloudTaskAdmissionPlaceholder,
  isCloudTaskAdmissionPlaceholder,
} from "./store.js";
import type {
  ClientTelemetryAggregateRecord,
  CloudStore,
  CloudTask,
  CloudTaskStatus,
  CloudSkillAccessGrant,
  CloudSkillAdapterReleaseRecord,
  CloudSkillExecutionRejectionReason,
  CloudSkillPlanRecord,
  DeviceRecord,
  DevicePairingConsumeResult,
  EntitlementRecord,
  PackReleaseRecord,
  SkillReleaseRecord,
} from "./store.js";

export interface SigningKey {
  keyId: string;
  privateKeyPem: string;
  publicKeyPem: string;
}

export interface CloudApiOptions {
  executorUrl: string;
  /** Cloud API 与 Executor 之间的独立短时凭据密钥；生产必须显式注入。 */
  executorCredentialKey?: ExecutorCredentialKey;
  /** Executor HTTP 请求超时（不包含任务状态轮询）。 */
  executorRequestTimeoutMs?: number;
  /** Executor 响应体最大字节数；读取过程中流式执行上限。 */
  executorResponseMaxBytes?: number;
  /** 单任务凭据有效期，不能超过执行器协议上限。 */
  executorCredentialTtlMs?: number;
  /** 缺省使用内存存储；生产传入 PgStore */
  store?: CloudStore;
  /** 管理面（Console）凭据；生产从密钥服务下发 */
  adminToken?: string;
  /** 发布签名密钥（Ed25519）；缺省自动生成（仅限开发），生产从密钥服务下发 */
  signingKey?: SigningKey;
  /** Skill 引用专用签名密钥；不得与 Agent Pack 或客户端更新密钥共用 */
  skillSigningKey?: SigningKey;
  /** 客户端更新元数据专用密钥；不得与 Agent Pack 发布密钥共用 */
  updateSigningKey?: SigningKey;
  /** 独立 Cloud Plugin release 签名密钥；不得与其它用途共用 */
  cloudPluginSigningKey?: SigningKey;
  /** 独立 Cloud CLI release 签名密钥；不得与其它用途共用 */
  cloudCliSigningKey?: SigningKey;
  /** 密钥轮换期间保留的历史更新公钥（key ID → Ed25519 PEM） */
  updateTrustedPublicKeys?: ReadonlyMap<string, string>;
  /** 客户端安装包目录；缺省读取 CLIENT_RELEASE_DIR */
  clientReleaseDir?: string;
  cloudPluginReleaseDir?: string;
  cloudCliReleaseDir?: string;
  /** 模型上游 API Key 的 32 字节 AES 主密钥 */
  modelEncryptionKey?: Uint8Array;
  /** 租户知识库正文的独立 32 字节 AES 数据密钥；不得与模型密钥共用 */
  knowledgeDataKey?: Uint8Array;
  /** 仅供本地开发/测试连接 HTTP 或私网模型服务 */
  allowInsecureModelUpstream?: boolean;
  /** 模型代理超时覆盖，仅供确定性测试。 */
  modelProxyTimeoutMs?: number;
  /** 模型上游 DNS 解析器覆盖，仅供确定性测试。 */
  resolveModelUpstreamHostname?: UpstreamHostnameResolver;
  /** 仅供本地协议测试；生产默认 false，任务必须通过 Cloud Skill 订阅门禁。 */
  allowDevelopmentTasks?: boolean;
  /** Explicitly marks the constructor as a production bootstrap. */
  productionMode?: boolean;
  /**
   * Explicit browser origins allowed to call the API.  `undefined` keeps the
   * development wildcard; an empty array is the production same-origin mode
   * (no cross-origin response is exposed).
   */
  corsAllowedOrigins?: readonly string[];
  /**
   * 是否保留旧 Pack/授权码/钱包/商品兼容面。
   *
   * `createCloudApiServer` 在生产/普通运行默认关闭；仅 NODE_ENV=test 的
   * 回归夹具自动兼容旧面，或由非生产调用者显式开启。关闭后旧路由统一
   * 返回稳定的 `LEGACY_SURFACE_DISABLED`，不会删除 Store 中的历史表或记录。
   */
  legacySurfaceEnabled?: boolean;
}

/** 生成一次性开发签名密钥 */
export function generateSigningKey(keyId = `longhub-dev-${new Date().getFullYear()}`): SigningKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    keyId,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function canonicalEd25519PublicKey(pem: string, source: "private" | "public", label: string): string {
  const publicKey = source === "private" ? createPublicKey(createPrivateKey(pem)) : createPublicKey(pem);
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error(`${label}必须是 Ed25519 密钥`);
  return publicKey.export({ type: "spki", format: "pem" }).toString();
}

function isEntitled(entitlements: EntitlementRecord[], packId: string): boolean {
  const now = new Date().toISOString();
  return entitlements.some((e) => e.pack_id === packId && e.status === "active" && e.expires_at > now);
}

function toPackSummary(releases: PackReleaseRecord[]): {
  pack_id: string;
  name: string;
  latest_version: string;
  min_desktop_version: string;
  versions: string[];
  categories: string[];
  capabilities: { capability_id: string; version: string }[];
} {
  const latest = releases[releases.length - 1]!;
  return {
    pack_id: latest.pack_id,
    name: latest.pack_id,
    latest_version: latest.version,
    min_desktop_version: latest.min_desktop_version,
    versions: releases.map((release) => release.version),
    categories: [...new Set(latest.pack.manifest.capabilities.map((capability) => capability.id.split(".").at(-1) ?? "general"))],
    capabilities: latest.pack.manifest.capabilities.map((c) => ({ capability_id: c.id, version: c.version })),
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, code: string, message: string, retryable = false): void {
  sendJson(res, status, { code, message, request_id: randomUUID(), retryable });
}

/**
 * Stable response used when the clean-launch product deliberately removes a
 * legacy surface.  Keeping one code makes Portal/Manager migrations
 * deterministic and avoids leaking whether an old Pack/product row exists.
 */
function sendLegacySurfaceDisabled(res: ServerResponse): void {
  sendError(res, 410, "LEGACY_SURFACE_DISABLED", "该旧产品入口已下线", false);
}

function isLegacyServerPath(url: URL, parts: string[]): boolean {
  if (url.pathname === "/v1/devices/activation" || url.pathname === "/v1/devices/activate") return true;
  if (url.pathname === "/v1/client/runtime-config" || url.pathname === "/v1/client/model-capabilities") return true;
  if (url.pathname === "/v1/knowledge/query") return true;
  if (url.pathname === "/v1/packs/signing-key" || url.pathname === "/v1/skills/signing-key") return true;
  if (url.pathname === "/v1/catalog/packs" || url.pathname === "/v1/entitlements" || url.pathname === "/v1/releases/check") return true;
  if (parts[0] === "v1" && parts[1] === "model") return true;
  if (parts[0] === "v1" && parts[1] === "packs") return true;
  if (parts[0] === "v1" && parts[1] === "skills" && parts[3] === "reference") return true;
  if (parts[0] === "v1" && parts[1] === "admin" &&
    (parts[2] === "packs" || parts[2] === "skills" || parts[2] === "pack-reviews" ||
      parts[2] === "entitlements" || parts[2] === "knowledge-documents")) return true;
  return false;
}

/** Legacy SkillPackage compatibility only. Cloud adapter access never uses this key. */
function skillEntitlementId(skillId: string): string {
  return `skill:${skillId}`;
}

function isSkillCompatible(
  release: SkillReleaseRecord,
  desktopVersion: string,
  openclawVersion?: string,
): boolean {
  return !versionBelow(desktopVersion, release.min_desktop_version) &&
    (openclawVersion === undefined || openclawVersion === release.openclaw_version);
}

function isCloudSkillAdapterCompatible(
  release: CloudSkillAdapterReleaseRecord,
  managerVersion: string,
  openclawVersion?: string,
): boolean {
  return !versionBelow(managerVersion, release.min_manager_version) &&
    (openclawVersion === undefined || openclawVersion === release.openclaw_version);
}

function adapterDownloadBody(release: CloudSkillAdapterReleaseRecord): {
  adapter: { manifest: CloudSkillAdapterReleaseRecord["manifest"]; files: Record<string, string> };
  digest: string;
  signature_key_id: string;
} {
  return {
    adapter: {
      manifest: release.manifest,
      files: { ...release.files },
    },
    digest: release.digest,
    signature_key_id: release.signature_key_id,
  };
}

function toSkillSummary(
  releases: SkillReleaseRecord[],
  entitled: boolean,
  cloudPlanIds: readonly string[] = [],
): Record<string, unknown> {
  const latest = releases[releases.length - 1]!;
  return {
    skill_id: latest.skill_id,
    publisher: latest.package.skill.publisher,
    display: latest.package.skill.display,
    type: latest.package.skill.type,
    latest_version: latest.version,
    versions: releases.map((release) => release.version),
    runtime_kind: latest.runtime_kind,
    compatibility: latest.package.compatibility,
    permissions: latest.package.permissions,
    limits: latest.package.limits,
    entitled,
    plan_ids: [...cloudPlanIds],
    access_mode: cloudPlanIds.length > 0 ? "cloud_subscription" : "legacy_pack_compat",
  };
}

function toCloudSkillAdapterSummary(
  releases: CloudSkillAdapterReleaseRecord[],
  entitled: boolean,
  cloudPlanIds: readonly string[] = [],
): Record<string, unknown> {
  const latest = releases[releases.length - 1]!;
  return {
    skill_id: latest.skill_id,
    publisher: { namespace: "longhub", displayName: "龙枢官方" },
    display: latest.manifest.display,
    type: "cloud_adapter",
    latest_version: latest.version,
    versions: releases.map((release) => release.version),
    runtime_kind: "cloud_adapter",
    compatibility: latest.manifest.compatibility,
    permissions: latest.manifest.permissions,
    limits: {},
    entitled,
    plan_ids: [...cloudPlanIds],
    access_mode: "cloud_subscription",
    adapter_available: true,
  };
}

class ExecutorResponseBodyError extends Error {
  constructor() {
    super("EXECUTOR_RESPONSE_INVALID");
    this.name = "ExecutorResponseBodyError";
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * Read an Executor response without allowing a slow or oversized upstream to
 * defeat the Cloud API's resource limits. `Response.text()` is deliberately
 * avoided: it buffers the complete body before a size check, and a fetch
 * timeout can otherwise be cleared immediately after headers arrive.
 */
async function readBoundedExecutorResponse(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      await response.body?.cancel().catch(() => undefined);
      throw new ExecutorResponseBodyError();
    }
    const declaredBytes = Number(declared);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new ExecutorResponseBodyError();
    }
  }
  if (!response.body) throw new ExecutorResponseBodyError();
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new ExecutorResponseBodyError();
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof ExecutorResponseBodyError) {
      await reader.cancel().catch(() => undefined);
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function versionBelow(current: string, minimum: string): boolean {
  try {
    return compareSemver(current, minimum) < 0;
  } catch {
    return true;
  }
}

function telemetryAggregate(event: ClientTelemetryEvent): ClientTelemetryAggregateRecord {
  const occurredAt = new Date(event.occurred_at);
  occurredAt.setUTCMinutes(0, 0, 0);
  let value = "-";
  let agentCountBucket = "-";
  switch (event.event_type) {
    case "client_started":
      value = event.fields.startup_duration;
      agentCountBucket = event.fields.active_agent_count;
      break;
    case "gateway_state":
      value = event.fields.state;
      break;
    case "client_update_result":
      value = event.fields.result;
      break;
    case "product_error":
      value = event.fields.code;
      break;
    case "previous_exit":
      value = event.fields.result;
      break;
  }
  return {
    bucket_start: occurredAt.toISOString(),
    event_type: event.event_type,
    manager_version: event.manager_version,
    openclaw_version: event.openclaw_version,
    platform: event.platform,
    architecture: event.architecture,
    value,
    agent_count_bucket: agentCountBucket,
    count: 1,
  };
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
}

const TASK_AGENT_HEADER = "x-longhub-agent-id";
const DEFAULT_TASK_AGENT_ID = "openclaw-default";
const TASK_AGENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CLOUD_CALL_SCHEMA = "longhub/cloud-skill-call/v1";
const CLOUD_SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,127}$/;
const CLOUD_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const CLOUD_SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~:-]{0,127}$/;
const PAIRING_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{12}$/;
const PAIRING_CODE_TTL_MS = 10 * 60_000;
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newPairingCode(): string {
  const bytes = randomBytes(12);
  let value = "";
  for (const byte of bytes) value += PAIRING_CODE_ALPHABET[byte % PAIRING_CODE_ALPHABET.length];
  return value;
}

function normalizePairingCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toUpperCase().replace(/[\s-]/gu, "");
  return PAIRING_CODE_PATTERN.test(normalized) ? normalized : undefined;
}

function hashPairingCode(code: string): string {
  return `v1:${createHash("sha256").update(code, "utf8").digest("hex")}`;
}
const SESSION_KEY_HASH_PATTERN = /^[a-f0-9]{64}$/;
const CLOUD_TASK_MAX_BYTES = 1 << 20;
const CLOUD_TASK_MAX_DEPTH = 32;
const CLOUD_TASK_MAX_KEYS = 256;

interface CloudTaskCall {
  schema_version?: unknown;
  request_id?: unknown;
  kind?: unknown;
  skill_id?: unknown;
  skill_version?: unknown;
  agent_id?: unknown;
  tool_call_id?: unknown;
  session_key_hash?: unknown;
  idempotency_key?: unknown;
  plan_id?: unknown;
  input?: unknown;
}

interface NormalizedCloudTaskCall {
  /** False only for the pre-v1 compatibility envelope accepted to preserve a
   * stable authorization error for old clients. It can never bypass a Cloud
   * Skill subscription or execute a production task. */
  strict: boolean;
  requestId: string;
  skillId: string;
  skillVersion: string;
  agentId: string;
  toolCallId: string;
  sessionKeyHash: string;
  idempotencyKey: string;
  requestedPlanId?: string;
  /** Optional caller-reported OpenClaw version used for release revalidation. */
  openclawVersion?: string;
  input: Record<string, unknown>;
}

function taskAgentId(req: IncomingMessage): string {
  const header = req.headers[TASK_AGENT_HEADER];
  return typeof header === "string" && TASK_AGENT_PATTERN.test(header)
    ? header
    : DEFAULT_TASK_AGENT_ID;
}

class CloudTaskRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "CloudTaskRequestError";
  }
}

function cloudSkillReservationProblem(reason: CloudSkillExecutionRejectionReason): {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
} {
  switch (reason) {
    case "QUOTA_EXCEEDED":
      return { status: 403, code: "CLOUD_SKILL_QUOTA_EXCEEDED", message: "云端 Skill 周期额度已用尽", retryable: false };
    case "RATE_LIMITED":
      return { status: 429, code: "CLOUD_SKILL_RATE_LIMITED", message: "云端 Skill 调用过于频繁", retryable: true };
    case "CONCURRENCY_LIMIT":
      return { status: 429, code: "CLOUD_SKILL_CONCURRENCY_LIMIT", message: "云端 Skill 并发额度已用尽", retryable: true };
    case "SUBSCRIPTION_INACTIVE":
    case "SKILL_NOT_ENTITLED":
      return { status: 403, code: "CLOUD_SKILL_SUBSCRIPTION_REQUIRED", message: "云端 Skill 订阅无效或已失效", retryable: false };
    case "PLAN_MISMATCH":
      return { status: 403, code: "CLOUD_SKILL_PLAN_MISMATCH", message: "云端 Skill 计划与订阅不匹配", retryable: false };
    case "IDEMPOTENCY_CONFLICT":
      return { status: 409, code: "IDEMPOTENCY_CONFLICT", message: "幂等键已绑定其他请求", retryable: false };
    case "INVALID_REQUEST":
      return { status: 422, code: "SKILL_INPUT_INVALID", message: "云端 Skill 执行请求无效", retryable: false };
    case "STORAGE_UNAVAILABLE":
      return { status: 503, code: "CLOUD_SKILL_USAGE_UNAVAILABLE", message: "云端 Skill 用量服务暂时不可用", retryable: true };
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * JSON.parse silently keeps the last value for duplicate object keys.  The
 * Bridge rejects duplicates before forwarding, but Cloud API also needs a
 * strict boundary for callers that bypass the local Manager in development or
 * through a misconfigured proxy.  This scanner only returns top-level keys;
 * JSON.parse remains the authority for value syntax.
 */
function topLevelJsonKeys(raw: string): string[] | undefined {
  const skipWhitespace = (index: number): number => {
    while (index < raw.length && /\s/.test(raw[index]!)) index += 1;
    return index;
  };
  const readStringEnd = (start: number): number => {
    if (raw[start] !== '"') return -1;
    let escaped = false;
    for (let index = start + 1; index < raw.length; index += 1) {
      const char = raw[index]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') return index + 1;
    }
    return -1;
  };
  const skipValue = (start: number): number => {
    let index = start;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (; index < raw.length; index += 1) {
      const char = raw[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === "{" || char === "[") {
        depth += 1;
        continue;
      }
      if (char === "}" || char === "]") {
        if (depth === 0) return index;
        depth -= 1;
        continue;
      }
      if (depth === 0 && char === ",") return index;
    }
    return index;
  };

  let index = skipWhitespace(0);
  if (raw[index] !== "{") return undefined;
  index = skipWhitespace(index + 1);
  const keys: string[] = [];
  if (raw[index] === "}") return keys;
  while (index < raw.length) {
    index = skipWhitespace(index);
    const end = readStringEnd(index);
    if (end < 0) return undefined;
    let key: unknown;
    try {
      key = JSON.parse(raw.slice(index, end));
    } catch {
      return undefined;
    }
    if (typeof key !== "string") return undefined;
    keys.push(key);
    index = skipWhitespace(end);
    if (raw[index] !== ":") return undefined;
    index = skipWhitespace(index + 1);
    const valueEnd = skipValue(index);
    if (valueEnd < index) return undefined;
    index = skipWhitespace(valueEnd);
    if (raw[index] === "}") return keys;
    if (raw[index] !== ",") return undefined;
    index = skipWhitespace(index + 1);
  }
  return undefined;
}

function validateJsonValue(value: unknown, depth = 0, state = { keys: 0 }): void {
  if (depth > CLOUD_TASK_MAX_DEPTH) throw new CloudTaskRequestError(422, "SKILL_INPUT_INVALID", "云端 Skill 输入嵌套过深");
  if (Array.isArray(value)) {
    if (value.length > CLOUD_TASK_MAX_KEYS) throw new CloudTaskRequestError(422, "SKILL_INPUT_INVALID", "云端 Skill 输入数组过大");
    for (const item of value) validateJsonValue(item, depth + 1, state);
    return;
  }
  if (isPlainRecord(value)) {
    state.keys += Object.keys(value).length;
    if (state.keys > CLOUD_TASK_MAX_KEYS) throw new CloudTaskRequestError(422, "SKILL_INPUT_INVALID", "云端 Skill 输入字段过多");
    for (const item of Object.values(value)) validateJsonValue(item, depth + 1, state);
  }
}

const RESERVED_CLOUD_INPUT_KEYS = new Set([
  "skill_id", "skillId", "skill_version", "skillVersion", "plan_id", "planId",
  "agent_id", "agentId", "tool_call_id", "toolCallId", "session_key_hash", "sessionKeyHash",
  "request_id", "requestId", "idempotency_key", "idempotencyKey", "schema_version", "schemaVersion",
]);

function parseCloudTaskCall(
  raw: string,
  idempotencyHeader: string,
  allowDevelopmentTasks: boolean,
): NormalizedCloudTaskCall {
  const keys = topLevelJsonKeys(raw);
  if (keys === undefined || new Set(keys).size !== keys.length) {
    throw new CloudTaskRequestError(400, "INVALID_JSON", "请求体不是合法的严格 JSON");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CloudTaskRequestError(400, "INVALID_JSON", "请求体不是合法 JSON");
  }
  if (!isPlainRecord(value)) throw new CloudTaskRequestError(422, "INVALID_TASK", "任务请求必须是对象");
  const parsed = value as CloudTaskCall;
  const strictKeys = new Set([
    "schema_version", "request_id", "kind", "skill_id", "skill_version", "agent_id",
    "tool_call_id", "session_key_hash", "idempotency_key", "plan_id", "input",
  ]);
  if (keys.some((key) => !strictKeys.has(key))) {
    throw new CloudTaskRequestError(422, "INVALID_TASK", "任务请求包含未知字段");
  }
  const compatibility = parsed.schema_version === undefined &&
    isPlainRecord(parsed.input) &&
    (typeof parsed.input.skill_id === "string" || typeof parsed.input.skillId === "string");
  // Parse the pre-v1 envelope far enough to reach the normal entitlement
  // gate.  Cloud Skill requests still fail closed at the strict-boundary
  // check below after subscription validation; gating parsing itself would
  // turn an unauthorised legacy-shaped call into a misleading 422 instead of
  // the stable 403 subscription response expected by older clients.
  const legacy = compatibility;
  if (!compatibility && parsed.schema_version !== CLOUD_CALL_SCHEMA) {
    throw new CloudTaskRequestError(422, "INVALID_TASK", "schema_version 不受支持");
  }
  if (parsed.kind !== "skill.execute") {
    throw new CloudTaskRequestError(422, "INVALID_TASK", "kind 必须为 skill.execute");
  }
  if (!isPlainRecord(parsed.input)) {
    throw new CloudTaskRequestError(422, "SKILL_INPUT_INVALID", "input 必须是 JSON 对象");
  }
  validateJsonValue(parsed.input);
  if (!legacy && !compatibility && Object.keys(parsed.input).some((key) => RESERVED_CLOUD_INPUT_KEYS.has(key))) {
    throw new CloudTaskRequestError(422, "SKILL_INPUT_INVALID", "input 不得包含身份或幂等元数据");
  }

  const inputSkillId = typeof parsed.input.skill_id === "string"
    ? parsed.input.skill_id
    : typeof parsed.input.skillId === "string" ? parsed.input.skillId : undefined;
  const skillId = legacy ? (typeof parsed.skill_id === "string" ? parsed.skill_id : inputSkillId) : parsed.skill_id;
  const skillVersion = legacy
    ? (typeof parsed.skill_version === "string" ? parsed.skill_version : "0.0.0-dev")
    : parsed.skill_version;
  const requestId = legacy
    ? (typeof parsed.request_id === "string" ? parsed.request_id : `dev-${idempotencyHeader}`)
    : parsed.request_id;
  const agentId = legacy
    ? (typeof parsed.agent_id === "string" ? parsed.agent_id : taskAgentId({ headers: {} } as IncomingMessage))
    : parsed.agent_id;
  const toolCallId = legacy
    ? (typeof parsed.tool_call_id === "string" ? parsed.tool_call_id : `dev-${idempotencyHeader}`)
    : parsed.tool_call_id;
  const sessionKeyHash = legacy
    ? (typeof parsed.session_key_hash === "string" ? parsed.session_key_hash : "0".repeat(64))
    : parsed.session_key_hash;
  const bodyIdempotency = parsed.idempotency_key;
  const idempotencyKey = bodyIdempotency === undefined && legacy ? idempotencyHeader : bodyIdempotency;

  if (typeof skillId !== "string" || !CLOUD_SKILL_ID_PATTERN.test(skillId)) {
    throw new CloudTaskRequestError(422, "INVALID_TASK", "skill_id 格式无效");
  }
  if (typeof skillVersion !== "string" || !CLOUD_VERSION_PATTERN.test(skillVersion)) {
    throw new CloudTaskRequestError(422, "INVALID_TASK", "skill_version 格式无效");
  }
  if (typeof requestId !== "string" || !CLOUD_SAFE_ID_PATTERN.test(requestId)) {
    throw new CloudTaskRequestError(422, "INVALID_TASK", "request_id 格式无效");
  }
  if (typeof agentId !== "string" || !TASK_AGENT_PATTERN.test(agentId)) {
    throw new CloudTaskRequestError(422, "INVALID_TASK", "agent_id 格式无效");
  }
  if (typeof toolCallId !== "string" || !CLOUD_SAFE_ID_PATTERN.test(toolCallId)) {
    throw new CloudTaskRequestError(422, "INVALID_TASK", "tool_call_id 格式无效");
  }
  if (typeof sessionKeyHash !== "string" || !SESSION_KEY_HASH_PATTERN.test(sessionKeyHash)) {
    throw new CloudTaskRequestError(422, "INVALID_TASK", "session_key_hash 格式无效");
  }
  if (typeof idempotityHeaderGuard(idempotencyHeader) !== "string") {
    throw new CloudTaskRequestError(400, "IDEMPOTENCY_KEY_INVALID", "Idempotency-Key 格式无效");
  }
  if (typeof idempotencyKey !== "string" || idempotencyKey !== idempotencyHeader || !CLOUD_SAFE_ID_PATTERN.test(idempotencyKey)) {
    throw new CloudTaskRequestError(409, "IDEMPOTENCY_CONFLICT", "幂等键头部与请求体不一致");
  }
  const requestedPlanId = parsed.plan_id ?? (
    compatibility && typeof parsed.input.plan_id === "string" ? parsed.input.plan_id
      : compatibility && typeof parsed.input.planId === "string" ? parsed.input.planId
        : undefined
  );
  if (requestedPlanId !== undefined && (typeof requestedPlanId !== "string" || !CLOUD_SAFE_ID_PATTERN.test(requestedPlanId))) {
    throw new CloudTaskRequestError(422, "INVALID_TASK", "plan_id 格式无效");
  }
  return {
    strict: !compatibility,
    requestId,
    skillId,
    skillVersion,
    agentId,
    toolCallId,
    sessionKeyHash,
    idempotencyKey,
    ...(typeof requestedPlanId === "string" ? { requestedPlanId } : {}),
    input: parsed.input,
  };
}

function idempotityHeaderGuard(value: string): string | undefined {
  return CLOUD_SAFE_ID_PATTERN.test(value) ? value : undefined;
}

function taskBelongsToDevice(
  task: { tenant_id: string; device_id: string; agent_id: string },
  device: DeviceRecord,
  agentId: string,
): boolean {
  return task.tenant_id === device.tenant_id && task.device_id === device.device_id && task.agent_id === agentId;
}

export function createCloudApiServer(options: CloudApiOptions): Server {
  const logger = createConsoleLogger("cloud-api");
  // The new product surface is the only default. Historical Pack/activation/
  // wallet routes are available only when a caller explicitly opts in (for a
  // quarantined compatibility fixture); NODE_ENV must never silently widen
  // the production surface.
  const legacySurfaceEnabled = options.legacySurfaceEnabled === true;
  // Development task bypasses are never a production capability. A clean
  // launch may use them only from an explicit test process.
  const allowDevelopmentTasks = options.allowDevelopmentTasks === true &&
    (legacySurfaceEnabled || process.env.NODE_ENV === "test");
  const allowMockPayment = legacySurfaceEnabled && (
    allowDevelopmentTasks || process.env.NODE_ENV === "test"
  );
  if (options.knowledgeDataKey && options.knowledgeDataKey.byteLength !== 32) {
    throw new Error("知识库数据加密密钥长度必须为 32 字节");
  }
  if (options.modelEncryptionKey && options.knowledgeDataKey &&
    Buffer.from(options.modelEncryptionKey).equals(Buffer.from(options.knowledgeDataKey))) {
    throw new Error("知识库数据密钥不得与模型配置密钥共用");
  }
  const store = options.store ?? new MemoryStore();
  const executorCredentialKey = options.executorCredentialKey ?? getDevelopmentExecutorCredentialKey();
  const executorRequestTimeoutMs = options.executorRequestTimeoutMs ?? 35_000;
  const executorResponseMaxBytes = options.executorResponseMaxBytes ?? CLOUD_TASK_MAX_BYTES;
  const executorCredentialTtlMs = options.executorCredentialTtlMs ?? 60_000;
  if (
    !Number.isSafeInteger(executorRequestTimeoutMs) || executorRequestTimeoutMs <= 0 ||
    !Number.isSafeInteger(executorResponseMaxBytes) || executorResponseMaxBytes <= 0 ||
    !Number.isSafeInteger(executorCredentialTtlMs) || executorCredentialTtlMs <= 0 ||
    executorCredentialTtlMs > EXECUTOR_CREDENTIAL_MAX_TTL_MS
  ) {
    throw new Error("Executor 请求/凭据超时配置无效");
  }
  // Never ship a known fallback credential.  Development/test callers may
  // omit the static token and use the database-backed admin session instead;
  // the production bootstrap enforces a high-entropy ADMIN_TOKEN before it
  // reaches this constructor.
  const adminToken = options.adminToken?.trim() || undefined;
  const productionMode = options.productionMode === true || process.env.NODE_ENV === "production" ||
    Boolean(process.env.DATABASE_URL);
  if (productionMode && (!adminToken || !isProductionAdminToken(adminToken))) {
    throw new Error("生产 Cloud API 必须配置至少 32 字符的非占位高熵 ADMIN_TOKEN");
  }
  const corsAllowedOrigins = options.corsAllowedOrigins === undefined
    ? undefined
    : [...new Set(options.corsAllowedOrigins.map((origin) => origin.trim()).filter(Boolean))];
  if (corsAllowedOrigins !== undefined && corsAllowedOrigins.some((origin) => {
    try {
      const parsed = new URL(origin);
      return !["http:", "https:"].includes(parsed.protocol) ||
        parsed.origin !== origin || parsed.username !== "" || parsed.password !== "";
    } catch {
      return true;
    }
  })) {
    throw new Error("CORS allowlist 必须是无路径的 HTTP(S) origin");
  }
  const allowWildcardCors = corsAllowedOrigins === undefined && !productionMode;
  if (productionMode && (!options.cloudPluginSigningKey || !options.cloudCliSigningKey)) {
    throw new Error("生产 Cloud API 必须配置独立的 Cloud Plugin/CLI release 签名密钥");
  }
  if (productionMode && (!options.cloudPluginReleaseDir || !options.cloudCliReleaseDir ||
      !isAbsolute(options.cloudPluginReleaseDir) || !isAbsolute(options.cloudCliReleaseDir))) {
    throw new Error("生产 Cloud API 必须配置 Cloud Plugin/CLI release 绝对目录");
  }
  const signingKey = options.signingKey ?? generateSigningKey();
  const skillSigningKey = options.skillSigningKey ?? generateSigningKey(`longhub-skill-dev-${new Date().getFullYear()}`);
  const updateSigningKey = options.updateSigningKey ?? generateSigningKey(`longhub-update-dev-${new Date().getFullYear()}`);
  const cloudPluginSigningKey = options.cloudPluginSigningKey ?? generateSigningKey(`longhub-cloud-plugin-dev-${new Date().getFullYear()}`);
  const cloudCliSigningKey = options.cloudCliSigningKey ?? generateSigningKey(`longhub-cloud-cli-dev-${new Date().getFullYear()}`);
  const encodeKnowledge = (content: string, tenantId: string): string =>
    options.knowledgeDataKey ? encryptKnowledgeContent(content, tenantId, options.knowledgeDataKey) : content;
  const decodeKnowledge = (content: string, tenantId: string): string =>
    options.knowledgeDataKey ? decryptKnowledgeContent(content, tenantId, options.knowledgeDataKey) : content;
  const derivedPackPublicKey = canonicalEd25519PublicKey(signingKey.privateKeyPem, "private", "Agent Pack 签名私钥");
  const derivedSkillPublicKey = canonicalEd25519PublicKey(
    skillSigningKey.privateKeyPem,
    "private",
    "Skill 引用签名私钥",
  );
  const configuredSkillPublicKey = canonicalEd25519PublicKey(
    skillSigningKey.publicKeyPem,
    "public",
    "Skill 引用签名公钥",
  );
  const derivedUpdatePublicKey = canonicalEd25519PublicKey(
    updateSigningKey.privateKeyPem,
    "private",
    "客户端更新签名私钥",
  );
  const configuredUpdatePublicKey = canonicalEd25519PublicKey(
    updateSigningKey.publicKeyPem,
    "public",
    "客户端更新签名公钥",
  );
  const derivedCloudPluginPublicKey = canonicalEd25519PublicKey(cloudPluginSigningKey.privateKeyPem, "private", "Cloud Plugin release 签名私钥");
  const configuredCloudPluginPublicKey = canonicalEd25519PublicKey(cloudPluginSigningKey.publicKeyPem, "public", "Cloud Plugin release 签名公钥");
  const derivedCloudCliPublicKey = canonicalEd25519PublicKey(cloudCliSigningKey.privateKeyPem, "private", "Cloud CLI release 签名私钥");
  const configuredCloudCliPublicKey = canonicalEd25519PublicKey(cloudCliSigningKey.publicKeyPem, "public", "Cloud CLI release 签名公钥");
  if (updateSigningKey.keyId === signingKey.keyId || derivedUpdatePublicKey === derivedPackPublicKey) {
    throw new Error("客户端更新签名密钥必须与 Agent Pack 发布密钥分离");
  }
  if (
    skillSigningKey.keyId === signingKey.keyId ||
    skillSigningKey.keyId === updateSigningKey.keyId ||
    derivedSkillPublicKey === derivedPackPublicKey ||
    derivedSkillPublicKey === derivedUpdatePublicKey
  ) {
    throw new Error("Skill 引用签名密钥必须与 Agent Pack 和客户端更新密钥分离");
  }
  if (derivedSkillPublicKey !== configuredSkillPublicKey) {
    throw new Error("Skill 引用签名公钥与私钥不匹配");
  }
  if (derivedUpdatePublicKey !== configuredUpdatePublicKey) {
    throw new Error("客户端更新签名公钥与私钥不匹配");
  }
  if (derivedCloudPluginPublicKey !== configuredCloudPluginPublicKey || derivedCloudCliPublicKey !== configuredCloudCliPublicKey) {
    throw new Error("Cloud release 签名公钥与私钥不匹配");
  }
  const releaseKeys = [
    [signingKey.keyId, derivedPackPublicKey],
    [skillSigningKey.keyId, derivedSkillPublicKey],
    [updateSigningKey.keyId, derivedUpdatePublicKey],
    [cloudPluginSigningKey.keyId, derivedCloudPluginPublicKey],
    [cloudCliSigningKey.keyId, derivedCloudCliPublicKey],
  ];
  if (new Set(releaseKeys.map(([keyId]) => keyId)).size !== releaseKeys.length || new Set(releaseKeys.map(([, key]) => key)).size !== releaseKeys.length) {
    throw new Error("Cloud release 签名密钥必须与其它发布用途分离");
  }
  const updateTrustedPublicKeys = new Map<string, string>();
  for (const [keyId, publicKeyPem] of options.updateTrustedPublicKeys ?? []) {
    updateTrustedPublicKeys.set(
      keyId,
      canonicalEd25519PublicKey(publicKeyPem, "public", `客户端更新历史公钥 ${keyId}`),
    );
  }
  const knownUpdatePublicKey = updateTrustedPublicKeys.get(updateSigningKey.keyId);
  if (knownUpdatePublicKey && knownUpdatePublicKey !== configuredUpdatePublicKey) {
    throw new Error(`客户端更新 key ID 冲突: ${updateSigningKey.keyId}`);
  }
  updateTrustedPublicKeys.set(updateSigningKey.keyId, configuredUpdatePublicKey);
  const activationAttempts = new Map<string, { count: number; resetsAt: number }>();
  const telemetryAttempts = new Map<string, { count: number; resetsAt: number }>();
  /** Active Cloud API → Executor requests, used to abort work on task cancel. */
  const activeTaskControllers = new Map<string, AbortController>();

  async function authenticateRegistered(req: IncomingMessage, res: ServerResponse): Promise<DeviceRecord | undefined> {
    const token = bearerToken(req);
    const device = token ? await store.findDeviceByToken(token) : undefined;
    if (!device || device.status !== "active") {
      sendError(res, 401, "UNAUTHORIZED", "缺少或无效的设备凭据");
      return undefined;
    }
    if (device.min_required_version !== undefined && versionBelow(device.app_version, device.min_required_version)) {
      sendError(res, 426, "CLIENT_VERSION_UNSUPPORTED", "当前龙枢版本低于管理员要求，请先更新客户端");
      return undefined;
    }
    void store.updateDeviceOperations(device.device_id, { last_seen_at: new Date().toISOString() }).catch(() => undefined);
    return device;
  }

  async function authenticateCloudTaskDevice(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<DeviceRecord | undefined> {
    const device = await authenticateRegistered(req, res);
    if (!device) return undefined;
    if (device.platform === "openclaw-plugin-windows") return device;

    await store.appendAudit(`device:${device.device_id}`, "cloud_task.execution_denied", {
      platform: device.platform,
      reason: "cloud_plugin_device_required",
    }).catch(() => undefined);
    sendError(
      res,
      403,
      "CLOUD_PLUGIN_DEVICE_REQUIRED",
      "云端任务仅允许 LongHub Cloud Plugin 设备访问",
    );
    return undefined;
  }

  async function authenticate(req: IncomingMessage, res: ServerResponse): Promise<DeviceRecord | undefined> {
    const device = await authenticateRegistered(req, res);
    if (!device) return undefined;
    const activation = await deviceActivationStatus(store, device);
    if (!activation.activated) {
      sendError(res, 403, activation.reason ?? "ACTIVATION_REQUIRED", "请先使用有效授权码激活龙枢");
      return undefined;
    }
    return device;
  }

  async function cloudPlansForSkill(skillId: string): Promise<CloudSkillPlanRecord[]> {
    return (await store.listCloudSkillPlans()).filter((plan) => plan.skill_ids.includes(skillId));
  }

  /**
   * Resolve the new commercial line. Legacy `skill:<id>` Pack entitlements are
   * accepted only for the old builtin SkillPackage surface, never when a Cloud
   * Skill plan is declared for the Skill.
   */
  async function resolveSkillAccess(device: DeviceRecord, skillId: string): Promise<{
    entitled: boolean;
    cloudPlanIds: string[];
    cloud: boolean;
  }> {
    const plans = await cloudPlansForSkill(skillId);
    if (plans.length > 0) {
      const grant = device.user_id
        ? await store.resolveCloudSkillAccess({
            user_id: device.user_id,
            tenant_id: device.tenant_id,
            skill_id: skillId,
            allowed_plan_ids: plans.map((plan) => plan.plan_id),
          })
        : undefined;
      return { entitled: grant !== undefined, cloudPlanIds: plans.map((plan) => plan.plan_id), cloud: true };
    }
    if (!legacySurfaceEnabled) {
      return { entitled: false, cloudPlanIds: [], cloud: false };
    }
    const legacy = (await store.listEntitlements(device.device_id)).some((entitlement) =>
      entitlement.pack_id === skillEntitlementId(skillId) && entitlement.status === "active" &&
      entitlement.expires_at > new Date().toISOString(),
    );
    return { entitled: legacy, cloudPlanIds: [], cloud: false };
  }

  /**
   * Resolve the immutable implementation reference used at execution time.
   * Thin native OpenClaw adapters are authoritative in the clean-launch
   * product. The older SkillPackage release is only a compatibility fallback
   * while the explicit legacy surface flag is enabled for regression fixtures.
   */
  async function checkExecutionRelease(
    skillId: string,
    version: string,
    device: DeviceRecord,
    openclawVersion?: string,
  ): Promise<
    | { ok: true; kind: "adapter" | "legacy" }
    | { ok: false; status: number; code: string; message: string; retryable?: boolean }
  > {
    const adapter = await store.getCloudSkillAdapterRelease(skillId, version);
    if (adapter) {
      if (adapter.status === "revoked") {
        return { ok: false, status: 410, code: "SKILL_RELEASE_REVOKED", message: "云端 Skill 适配器版本已撤销" };
      }
      if (!verifyStoredCloudSkillAdapterRelease(adapter, skillSigningKey)) {
        return {
          ok: false,
          status: 503,
          code: "SKILL_DISTRIBUTION_UNAVAILABLE",
          message: "云端 Skill 适配器制品暂时不可用",
          retryable: true,
        };
      }
      if (!isCloudSkillAdapterCompatible(adapter, device.app_version, openclawVersion)) {
        return { ok: false, status: 422, code: "SKILL_INCOMPATIBLE", message: "云端 Skill 适配器与当前版本不兼容" };
      }
      return { ok: true, kind: "adapter" };
    }

    if (!legacySurfaceEnabled) {
      return { ok: false, status: 404, code: "SKILL_NOT_FOUND", message: "云端 Skill 适配器版本不可用" };
    }
    const legacy = await store.getSkillRelease(skillId, version);
    if (!legacy) {
      return { ok: false, status: 404, code: "SKILL_NOT_FOUND", message: "云端 Skill 版本不可用" };
    }
    if (legacy.status === "revoked") {
      return { ok: false, status: 410, code: "SKILL_RELEASE_REVOKED", message: "云端 Skill 版本已撤销" };
    }
    if (!isSkillCompatible(legacy, device.app_version, openclawVersion)) {
      return { ok: false, status: 422, code: "SKILL_INCOMPATIBLE", message: "云端 Skill 与当前版本不兼容" };
    }
    return { ok: true, kind: "legacy" };
  }

  async function runTask(params: {
    taskId: string;
    device: DeviceRecord;
    call: NormalizedCloudTaskCall;
    grant?: CloudSkillAccessGrant;
    reservationId?: string;
  }): Promise<void> {
    const { taskId, device, call, grant, reservationId } = params;
    let reservationReleased = false;
    const releaseReservation = async () => {
      if (reservationReleased || !reservationId || !store.releaseCloudSkillExecution) return;
      reservationReleased = true;
      await store.releaseCloudSkillExecution({
        reservation_id: reservationId,
        task_id: taskId,
        tenant_id: device.tenant_id,
        user_id: device.user_id,
      }).catch(() => undefined);
    };
    let controller: AbortController | undefined;
    const failClosedOnTaskStateRead = async (): Promise<void> => {
      // A transient state-store read failure must not silently abandon a task
      // after the worker has claimed it.  Try to leave a retryable terminal
      // record; the CAS is harmless if cancellation won the race.
      await store.transitionIfStatus(taskId, ["running"], "failed", {
        error: {
          code: "TASK_STATE_UNAVAILABLE",
          message: "云端任务状态暂时不可用",
          retryable: true,
        },
      }).catch(() => undefined);
      await releaseReservation();
    };
    const stopIfNotRunning = async (): Promise<boolean> => {
      if (controller?.signal.aborted) {
        await releaseReservation();
        return true;
      }
      let current: CloudTask | undefined;
      try {
        current = await store.getTask(taskId);
      } catch {
        await failClosedOnTaskStateRead();
        return true;
      }
      if (controller?.signal.aborted || current?.status !== "running") {
        await releaseReservation();
        return true;
      }
      return false;
    };
    const completeRunningTask = (
      status: Extract<CloudTaskStatus, "succeeded" | "failed" | "timed_out">,
      patch?: Partial<CloudTask>,
    ) => store.transitionIfStatus(taskId, ["running"], status, patch);
    try {
      // Claim is a storage-level pending→running CAS. Reading first and then
      // unconditionally transitioning would allow a concurrent cancel to be
      // resurrected as running.
      const claimed = await store.claimPendingTask(taskId);
      if (!claimed) {
        await releaseReservation();
        return;
      }
      // Register the cancellation signal immediately after the running claim,
      // before any subscription/policy/binding await.  A cancel racing this
      // preflight window can then abort the worker before it crosses Executor.
      controller = new AbortController();
      activeTaskControllers.set(taskId, controller);
      if (await stopIfNotRunning()) return;

      // Re-check the account/subscription immediately before crossing the
      // Cloud API → Executor boundary. Admission and execution are separate
      // moments; cancellation, refund, expiry or device revocation between
      // them must fail closed.
      if (grant && device.user_id) {
        const user = await store.getUser(device.user_id);
        if (await stopIfNotRunning()) return;
        const currentGrant = user?.status === "active"
          ? await store.resolveCloudSkillAccess({
              user_id: device.user_id,
              tenant_id: device.tenant_id,
              skill_id: call.skillId,
              allowed_plan_ids: [grant.plan.plan_id],
            })
          : undefined;
        if (await stopIfNotRunning()) return;
        if (!currentGrant || currentGrant.subscription.subscription_id !== grant.subscription.subscription_id) {
          await completeRunningTask("failed", {
            error: { code: "SUBSCRIPTION_EXPIRED", message: "云端 Skill 订阅已失效", retryable: false },
          });
          await releaseReservation();
          return;
        }
      }

      const policyCheck = await checkDeviceFeaturePolicy(
        featurePolicyCtx,
        device,
        "skill.execute",
        { allowWhenMissing: true },
      );
      if (await stopIfNotRunning()) return;
      if (!policyCheck.allowed) {
        const policyError = policyCheck.reason === "EMERGENCY_DISABLED"
          ? { code: "FEATURE_EMERGENCY_DISABLED", message: "该功能已紧急停用", retryable: true }
          : policyCheck.reason === "POLICY_UNAVAILABLE"
            ? { code: "FEATURE_POLICY_UNAVAILABLE", message: "功能策略当前不可用", retryable: true }
            : { code: "FEATURE_ACCESS_DENIED", message: "该功能当前未开放", retryable: false };
        await completeRunningTask("failed", { error: policyError });
        await releaseReservation();
        return;
      }

      // A release may be revoked or replaced after task admission. Re-read the
      // adapter first immediately before issuing the private Executor
      // credential. Legacy SkillPackage is consulted only in compatibility
      // mode; a clean launch must never execute from the old release table.
      if (grant && !allowDevelopmentTasks) {
        const releaseCheck = await checkExecutionRelease(call.skillId, call.skillVersion, device, call.openclawVersion);
        if (await stopIfNotRunning()) return;
        if (!releaseCheck.ok) {
          await completeRunningTask("failed", {
            error: { code: releaseCheck.code, message: releaseCheck.message, retryable: releaseCheck.retryable ?? false },
          });
          await releaseReservation();
          return;
        }
      }

      // Runtime Agent context is caller-controlled metadata. Re-resolve the
      // server-owned Agent-Skill binding at the last local execution point,
      // after admission but before issuing an Executor credential. A revoke
      // racing task creation therefore fails closed without crossing the
      // private Executor boundary.
      if (!allowDevelopmentTasks && call.strict) {
        let binding;
        try {
          binding = await store.resolveCloudAgentSkillBinding({
            tenant_id: device.tenant_id,
            device_id: device.device_id,
            ...(device.user_id === undefined ? {} : { user_id: device.user_id }),
            agent_id: call.agentId,
            skill_id: call.skillId,
          });
        } catch {
          if (await stopIfNotRunning()) return;
          await completeRunningTask("failed", {
            error: {
              code: "AGENT_SKILL_BINDING_UNAVAILABLE",
              message: "Agent-Skill 绑定服务暂时不可用",
              retryable: true,
            },
          }).catch(() => undefined);
          await releaseReservation();
          return;
        }
        if (await stopIfNotRunning()) return;
        if (!binding) {
          await completeRunningTask("failed", {
            error: {
              code: "AGENT_SKILL_BINDING_REQUIRED",
              message: "当前 Agent 未绑定该云端 Skill",
              retryable: false,
            },
          }).catch(() => undefined);
          await releaseReservation();
          return;
        }
      }

      if (await stopIfNotRunning()) return;
      const inputDigest = computeExecutorInputDigest(call.input);
      const executionController = controller;
      if (!executionController || executionController.signal.aborted) {
        await releaseReservation();
        return;
      }
      const credential = issueExecutorCredential(
        { taskId, tenantId: device.tenant_id, skillId: call.skillId, idempotencyKey: call.idempotencyKey, input: call.input },
        { key: executorCredentialKey, ttlMs: executorCredentialTtlMs },
      );
      const body = {
        schema_version: EXECUTOR_REQUEST_SCHEMA,
        task_id: taskId,
        tenant_id: device.tenant_id,
        skill_id: call.skillId,
        idempotency_key: call.idempotencyKey,
        input_digest: inputDigest,
        input: call.input,
      };
      const timeout = setTimeout(() => executionController.abort(), executorRequestTimeoutMs);
      let response: Response;
      let raw: string;
      try {
        response = await fetch(`${options.executorUrl}/execute`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [EXECUTOR_CREDENTIAL_HEADER]: credential,
            "idempotency-key": call.idempotencyKey,
          },
          body: JSON.stringify(body),
          signal: executionController.signal,
        });
        try {
          // Keep the same deadline active until the complete response body has
          // been consumed. A responsive upstream can still hold the socket
          // open forever after sending headers.
          raw = await readBoundedExecutorResponse(response, executorResponseMaxBytes);
        } catch (error) {
          if (isAbortError(error) || executionController.signal.aborted) throw error;
          await completeRunningTask("failed", {
            error: { code: "EXECUTOR_INVALID_RESPONSE", message: "执行器响应无效", retryable: true },
          });
          await releaseReservation();
          return;
        }
      } finally {
        clearTimeout(timeout);
      }

      let responseBody: { output?: unknown; code?: string; message?: string; retryable?: boolean } = {};
      try {
        const decoded = JSON.parse(raw) as unknown;
        if (!isPlainRecord(decoded)) throw new Error("response must be object");
        responseBody = decoded as typeof responseBody;
      } catch {
        await completeRunningTask("failed", {
          error: { code: "EXECUTOR_INVALID_RESPONSE", message: "执行器响应无效", retryable: true },
        });
        await releaseReservation();
        return;
      }

      const task = await store.getTask(taskId);
      if (task?.status === "cancelled") {
        await releaseReservation();
        return;
      }
      if (!response.ok) {
        await completeRunningTask("failed", {
          error: {
            code: typeof responseBody.code === "string" ? responseBody.code : "EXECUTOR_ERROR",
            message: "云端 Skill 执行失败",
            retryable: responseBody.retryable === true,
          },
        });
        await releaseReservation();
        return;
      }
      validateJsonValue(responseBody.output);
      await completeRunningTask("succeeded", { output: responseBody.output });
      await releaseReservation();
    } catch (error) {
      const timedOut = isAbortError(error);
      await completeRunningTask(timedOut ? "timed_out" : "failed", {
        error: {
          code: timedOut ? "EXECUTION_TIMEOUT" : "EXECUTOR_UNREACHABLE",
          message: timedOut ? "云端 Skill 执行超时" : "执行器请求失败",
          retryable: true,
        },
      }).catch(() => undefined);
      await releaseReservation();
    } finally {
      activeTaskControllers.delete(taskId);
    }
  }

  const adminCtx: AdminRouteContext = { store, adminToken, logger, legacySurfaceEnabled };
  const featurePolicyCtx: FeaturePolicyRouteContext = {
    store,
    admin: adminCtx,
    legacySurfaceEnabled,
    // The clean-launch Manager is free and therefore only needs a registered
    // device for policy refresh. Preserve the activation gate for legacy
    // protocol fixtures while the compatibility flag is enabled.
    authenticateDevice: legacySurfaceEnabled ? authenticate : authenticateRegistered,
  };
  const accountCtx = { store, logger, legacySurfaceEnabled, allowMockPayment };
  const clientReleaseCtx: ClientReleaseContext = {
    admin: adminCtx,
    releaseDir: options.clientReleaseDir ?? process.env.CLIENT_RELEASE_DIR ?? "./client-releases",
    signingKey: updateSigningKey,
    trustedPublicKeys: updateTrustedPublicKeys,
  };
  const cloudPluginReleaseCtx: CloudArtifactReleaseContext = {
    admin: adminCtx,
    releaseDir: options.cloudPluginReleaseDir ?? process.env.CLOUD_PLUGIN_RELEASE_DIR ?? "./cloud-plugin-releases",
    signingKey: cloudPluginSigningKey,
    surface: "cloud-plugin",
  };
  const cloudCliReleaseCtx: CloudArtifactReleaseContext = {
    admin: adminCtx,
    releaseDir: options.cloudCliReleaseDir ?? process.env.CLOUD_CLI_RELEASE_DIR ?? "./cloud-cli-releases",
    signingKey: cloudCliSigningKey,
    surface: "cloud-cli",
  };

  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      observeHttpRoute(store, logger, req, res, url.pathname);

      // CORS is wildcard-only for local development. Production callers must
      // provide an explicit origin allowlist (or use same-origin/no CORS).
      const requestOrigin = req.headers.origin;
      if (requestOrigin !== undefined) {
        const originAllowed = allowWildcardCors || corsAllowedOrigins?.includes(requestOrigin) === true;
        if (!originAllowed) {
          sendError(res, 403, "ORIGIN_NOT_ALLOWED", "请求来源未被允许");
          return;
        }
        res.setHeader("access-control-allow-origin", allowWildcardCors ? "*" : requestOrigin);
        if (!allowWildcardCors) res.setHeader("vary", "Origin");
      }
      res.setHeader(
        "access-control-allow-headers",
        [
          "authorization",
          "content-type",
          "idempotency-key",
          "last-event-id",
          "if-none-match",
          "x-longhub-agent-id",
          "x-longhub-manager-version",
          "x-longhub-openclaw-version",
        ].join(", "),
      );
      res.setHeader("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/health") {
        sendJson(res, 200, { status: "ok" });
        return;
      }

      if (!legacySurfaceEnabled && isLegacyServerPath(url, parts)) {
        sendLegacySurfaceDisabled(res);
        return;
      }

      if (await handleAccountRoutes(accountCtx, req, res, url, parts)) return;
      if (await handleClientReleaseRoutes(clientReleaseCtx, req, res, url)) return;
      if (await handleCloudArtifactReleaseRoutes(cloudPluginReleaseCtx, req, res, url)) return;
      if (await handleCloudArtifactReleaseRoutes(cloudCliReleaseCtx, req, res, url)) return;

      // Manager possession proof: a registered device bearer can mint one
      // short-lived code for the user to enter in the Portal. The clear code
      // is returned once, never logged or persisted by the Cloud store.
      if (req.method === "POST" && url.pathname === "/v1/devices/pairing/challenge") {
        const device = await authenticateRegistered(req, res);
        if (!device) return;
        if (!requireJsonContentType(req, res)) return;
        try {
          // Keep the request contract deliberately empty. This prevents a
          // caller from selecting another device, tenant, TTL or code.
          const raw = await readBoundedBody(req, 2 * 1024);
          const parsed = JSON.parse(raw) as unknown;
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) ||
            Object.keys(parsed as Record<string, unknown>).length !== 0) {
            sendError(res, 422, "INVALID_PAIRING_REQUEST", "配对请求必须为空对象");
            return;
          }
        } catch (error) {
          if (error instanceof RequestBodyError) {
            sendError(res, error.status, error.code, error.message, error.retryable);
          } else {
            sendError(res, 400, "INVALID_JSON", "请求体不是合法 JSON");
          }
          return;
        }
        if (device.user_id !== undefined) {
          sendError(res, 409, "DEVICE_ALREADY_BOUND", "设备已绑定账号");
          return;
        }
        const code = newPairingCode();
        const now = new Date();
        const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS).toISOString();
        const challenge = await store.createDevicePairingChallenge({
          challenge_id: `dpc-${randomUUID()}`,
          device_id: device.device_id,
          code_hash: hashPairingCode(code),
          expires_at: expiresAt,
          now: now.toISOString(),
        });
        if (!challenge) {
          sendError(res, 409, "DEVICE_ALREADY_BOUND", "设备已绑定账号或暂时无法配对");
          return;
        }
        res.setHeader("cache-control", "no-store");
        res.setHeader("pragma", "no-cache");
        logger.info("device.pairing_challenge.created", {
          device_id: device.device_id,
          expires_at: challenge.expires_at,
        });
        sendJson(res, 201, {
          challenge_id: challenge.challenge_id,
          device_id: challenge.device_id,
          expires_at: challenge.expires_at,
          pairing_code: code,
        });
        return;
      }

      // Standalone Cloud Plugin device lifecycle. The bearer proves device
      // possession; the response never includes the bearer itself.
      if (req.method === "GET" && url.pathname === "/v1/devices/self") {
        const device = await authenticateRegistered(req, res);
        if (!device) return;
        sendJson(res, 200, {
          device_id: device.device_id,
          status: device.status,
          platform: device.platform,
          app_version: device.app_version,
          display_name: device.display_name,
          bound: device.user_id !== undefined,
          last_seen_at: device.last_seen_at,
          created_at: device.created_at,
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/devices/self/revoke") {
        const device = await authenticateRegistered(req, res);
        if (!device) return;
        if (!requireJsonContentType(req, res)) return;
        try {
          const raw = await readBoundedBody(req, 2 * 1024);
          const parsed = JSON.parse(raw) as unknown;
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed as Record<string, unknown>).length !== 0) {
            sendError(res, 422, "INVALID_DEVICE_REQUEST", "请求必须为空对象");
            return;
          }
        } catch (error) {
          sendError(res, error instanceof RequestBodyError ? error.status : 400, error instanceof RequestBodyError ? error.code : "INVALID_JSON", "请求格式无效");
          return;
        }
        const revoked = await store.updateDeviceOperations(device.device_id, { status: "revoked" });
        if (!revoked) { sendError(res, 404, "DEVICE_NOT_FOUND", "设备不存在"); return; }
        await store.appendAudit(`device:${device.device_id}`, "device.revoked", { platform: device.platform, reason: "cloud_cli_logout" });
        sendJson(res, 200, { device_id: device.device_id, status: "revoked" });
        return;
      }

      // 设备注册后只能访问激活接口；核销成功前不能获取模型配置或调用其他产品 API。
      if (url.pathname === "/v1/devices/activation" && req.method === "GET") {
        const device = await authenticateRegistered(req, res);
        if (!device) return;
        sendJson(res, 200, await deviceActivationStatus(store, device));
        return;
      }
      if (url.pathname === "/v1/devices/activate" && req.method === "POST") {
        const device = await authenticateRegistered(req, res);
        if (!device) return;
        if (!requireJsonContentType(req, res)) return;
        const now = Date.now();
        const attempt = activationAttempts.get(device.device_id);
        if (attempt && attempt.resetsAt > now && attempt.count >= 5) {
          sendError(res, 429, "ACTIVATION_RATE_LIMITED", "尝试次数过多，请十分钟后重试", true);
          return;
        }
        if (!attempt || attempt.resetsAt <= now) {
          activationAttempts.set(device.device_id, { count: 1, resetsAt: now + 10 * 60_000 });
        } else {
          attempt.count += 1;
        }
        let parsed: { code?: string };
        try {
          const raw = await readBody(req);
          if (Buffer.byteLength(raw, "utf8") > 1_024) throw new Error("too large");
          parsed = JSON.parse(raw) as { code?: string };
        } catch {
          sendError(res, 400, "INVALID_ACTIVATION_REQUEST", "激活请求无效");
          return;
        }
        const codeHash = typeof parsed.code === "string" && parsed.code.length <= 64
          ? hashActivationCode(parsed.code)
          : undefined;
        if (!codeHash) {
          sendError(res, 403, "ACTIVATION_CODE_INVALID", "授权码无效、已过期或已达到使用次数");
          return;
        }
        const redeemed = await store.redeemActivationCode({
          device_id: device.device_id,
          code_hash: codeHash,
          now: new Date(now).toISOString(),
        });
        if (!redeemed.ok) {
          sendError(res, 403, "ACTIVATION_CODE_INVALID", "授权码无效、已过期或已达到使用次数");
          return;
        }
        activationAttempts.delete(device.device_id);
        await store.appendAudit(`device:${device.device_id}`, "device.activate", {
          activation_code_id: redeemed.code.activation_code_id,
          already_activated: redeemed.alreadyActivated,
        });
        sendJson(res, 200, {
          device_id: device.device_id,
          activated: true,
          activation_code: publicActivationCode(redeemed.code),
        });
        return;
      }

      if (await handleModelGatewayRoutes({
        store,
        admin: adminCtx,
        logger,
        encryptionKey: options.modelEncryptionKey,
        allowInsecureUpstream: options.allowInsecureModelUpstream,
        proxyTimeoutMs: options.modelProxyTimeoutMs,
        resolveUpstreamHostname: options.resolveModelUpstreamHostname,
        authenticateDevice: authenticate,
      }, req, res, url)) return;
      if (await handleFeaturePolicyRoutes(featurePolicyCtx, req, res, url)) return;
      if (await handleAdminRoutes(adminCtx, req, res, url, parts)) return;

      // 严格匿名遥测：Bearer 仅用于鉴权和进程内限流，身份不进入请求对象的聚合存储。
      if (req.method === "POST" && url.pathname === "/v1/client/telemetry") {
        // Clean launch telemetry is a free Manager capability: registration
        // is the identity boundary, while activation codes belong solely to
        // the retired Pack product line. Keep the old check only behind the
        // explicit compatibility flag for historical fixtures.
        const device = await (legacySurfaceEnabled ? authenticate : authenticateRegistered)(req, res);
        if (!device) return;
        const now = Date.now();
        if (telemetryAttempts.size > 10_000) {
          for (const [deviceId, attempt] of telemetryAttempts) {
            if (attempt.resetsAt <= now) telemetryAttempts.delete(deviceId);
          }
        }
        const attempt = telemetryAttempts.get(device.device_id);
        if (attempt && attempt.resetsAt > now && attempt.count >= 120) {
          sendError(res, 429, "TELEMETRY_RATE_LIMITED", "匿名指标上报过于频繁", true);
          return;
        }
        if (!attempt || attempt.resetsAt <= now) {
          if (!attempt && telemetryAttempts.size >= 10_000) {
            sendError(res, 429, "TELEMETRY_RATE_LIMITED", "匿名指标上报暂时繁忙", true);
            return;
          }
          telemetryAttempts.set(device.device_id, { count: 1, resetsAt: now + 60 * 60_000 });
        } else {
          attempt.count += 1;
        }
        let batch;
        try {
          const raw = await readBoundedBody(req, CLIENT_TELEMETRY_MAX_BYTES);
          batch = parseClientTelemetryBatch(JSON.parse(raw), new Date(now));
        } catch (error) {
          if ((error as { code?: unknown }).code === "BODY_TOO_LARGE") {
            sendError(res, 413, "TELEMETRY_TOO_LARGE", "匿名指标批次超过大小限制");
          } else if (error instanceof ClientTelemetryValidationError) {
            sendError(res, 422, "INVALID_TELEMETRY", "匿名指标不符合固定契约");
          } else {
            sendError(res, 400, "INVALID_JSON", "请求体不是合法 JSON");
          }
          return;
        }
        await store.incrementClientTelemetry(batch.events.map(telemetryAggregate));
        sendJson(res, 202, { accepted: batch.events.length });
        return;
      }

      // POST /v1/devices/register（无需设备凭据）
      if (req.method === "POST" && url.pathname === "/v1/devices/register") {
        if (!requireJsonContentType(req, res)) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(await readBody(req, { maxBytes: DEFAULT_REQUEST_BODY_MAX_BYTES }));
        } catch (error) {
          if (error instanceof RequestBodyError) {
            sendError(res, error.status, error.code, error.message, error.retryable);
            return;
          }
          sendError(res, 400, "INVALID_JSON", "请求体不是合法 JSON");
          return;
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          sendError(res, 422, "INVALID_DEVICE", "设备注册请求必须为 JSON 对象");
          return;
        }
        const registration = parsed as Record<string, unknown>;
        const allowedFields = new Set(["platform", "app_version", "device_fingerprint", "display_name"]);
        if (Object.keys(registration).some((key) => !allowedFields.has(key))) {
          // Tenant ownership is assigned by Cloud after account pairing; a
          // first-run Manager cannot select or impersonate a tenant.
          sendError(res, 422, "INVALID_DEVICE", "设备注册请求包含未知字段");
          return;
        }
        const platform = registration.platform;
        const appVersion = registration.app_version;
        const fingerprint = registration.device_fingerprint;
        const displayName = registration.display_name;
        let validAppVersion = false;
        if (typeof appVersion === "string") {
          try {
            compareSemver(appVersion, appVersion);
            validAppVersion = true;
          } catch {
            validAppVersion = false;
          }
        }
        if (
		  (platform !== "windows" && platform !== "openclaw-plugin-windows") ||
          typeof appVersion !== "string" ||
          appVersion.length === 0 || appVersion.length > 64 || !validAppVersion ||
          typeof fingerprint !== "string" ||
          fingerprint.length === 0 || fingerprint.length > 256 ||
          fingerprint.trim() !== fingerprint || /[\u0000-\u001f\u007f]/.test(fingerprint) ||
          (displayName !== undefined &&
            (typeof displayName !== "string" || displayName.length > 128 ||
              displayName.trim() !== displayName || /[\u0000-\u001f\u007f]/.test(displayName)))
        ) {
          sendError(res, 422, "INVALID_DEVICE", "platform 必须为 windows 或 openclaw-plugin-windows，app_version 和 device_fingerprint 必填");
          return;
        }
        let registrationResult: Awaited<ReturnType<CloudStore["registerDevice"]>>;
        try {
          registrationResult = await store.registerDevice({
            tenant_id: "tenant-default",
            platform,
            app_version: appVersion,
            device_fingerprint: fingerprint,
            display_name: displayName,
          });
        } catch (error) {
          // PostgreSQL's partial unique index can win a concurrent duplicate
          // registration between SELECT and INSERT.  Do not retry by reading
          // and returning the existing bearer; force the caller through the
          // possession-proof pairing flow instead.
          if ((error as { code?: unknown }).code === "23505") {
            sendError(res, 409, "DEVICE_ALREADY_REGISTERED", "设备已注册，请使用已保存的设备凭据");
          } else {
            sendError(res, 503, "DEVICE_REGISTRATION_UNAVAILABLE", "设备注册服务暂时不可用", true);
          }
          return;
        }
        const { device, existed } = registrationResult;
        if (existed) {
          // A fingerprint is not proof of device possession.  Never echo the
          // existing bearer (or the full DeviceRecord) to an unauthenticated
          // caller; recovery/pairing must use a separate one-time flow.
          sendError(res, 409, "DEVICE_ALREADY_REGISTERED", "设备已注册，请使用已保存的设备凭据");
          return;
        }
        logger.info("device.registered", { device_id: device.device_id, tenant_id: device.tenant_id });
        sendJson(res, 201, device);
        return;
      }

      // GET /v1/packs/signing-key（公开：发布公钥供客户端钉住信任）
      if (req.method === "GET" && url.pathname === "/v1/packs/signing-key") {
        sendJson(res, 200, { key_id: signingKey.keyId, public_key_pem: signingKey.publicKeyPem });
        return;
      }

      // GET /v1/skills/signing-key（公开：Skill 引用使用独立信任根）
      if (req.method === "GET" && url.pathname === "/v1/skills/signing-key") {
        sendJson(res, 200, { key_id: skillSigningKey.keyId, public_key_pem: skillSigningKey.publicKeyPem });
        return;
      }

      // Adapter releases use the same dedicated Skill trust domain as the
      // legacy Skill reference key, but expose an explicit alias so Manager
      // clients never confuse it with Pack or client-update signing keys.
      if (req.method === "GET" && url.pathname === "/v1/skills/adapters/signing-key") {
        sendJson(res, 200, { key_id: skillSigningKey.keyId, public_key_pem: skillSigningKey.publicKeyPem });
        return;
      }

      // 管理面：套装上传→云端签名→发布 / 吊销（Console/Admin Web 使用管理凭据或管理员会话）
      if (parts[0] === "v1" && parts[1] === "admin" && parts[2] === "packs") {
        const identity = await requireAdmin(adminCtx, req, res, { write: true });
        if (!identity) return;
        if (req.method === "POST" && parts.length === 3) {
          if (!requireJsonContentType(req, res)) return;
          let parsed: { manifest?: PackManifest; files?: Record<string, string> };
          try {
            parsed = JSON.parse(await readBody(req));
          } catch (error) {
            if (error instanceof RequestBodyError) {
              sendError(res, error.status, error.code, error.message, error.retryable);
              return;
            }
            sendError(res, 400, "INVALID_JSON", "请求体不是合法 JSON");
            return;
          }
          if (!parsed.manifest || !parsed.files || typeof parsed.files !== "object") {
            sendError(res, 422, "INVALID_PACK", "manifest 和 files 必填");
            return;
          }
          // 云端先联合校验 Manifest/Profile，再对 Manifest + 全部文件重算摘要并签名。
          const candidateManifest: PackManifest = {
            ...parsed.manifest,
            integrity: { algorithm: "sha256", digest: "pending", signatureKeyId: signingKey.keyId },
          };
          const validated = validatePackContent(candidateManifest, parsed.files);
          if (!validated.ok) {
            sendError(
              res,
              422,
              "PACK_CONTENT_INVALID",
              validated.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
            );
            return;
          }
          const digest = computePackDigest(validated.manifest, parsed.files);
          const manifest: PackManifest = {
            ...validated.manifest,
            integrity: { ...validated.manifest.integrity, digest },
          };
          const pack: PackFile = {
            manifest,
            files: parsed.files,
            signature: signPackDigest(digest, signingKey.privateKeyPem),
          };
          const { release, existed } = await store.publishRelease({
            pack,
            digest,
            signature_key_id: signingKey.keyId,
          });
          if (existed) {
            sendError(res, 409, "VERSION_EXISTS", `${release.pack_id}@${release.version} 已发布，版本不可覆盖`);
            return;
          }
          logger.info("release.published", { pack_id: release.pack_id, version: release.version });
          await store.appendAudit(identity.actor, "release.publish", {
            pack_id: release.pack_id,
            version: release.version,
          });
          sendJson(res, 201, {
            pack_id: release.pack_id,
            version: release.version,
            status: release.status,
            digest: release.digest,
            signature_key_id: release.signature_key_id,
            created_at: release.created_at,
          });
          return;
        }
        if (req.method === "POST" && parts.length === 6 && parts[5] === "revoke") {
          const release = await store.revokeRelease(parts[3]!, parts[4]!);
          if (!release) {
            sendError(res, 404, "RELEASE_NOT_FOUND", `未知发布: ${parts[3]}@${parts[4]}`);
            return;
          }
          logger.info("release.revoked", { pack_id: release.pack_id, version: release.version });
          await store.appendAudit(identity.actor, "release.revoke", {
            pack_id: release.pack_id,
            version: release.version,
          });
          sendJson(res, 202, { pack_id: release.pack_id, version: release.version, status: release.status });
          return;
        }
      }

      // 管理面：严格校验官方 Skill 引用，由 Cloud 使用独立密钥签名后发布。
      if (parts[0] === "v1" && parts[1] === "admin" && parts[2] === "skills") {
        const identity = await requireAdmin(adminCtx, req, res, { write: true });
        if (!identity) return;
        if (req.method === "POST" && parts.length === 3) {
          if (!requireJsonContentType(req, res)) return;
          let parsed: { package?: unknown };
          try {
            parsed = JSON.parse(await readBody(req));
          } catch (error) {
            if (error instanceof RequestBodyError) {
              sendError(res, error.status, error.code, error.message, error.retryable);
              return;
            }
            sendError(res, 400, "INVALID_JSON", "请求体不是合法 JSON");
            return;
          }
          if (!parsed.package || typeof parsed.package !== "object" || Array.isArray(parsed.package)) {
            sendError(res, 422, "INVALID_SKILL_PACKAGE", "package 必填且必须为对象");
            return;
          }
          const candidate = {
            ...(parsed.package as Record<string, unknown>),
            integrity: {
              algorithm: "sha256",
              digest: "0".repeat(64),
              signatureKeyId: skillSigningKey.keyId,
              signature: "A".repeat(86) + "==",
            },
          };
          const validated = validateSkillPackage(candidate);
          if (!validated.ok) {
            sendError(
              res,
              422,
              "SKILL_PACKAGE_INVALID",
              validated.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
            );
            return;
          }
          const existing = await store.listSkillReleases(validated.manifest.skill.id);
          const ownerConflict = existing.some(
            (release) => release.publisher_namespace !== validated.manifest.skill.publisher.namespace,
          );
          if (ownerConflict) {
            sendError(res, 409, "SKILL_PUBLISHER_CONFLICT", "Skill ID 已由另一个发布方命名空间持有");
            return;
          }
          const digest = computeSkillPackageDigest(validated.manifest);
          const skillPackage: SkillPackage = {
            ...validated.manifest,
            integrity: {
              ...validated.manifest.integrity,
              digest,
              signature: signSkillPackageDigest(digest, skillSigningKey.privateKeyPem),
            },
          };
          const signed = validateSkillPackage(skillPackage);
          if (!signed.ok) {
            sendError(res, 500, "SKILL_SIGNING_FAILED", "签名后的 Skill 引用未通过内部校验");
            return;
          }
          const { release, existed } = await store.publishSkillRelease({
            package: signed.manifest,
            digest,
            signature_key_id: skillSigningKey.keyId,
          });
          if (existed) {
            sendError(res, 409, "SKILL_VERSION_EXISTS", `${release.skill_id}@${release.version} 已发布，版本不可覆盖`);
            return;
          }
          logger.info("skill_release.published", { skill_id: release.skill_id, version: release.version });
          await store.appendAudit(identity.actor, "skill_release.publish", {
            skill_id: release.skill_id,
            version: release.version,
            publisher_namespace: release.publisher_namespace,
          });
          sendJson(res, 201, {
            skill_id: release.skill_id,
            version: release.version,
            status: release.status,
            digest: release.digest,
            signature_key_id: release.signature_key_id,
            created_at: release.created_at,
          });
          return;
        }
        if (req.method === "POST" && parts.length === 6 && parts[5] === "revoke") {
          const release = await store.revokeSkillRelease(parts[3]!, parts[4]!);
          if (!release) {
            sendError(res, 404, "SKILL_RELEASE_NOT_FOUND", `未知 Skill 发布: ${parts[3]}@${parts[4]}`);
            return;
          }
          logger.info("skill_release.revoked", { skill_id: release.skill_id, version: release.version });
          await store.appendAudit(identity.actor, "skill_release.revoke", {
            skill_id: release.skill_id,
            version: release.version,
          });
          sendJson(res, 202, {
            skill_id: release.skill_id,
            version: release.version,
            status: release.status,
            digest: release.digest,
            signature_key_id: release.signature_key_id,
            created_at: release.created_at,
            revoked_at: release.revoked_at,
          });
          return;
        }
      }

      // 管理面：发布原生 OpenClaw 的签名薄适配器。该制品域独立于旧
      // SkillPackage；Cloud 只保存 manifest + 三个 Base64 纯内容文件。
      if (parts[0] === "v1" && parts[1] === "admin" && parts[2] === "cloud-skill-adapters") {
        const identity = await requireAdmin(adminCtx, req, res, { write: req.method !== "GET" });
        if (!identity) return;
        if (req.method === "GET" && parts.length === 3) {
          const skillId = url.searchParams.get("skill_id") ?? undefined;
          const releases = await store.listCloudSkillAdapterReleases(skillId);
          sendJson(res, 200, {
            releases: releases.map((release) => ({
              skill_id: release.skill_id,
              version: release.version,
              status: release.status,
              digest: release.digest,
              signature_key_id: release.signature_key_id,
              min_manager_version: release.min_manager_version,
              openclaw_version: release.openclaw_version,
              compatibility: release.manifest.compatibility,
              created_at: release.created_at,
              revoked_at: release.revoked_at,
            })),
          });
          return;
        }
        if (req.method === "POST" && parts.length === 3) {
          if (!requireJsonContentType(req, res)) return;
          let parsed: { manifest?: unknown; files?: unknown };
          try {
            parsed = JSON.parse(await readBoundedBody(req, CLOUD_SKILL_ADAPTER_RELEASE_MAX_BYTES)) as typeof parsed;
          } catch (error) {
            if (error instanceof RequestBodyError) {
              sendError(
                res,
                error.status,
                error.code === "BODY_TOO_LARGE" ? "REQUEST_TOO_LARGE" : error.code,
                error.code === "BODY_TOO_LARGE" ? "适配器制品超过大小限制" : error.message,
                error.retryable,
              );
            } else {
              sendError(res, 400, "INVALID_JSON", "请求体不是合法 JSON");
            }
            return;
          }
          let prepared;
          try {
            prepared = prepareCloudSkillAdapterRelease(parsed, skillSigningKey);
          } catch (error) {
            sendError(
              res,
              422,
              "CLOUD_SKILL_ADAPTER_RELEASE_INVALID",
              error instanceof Error ? error.message : "适配器制品无效",
            );
            return;
          }
          const { release, existed } = await store.publishCloudSkillAdapterRelease({
            manifest: prepared.manifest,
            files: prepared.files,
            digest: prepared.digest,
            signature_key_id: prepared.signature_key_id,
          });
          if (existed) {
            sendError(res, 409, "SKILL_VERSION_EXISTS", `${release.skill_id}@${release.version} 已发布，版本不可覆盖`);
            return;
          }
          logger.info("cloud_skill_adapter_release.published", {
            skill_id: release.skill_id,
            version: release.version,
          });
          await store.appendAudit(identity.actor, "cloud_skill_adapter_release.publish", {
            skill_id: release.skill_id,
            version: release.version,
            digest: release.digest,
          });
          sendJson(res, 201, {
            skill_id: release.skill_id,
            version: release.version,
            status: release.status,
            digest: release.digest,
            signature_key_id: release.signature_key_id,
            created_at: release.created_at,
          });
          return;
        }
        if (req.method === "POST" && parts.length === 6 && parts[5] === "revoke") {
          const release = await store.revokeCloudSkillAdapterRelease(parts[3]!, parts[4]!);
          if (!release) {
            sendError(res, 404, "SKILL_RELEASE_NOT_FOUND", `未知适配器发布: ${parts[3]}@${parts[4]}`);
            return;
          }
          logger.info("cloud_skill_adapter_release.revoked", {
            skill_id: release.skill_id,
            version: release.version,
          });
          await store.appendAudit(identity.actor, "cloud_skill_adapter_release.revoke", {
            skill_id: release.skill_id,
            version: release.version,
          });
          sendJson(res, 202, {
            skill_id: release.skill_id,
            version: release.version,
            status: release.status,
            digest: release.digest,
            signature_key_id: release.signature_key_id,
            revoked_at: release.revoked_at,
          });
          return;
        }
      }

      if (url.pathname === "/v1/admin/pack-reviews" && req.method === "GET") {
        if (!(await requireAdmin(adminCtx, req, res, { write: false }))) return;
        sendJson(res, 200, { reviews: (await store.listPackReviews()).map(({ pack, ...review }) => ({ ...review, pack_id: pack.manifest.pack.id, version: pack.manifest.pack.version })) }); return;
      }
      if (url.pathname === "/v1/admin/pack-reviews" && req.method === "POST") {
        const identity = await requireAdmin(adminCtx, req, res, { write: true }); if (!identity) return;
        const parsed = await readJson<{ publisher?: string; pack?: PackFile }>(req, res); if (!parsed) return;
        if (typeof parsed.publisher !== "string" || !/^[A-Za-z0-9 ._-]{1,128}$/.test(parsed.publisher) || !parsed.pack) { sendError(res, 422, "INVALID_PACK_REVIEW", "发布者和 Pack 必填"); return; }
        const findings = scanThirdPartyPack(parsed.pack);
        const storedPack = findings.length
          ? { manifest: parsed.pack.manifest, files: {}, signature: "rejected-content-not-retained" }
          : parsed.pack;
        const review = await store.createPackReview({ publisher: parsed.publisher, pack: storedPack, findings });
        await store.appendAudit(identity.actor, "pack_review.submit", { review_id: review.review_id, publisher: review.publisher, pack_id: review.pack.manifest.pack.id, findings });
        if (findings.length) {
          sendJson(res, 422, {
            code: "PACK_REVIEW_REJECTED",
            message: "Pack 未通过固定危险模式扫描",
            review_id: review.review_id,
            status: review.status,
            findings,
          });
        } else {
          sendJson(res, 201, { review_id: review.review_id, status: review.status, findings });
        }
        return;
      }
      if (req.method === "POST" && parts.length === 5 && parts[0] === "v1" && parts[1] === "admin" && parts[2] === "pack-reviews" && parts[4] === "approve") {
        const identity = await requireAdmin(adminCtx, req, res, { write: true }); if (!identity) return;
        const review = await store.getPackReview(parts[3]!);
        if (!review || review.status !== "submitted" || review.findings.length) { sendError(res, 409, "PACK_REVIEW_NOT_APPROVABLE", "审核记录不存在或不能批准"); return; }
        const candidate: PackManifest = { ...review.pack.manifest, integrity: { algorithm: "sha256", digest: "pending", signatureKeyId: signingKey.keyId } };
        const validated = validatePackContent(candidate, review.pack.files);
        if (!validated.ok) { sendError(res, 422, "PACK_CONTENT_INVALID", "Pack 内容校验失败"); return; }
        const digest = computePackDigest(validated.manifest, review.pack.files);
        const pack: PackFile = { manifest: { ...validated.manifest, integrity: { ...validated.manifest.integrity, digest } }, files: review.pack.files, signature: signPackDigest(digest, signingKey.privateKeyPem) };
        const published = await store.publishRelease({ pack, digest, signature_key_id: signingKey.keyId });
        if (published.existed) { sendError(res, 409, "VERSION_EXISTS", "版本已存在"); return; }
        await store.updatePackReview(review.review_id, { status: "published", findings: [] });
        await store.appendAudit(identity.actor, "pack_review.publish", { review_id: review.review_id, pack_id: pack.manifest.pack.id, version: pack.manifest.pack.version });
        sendJson(res, 201, { review_id: review.review_id, status: "published", pack_id: pack.manifest.pack.id, version: pack.manifest.pack.version }); return;
      }

      if (url.pathname === "/v1/admin/knowledge-documents" && req.method === "GET") {
        if (!(await requireAdmin(adminCtx, req, res, { write: false }))) return;
        const tenantId = url.searchParams.get("tenant_id") ?? "tenant-default";
        if (!/^[A-Za-z0-9._-]{1,128}$/.test(tenantId)) {
          sendError(res, 422, "INVALID_TENANT", "租户 ID 无效"); return;
        }
        const documents = (await store.listKnowledgeDocuments(tenantId)).map(({ content, ...metadata }) => ({
          ...metadata,
          bytes: Buffer.byteLength(decodeKnowledge(content, tenantId)),
        }));
        sendJson(res, 200, { documents }); return;
      }
      if (url.pathname === "/v1/admin/knowledge-documents" && req.method === "POST") {
        const identity = await requireAdmin(adminCtx, req, res, { write: true });
        if (!identity) return;
        const parsed = await readJson<{ tenant_id?: string; title?: string; source_label?: string; content?: string }>(req, res);
        if (!parsed) return;
        const tenantId = parsed.tenant_id ?? "tenant-default";
        if (!/^[A-Za-z0-9._-]{1,128}$/.test(tenantId) || typeof parsed.title !== "string" || parsed.title.length < 1 || parsed.title.length > 200 ||
          typeof parsed.source_label !== "string" || parsed.source_label.length < 1 || parsed.source_label.length > 200 ||
          typeof parsed.content !== "string" || parsed.content.length < 1 || Buffer.byteLength(parsed.content) > 1_048_576) {
          sendError(res, 422, "INVALID_KNOWLEDGE_DOCUMENT", "知识文档字段或大小无效"); return;
        }
        const document = await store.createKnowledgeDocument({
          tenant_id: tenantId,
          title: parsed.title,
          source_label: parsed.source_label,
          content: encodeKnowledge(parsed.content, tenantId),
        });
        await store.appendAudit(identity.actor, "knowledge.document.create", { document_id: document.document_id, tenant_id: tenantId, bytes: Buffer.byteLength(parsed.content) });
        sendJson(res, 201, { document: { ...document, content: undefined } }); return;
      }
      if (req.method === "DELETE" && parts.length === 4 && parts[0] === "v1" && parts[1] === "admin" && parts[2] === "knowledge-documents") {
        const identity = await requireAdmin(adminCtx, req, res, { write: true });
        if (!identity) return;
        const deleted = await store.deleteKnowledgeDocument(parts[3]!);
        if (!deleted) { sendError(res, 404, "KNOWLEDGE_DOCUMENT_NOT_FOUND", "知识文档不存在"); return; }
        await store.appendAudit(identity.actor, "knowledge.document.delete", { document_id: deleted.document_id, tenant_id: deleted.tenant_id });
        sendJson(res, 200, { deleted: true }); return;
      }

      if (url.pathname === "/v1/knowledge/query" && req.method === "POST") {
        const device = await authenticate(req, res);
        if (!device) return;
        if (!(await enforceDeviceFeaturePolicy(
          featurePolicyCtx,
          device,
          res,
          "knowledge.tenant",
          { allowWhenMissing: true },
        ))) return;
        const parsed = await readJson<{ query?: string; limit?: number }>(req, res);
        if (!parsed) return;
        const query = parsed.query?.trim() ?? "";
        const limit = parsed.limit ?? 5;
        if (query.length < 2 || query.length > 500 || !Number.isInteger(limit) || limit < 1 || limit > 10) {
          sendError(res, 422, "INVALID_KNOWLEDGE_QUERY", "查询或数量无效"); return;
        }
        const terms = [...new Set(query.toLocaleLowerCase("zh-CN").split(/\s+/).filter((term) => term.length >= 2))];
        const citations = (await store.listKnowledgeDocuments(device.tenant_id)).map((document) => {
          const content = decodeKnowledge(document.content, device.tenant_id);
          const lower = content.toLocaleLowerCase("zh-CN");
          const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
          const first = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
          const start = Math.max(0, first - 80);
          return { document_id: document.document_id, title: document.title, source_label: document.source_label, snippet: content.slice(start, start + 320), score };
        }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.document_id.localeCompare(b.document_id)).slice(0, limit);
        sendJson(res, 200, { citations }); return;
      }

      // GET /v1/catalog/skills（设备视角：仅返回策略允许、未撤销且兼容的官方引用）
      // Cloud Skill catalog is part of the free Manager + account flow. It
      // must not inherit the legacy activation-code gate used by Pack
      // distribution; subscription/entitlement is resolved separately below.
      if (req.method === "GET" && url.pathname === "/v1/catalog/skills") {
        const device = await authenticateRegistered(req, res);
        if (!device) return;
        if (!(await enforceDeviceFeaturePolicy(
          featurePolicyCtx,
          device,
          res,
          "skill.catalog",
          { allowWhenMissing: true },
        ))) return;
        const openclawVersion = url.searchParams.get("openclaw_version") ?? undefined;
        const query = (url.searchParams.get("q") ?? "").trim().toLocaleLowerCase("zh-CN");
        const category = (url.searchParams.get("category") ?? "").trim().toLocaleLowerCase("zh-CN");
        const compatible = legacySurfaceEnabled
          ? (await store.listSkillReleases()).filter(
              (release) => release.status === "active" && isSkillCompatible(release, device.app_version, openclawVersion),
            )
          : [];
        const adapterCompatible = (await store.listCloudSkillAdapterReleases()).filter(
          (release) => release.status === "active" &&
            isCloudSkillAdapterCompatible(release, device.app_version, openclawVersion),
        );
        const grouped = new Map<string, SkillReleaseRecord[]>();
        for (const release of compatible) {
          grouped.set(release.skill_id, [...(grouped.get(release.skill_id) ?? []), release]);
        }
        const skills = [] as Record<string, unknown>[];
        for (const releases of [...grouped.values()]) {
          const access = await resolveSkillAccess(device, releases[0]!.skill_id);
          const summary = toSkillSummary(releases, access.entitled, access.cloudPlanIds);
          const adapters = adapterCompatible.filter((release) => release.skill_id === releases[0]!.skill_id);
          if (adapters.length > 0) {
            summary.adapter_available = true;
            summary.adapter_latest_version = adapters.at(-1)!.version;
            summary.adapter_versions = adapters.map((release) => release.version);
          }
          skills.push(summary);
        }
        const adapterOnly = new Map<string, CloudSkillAdapterReleaseRecord[]>();
        for (const release of adapterCompatible) {
          if (!grouped.has(release.skill_id)) {
            adapterOnly.set(release.skill_id, [...(adapterOnly.get(release.skill_id) ?? []), release]);
          }
        }
        for (const releases of adapterOnly.values()) {
          const access = await resolveSkillAccess(device, releases[0]!.skill_id);
          skills.push(toCloudSkillAdapterSummary(releases, access.entitled, access.cloudPlanIds));
        }
        const filteredSkills = skills
          .filter((summary) => {
            const display = summary.display as SkillPackage["skill"]["display"];
            return (!query || `${String(summary.skill_id)} ${display.name} ${display.description}`.toLocaleLowerCase("zh-CN").includes(query)) &&
              (!category || display.category.toLocaleLowerCase("zh-CN") === category);
          });
        sendJson(res, 200, {
          skills: filteredSkills,
          filters: {
            q: query || undefined,
            category: category || undefined,
            manager_version: device.app_version,
            openclaw_version: openclawVersion,
          },
        });
        return;
      }

      // GET /v1/catalog/skills/{skillId}（只暴露当前设备可用的详情，不下发签名引用）
      if (req.method === "GET" && parts.length === 4 && parts[0] === "v1" && parts[1] === "catalog" && parts[2] === "skills") {
        const device = await authenticateRegistered(req, res);
        if (!device) return;
        if (!(await enforceDeviceFeaturePolicy(
          featurePolicyCtx,
          device,
          res,
          "skill.catalog",
          { allowWhenMissing: true },
        ))) return;
        const skillId = parts[3]!;
        const openclawVersion = url.searchParams.get("openclaw_version") ?? undefined;
        const releases = legacySurfaceEnabled
          ? (await store.listSkillReleases(skillId)).filter(
              (release) => release.status === "active" && isSkillCompatible(release, device.app_version, openclawVersion),
            )
          : [];
        const adapterReleases = (await store.listCloudSkillAdapterReleases(skillId)).filter(
          (release) => release.status === "active" && isCloudSkillAdapterCompatible(release, device.app_version, openclawVersion),
        );
        if (releases.length === 0 && adapterReleases.length === 0) {
          sendError(res, 404, "SKILL_NOT_FOUND", `没有可用且兼容的 Skill: ${skillId}`);
          return;
        }
        const access = await resolveSkillAccess(device, skillId);
        if (releases.length === 0) {
          sendJson(res, 200, { skill: toCloudSkillAdapterSummary(adapterReleases, access.entitled, access.cloudPlanIds) });
          return;
        }
        const summary = toSkillSummary(releases, access.entitled, access.cloudPlanIds);
        if (adapterReleases.length > 0) {
          summary.adapter_available = true;
          summary.adapter_latest_version = adapterReleases.at(-1)!.version;
          summary.adapter_versions = adapterReleases.map((release) => release.version);
        }
        sendJson(res, 200, { skill: summary });
        return;
      }

      // GET /v1/skills/{skillId}/adapter?version=&openclaw_version=
      // Native Manager distribution uses the registered-device + account /
      // Cloud subscription path. Legacy activation-code authorization is
      // intentionally not consulted here.
      if (req.method === "GET" && parts.length === 4 && parts[0] === "v1" && parts[1] === "skills" && parts[3] === "adapter") {
        const device = await authenticateRegistered(req, res);
        if (!device) return;
        if (!(await enforceDeviceFeaturePolicy(
          featurePolicyCtx,
          device,
          res,
          "skill.catalog",
          { allowWhenMissing: true },
        ))) return;
        const skillId = parts[2]!;
        let access: Awaited<ReturnType<typeof resolveSkillAccess>>;
        try {
          access = await resolveSkillAccess(device, skillId);
        } catch {
          logger.error("cloud_skill_adapter_release.access_failed", {
            skill_id: skillId,
            device_id: device.device_id,
          });
          sendError(res, 503, "SKILL_DISTRIBUTION_UNAVAILABLE", "适配器分发服务暂时不可用", true);
          return;
        }
        if (!access.cloud || !access.entitled) {
          sendError(res, 403, "CLOUD_SKILL_SUBSCRIPTION_REQUIRED", "云端 Skill 订阅无效或已到期");
          return;
        }
        const openclawVersion = url.searchParams.get("openclaw_version");
        if (!openclawVersion) {
          sendError(res, 422, "OPENCLAW_VERSION_REQUIRED", "openclaw_version 必填");
          return;
        }
        const requestedVersion = url.searchParams.get("version");
        let releases: CloudSkillAdapterReleaseRecord[];
        try {
          releases = await store.listCloudSkillAdapterReleases(skillId);
        } catch {
          logger.error("cloud_skill_adapter_release.list_failed", {
            skill_id: skillId,
            device_id: device.device_id,
          });
          sendError(res, 503, "SKILL_DISTRIBUTION_UNAVAILABLE", "适配器分发服务暂时不可用", true);
          return;
        }
        const compatible = releases.filter((release) =>
          release.status === "active" && isCloudSkillAdapterCompatible(release, device.app_version, openclawVersion),
        );
        let release = requestedVersion === null
          ? compatible.at(-1)
          : releases.find((item) => item.version === requestedVersion);
        if (!release) {
          sendError(res, 404, "SKILL_NOT_FOUND", "没有可用且兼容的 Cloud Skill 适配器");
          return;
        }
        if (release.status === "revoked") {
          sendError(res, 410, "SKILL_RELEASE_REVOKED", `${skillId}@${release.version} 已撤销`);
          return;
        }
        if (!verifyStoredCloudSkillAdapterRelease(release, skillSigningKey)) {
          logger.error("cloud_skill_adapter_release.integrity_failed", {
            skill_id: release.skill_id,
            version: release.version,
            device_id: device.device_id,
          });
          sendError(res, 503, "SKILL_DISTRIBUTION_UNAVAILABLE", "适配器分发服务暂时不可用", true);
          return;
        }
        if (!isCloudSkillAdapterCompatible(release, device.app_version, openclawVersion)) {
          sendError(res, 422, "SKILL_INCOMPATIBLE", "当前 Manager 或 OpenClaw 版本与适配器不兼容");
          return;
        }
        const body = adapterDownloadBody(release);
        const encoded = Buffer.from(JSON.stringify(body), "utf8");
        if (encoded.byteLength > CLOUD_SKILL_ADAPTER_RELEASE_MAX_BYTES) {
          sendError(res, 413, "RESPONSE_TOO_LARGE", "适配器制品超过分发大小限制");
          return;
        }
        logger.info("cloud_skill_adapter_release.distributed", {
          skill_id: release.skill_id,
          version: release.version,
          device_id: device.device_id,
        });
        res.setHeader("cache-control", "no-store");
        sendJson(res, 200, body);
        return;
      }

      // GET /v1/skills/{skillId}/reference?version=&openclaw_version=（验策略、兼容与授权）
      if (req.method === "GET" && parts.length === 4 && parts[0] === "v1" && parts[1] === "skills" && parts[3] === "reference") {
        const device = await authenticateRegistered(req, res);
        if (!device) return;
        if (!(await enforceDeviceFeaturePolicy(
          featurePolicyCtx,
          device,
          res,
          "skill.catalog",
          { allowWhenMissing: false },
        ))) return;
        const skillId = parts[2]!;
        const access = await resolveSkillAccess(device, skillId);
        if (!access.entitled) {
          sendError(res, 403, "NOT_ENTITLED", `设备未获得 ${skillId} 的授权`);
          return;
        }
        const openclawVersion = url.searchParams.get("openclaw_version");
        if (!openclawVersion) {
          sendError(res, 422, "OPENCLAW_VERSION_REQUIRED", "openclaw_version 必填");
          return;
        }
        const version = url.searchParams.get("version");
        const releases = await store.listSkillReleases(skillId);
        const release = version === null
          ? releases.filter((item) => item.status === "active").at(-1)
          : releases.find((item) => item.version === version);
        if (!release) {
          sendError(res, 404, "SKILL_RELEASE_NOT_FOUND", `未知 Skill 或版本: ${skillId}`);
          return;
        }
        if (release.status === "revoked") {
          sendError(res, 410, "SKILL_RELEASE_REVOKED", `${skillId}@${release.version} 已撤销`);
          return;
        }
        if (!isSkillCompatible(release, device.app_version, openclawVersion)) {
          sendError(res, 426, "SKILL_INCOMPATIBLE", "当前 Desktop 或 OpenClaw 版本与 Skill 不兼容");
          return;
        }
        logger.info("skill_release.distributed", {
          skill_id: release.skill_id,
          version: release.version,
          device_id: device.device_id,
        });
        sendJson(res, 200, {
          package: release.package,
          digest: release.digest,
          signature_key_id: release.signature_key_id,
        });
        return;
      }

      // GET /v1/catalog/packs（设备视角：可见套装目录）
      if (req.method === "GET" && url.pathname === "/v1/catalog/packs") {
        const device = await authenticate(req, res);
        if (!device) return;
        if (!(await enforceDeviceFeaturePolicy(
          featurePolicyCtx,
          device,
          res,
          "agent.catalog",
          { allowWhenMissing: true },
        ))) return;
        const releases = (await store.listReleases()).filter((r) => r.status === "active");
        const byPack = new Map<string, PackReleaseRecord[]>();
        for (const r of releases) {
          byPack.set(r.pack_id, [...(byPack.get(r.pack_id) ?? []), r]);
        }
        const query = (url.searchParams.get("q") ?? "").trim().toLocaleLowerCase("zh-CN");
        const category = (url.searchParams.get("category") ?? "").trim().toLocaleLowerCase("en");
        const desktopVersion = url.searchParams.get("desktop_version");
        const packs = [...byPack.values()].map(toPackSummary).filter((pack) =>
          (!query || `${pack.pack_id} ${pack.name} ${pack.capabilities.map((item) => item.capability_id).join(" ")}`.toLocaleLowerCase("zh-CN").includes(query)) &&
          (!category || pack.categories.some((item) => item.toLocaleLowerCase("en") === category)) &&
          (!desktopVersion || !versionBelow(desktopVersion, pack.min_desktop_version))
        );
        sendJson(res, 200, { packs, filters: { q: query || undefined, category: category || undefined, desktop_version: desktopVersion ?? undefined } });
        return;
      }

      // GET /v1/packs/{packId}/download?version=（验设备凭据 + 授权）
      if (req.method === "GET" && parts[0] === "v1" && parts[1] === "packs" && parts[3] === "download") {
        const device = await authenticate(req, res);
        if (!device) return;
        const packId = parts[2]!;
        if (!isEntitled(await store.listEntitlements(device.device_id), packId)) {
          sendError(res, 403, "NOT_ENTITLED", `设备未获得 ${packId} 的授权`);
          return;
        }
        const version = url.searchParams.get("version");
        const releases = (await store.listReleases(packId)).filter((r) => version === null || r.version === version);
        const release = releases[releases.length - 1];
        if (!release) {
          sendError(res, 404, "RELEASE_NOT_FOUND", `未知套装或版本: ${packId}`);
          return;
        }
        if (release.status === "revoked") {
          sendError(res, 410, "RELEASE_REVOKED", `${packId}@${release.version} 已吊销`);
          return;
        }
        logger.info("release.downloaded", { pack_id: packId, version: release.version, device_id: device.device_id });
        sendJson(res, 200, {
          pack: release.pack,
          digest: release.digest,
          signature_key_id: release.signature_key_id,
        });
        return;
      }

      // POST /v1/releases/check（升级与吊销检查）
      if (req.method === "POST" && url.pathname === "/v1/releases/check") {
        if (!(await authenticate(req, res))) return;
        if (!requireJsonContentType(req, res)) return;
        let parsed: { desktop_version?: string; installed_packs?: { pack_id: string; version: string }[] };
        try {
          parsed = JSON.parse(await readBody(req));
        } catch (error) {
          if (error instanceof RequestBodyError) {
            sendError(res, error.status, error.code, error.message, error.retryable);
            return;
          }
          sendError(res, 400, "INVALID_JSON", "请求体不是合法 JSON");
          return;
        }
        if (typeof parsed.desktop_version !== "string" || !Array.isArray(parsed.installed_packs)) {
          sendError(res, 422, "INVALID_CHECK", "desktop_version 和 installed_packs 必填");
          return;
        }
        const packs: { pack_id: string; action: string; target_version?: string }[] = [];
        for (const installed of parsed.installed_packs) {
          const releases = await store.listReleases(installed.pack_id);
          const current = releases.find((r) => r.version === installed.version);
          const active = releases.filter((r) => r.status === "active");
          const latest = active[active.length - 1];
          if (!current) {
            packs.push({ pack_id: installed.pack_id, action: "update_required", target_version: latest?.version });
          } else if (current.status === "revoked") {
            packs.push({ pack_id: installed.pack_id, action: "revoked", target_version: latest?.version });
          } else if (latest && latest.version !== installed.version) {
            packs.push({ pack_id: installed.pack_id, action: "update_available", target_version: latest.version });
          } else {
            packs.push({ pack_id: installed.pack_id, action: "none" });
          }
        }
        sendJson(res, 200, { desktop: { action: "none" }, packs });
        return;
      }

      // 管理面：授予/撤销授权（Console/Admin Web 使用管理凭据或管理员会话）
      if (parts[0] === "v1" && parts[1] === "admin" && parts[2] === "entitlements") {
        const identity = await requireAdmin(adminCtx, req, res, { write: true });
        if (!identity) return;
        if (req.method === "POST" && parts.length === 3) {
          if (!requireJsonContentType(req, res)) return;
          let parsed: { device_id?: string; pack_id?: string; expires_at?: string };
          try {
            parsed = JSON.parse(await readBody(req));
          } catch (error) {
            if (error instanceof RequestBodyError) {
              sendError(res, error.status, error.code, error.message, error.retryable);
              return;
            }
            sendError(res, 400, "INVALID_JSON", "请求体不是合法 JSON");
            return;
          }
          if (typeof parsed.device_id !== "string" || typeof parsed.pack_id !== "string") {
            sendError(res, 422, "INVALID_ENTITLEMENT", "device_id 和 pack_id 必填");
            return;
          }
          const device = await store.getDevice(parsed.device_id);
          if (!device) {
            sendError(res, 404, "DEVICE_NOT_FOUND", `未知设备: ${parsed.device_id}`);
            return;
          }
          const record = await store.grantEntitlement({
            tenant_id: device.tenant_id,
            device_id: device.device_id,
            pack_id: parsed.pack_id,
            expires_at: parsed.expires_at,
          });
          logger.info("entitlement.granted", { entitlement_id: record.entitlement_id, pack_id: record.pack_id });
          await store.appendAudit(identity.actor, "entitlement.grant", {
            entitlement_id: record.entitlement_id,
            device_id: record.device_id,
            pack_id: record.pack_id,
          });
          sendJson(res, 201, record);
          return;
        }
        if (req.method === "POST" && parts.length === 5 && parts[4] === "revoke") {
          const record = await store.revokeEntitlement(parts[3]!);
          if (!record) {
            sendError(res, 404, "ENTITLEMENT_NOT_FOUND", `未知授权: ${parts[3]}`);
            return;
          }
          logger.info("entitlement.revoked", { entitlement_id: record.entitlement_id });
          await store.appendAudit(identity.actor, "entitlement.revoke", { entitlement_id: record.entitlement_id });
          sendJson(res, 202, record);
          return;
        }
      }

      // GET /v1/entitlements（设备视角）
      if (req.method === "GET" && url.pathname === "/v1/entitlements") {
        const device = await authenticate(req, res);
        if (!device) return;
        const entitlements = await store.listEntitlements(device.device_id);
        sendJson(res, 200, { entitlements });
        return;
      }

      // Cloud Skill Agent binding：设备只管理自己租户/设备上的 binding，
      // 不接受管理页面 Bearer，也不允许把另一设备的 binding 挪过来。
      if (parts[0] === "v1" && parts[1] === "cloud-skill" && parts[2] === "bindings") {
        // The Manager is free: Cloud Skill enrollment is authorized by the
        // registered device plus its active account, not the legacy Pack
        // activation-code product gate.
        const device = await authenticateRegistered(req, res);
        if (!device) return;
        if (req.method === "GET" && parts.length === 3) {
          const bindings = await store.listCloudAgentSkillBindings({
            tenant_id: device.tenant_id,
            device_id: device.device_id,
          });
          sendJson(res, 200, { bindings });
          return;
        }
        if (req.method === "POST" && parts.length === 3) {
          if (!device.user_id || (await store.getUser(device.user_id))?.status !== "active") {
            sendError(res, 403, "SUBSCRIPTION_REQUIRED", "请先绑定有效的 LongHub 账号");
            return;
          }
          if (!requireJsonContentType(req, res)) return;
          let parsed: { agent_id?: unknown; skill_id?: unknown; user_id?: unknown };
          try {
            parsed = JSON.parse(await readBoundedBody(req, 16 * 1024)) as typeof parsed;
          } catch (error) {
            if (error instanceof RequestBodyError) {
              sendError(res, error.status, error.code === "BODY_TOO_LARGE" ? "REQUEST_TOO_LARGE" : error.code, error.message, error.retryable);
            } else {
              sendError(res, 400, "INVALID_JSON", "请求体不是合法 JSON");
            }
            return;
          }
          const agentId = parsed.agent_id;
          const skillId = parsed.skill_id;
          if (typeof agentId !== "string" || !TASK_AGENT_PATTERN.test(agentId) ||
            typeof skillId !== "string" || !CLOUD_SKILL_ID_PATTERN.test(skillId) ||
            (parsed.user_id !== undefined && parsed.user_id !== device.user_id)) {
            sendError(res, 422, "INVALID_AGENT_SKILL_BINDING", "agent_id、skill_id 或 user_id 无效");
            return;
          }
          const result = await store.upsertCloudAgentSkillBinding({
            tenant_id: device.tenant_id,
            device_id: device.device_id,
            user_id: device.user_id,
            agent_id: agentId,
            skill_id: skillId,
          });
          await store.appendAudit(`device:${device.device_id}`, "cloud_agent_skill_binding.upsert", {
            binding_id: result.binding.binding_id,
            agent_id: result.binding.agent_id,
            skill_id: result.binding.skill_id,
            existed: result.existed,
          });
          sendJson(res, result.existed ? 200 : 201, { binding: result.binding });
          return;
        }
        // Clean-launch keeps the binding identifier in the URL only.  A body
        // based DELETE was part of an earlier in-process protocol and would
        // make the public contract ambiguous (and harder to audit).
        if (req.method === "DELETE" && parts.length === 4) {
          const bindingId = parts[3];
          if (!bindingId || !CLOUD_SAFE_ID_PATTERN.test(bindingId)) {
            sendError(res, 422, "INVALID_AGENT_SKILL_BINDING", "binding_id 无效");
            return;
          }
          const owned = (await store.listCloudAgentSkillBindings({
            tenant_id: device.tenant_id,
            device_id: device.device_id,
          })).find((binding) => binding.binding_id === bindingId &&
            (binding.user_id === undefined || binding.user_id === device.user_id));
          if (!owned) {
            sendError(res, 404, "AGENT_SKILL_BINDING_NOT_FOUND", "Agent-Skill 绑定不存在");
            return;
          }
          const revoked = await store.revokeCloudAgentSkillBinding(bindingId);
          if (!revoked) {
            sendError(res, 404, "AGENT_SKILL_BINDING_NOT_FOUND", "Agent-Skill 绑定不存在");
            return;
          }
          await store.appendAudit(`device:${device.device_id}`, "cloud_agent_skill_binding.revoke", {
            binding_id: revoked.binding_id,
            agent_id: revoked.agent_id,
            skill_id: revoked.skill_id,
          });
          sendJson(res, 200, { binding: revoked });
          return;
        }
      }

      // POST /v1/tasks
      if (req.method === "POST" && url.pathname === "/v1/tasks") {
        // Cloud Skill execution has its own account/subscription/binding gates
        // below. Requiring a legacy activation code here would incorrectly
        // turn the free Manager into a second paid prerequisite.
        const device = await authenticateCloudTaskDevice(req, res);
        if (!device) return;
        const idempotencyKey = req.headers["idempotency-key"];
        if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
          sendError(res, 400, "IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key 请求头");
          return;
        }
        if (!requireJsonContentType(req, res)) return;
        try {
          const raw = await readBoundedBody(req, CLOUD_TASK_MAX_BYTES);
          const parsedCall = parseCloudTaskCall(raw, idempotencyKey, allowDevelopmentTasks);
          const requestedOpenClawVersion = req.headers["x-longhub-openclaw-version"];
          const call: NormalizedCloudTaskCall = typeof requestedOpenClawVersion === "string"
            ? { ...parsedCall, openclawVersion: requestedOpenClawVersion }
            : parsedCall;
          const owner = {
            tenant_id: device.tenant_id,
            device_id: device.device_id,
            agent_id: call.agentId,
          };
          const inputDigest = computeExecutorInputDigest(call.input);
          const requestFingerprint = computeCloudTaskRequestFingerprint({
            // Legacy development envelopes are kept distinct from the strict
            // protocol even when their normalized fields happen to match.
            schema_version: call.strict ? CLOUD_CALL_SCHEMA : "longhub/cloud-skill-call/legacy",
            request_id: call.requestId,
            kind: "skill.execute",
            tenant_id: owner.tenant_id,
            device_id: owner.device_id,
            agent_id: owner.agent_id,
            skill_id: call.skillId,
            skill_version: call.skillVersion,
            tool_call_id: call.toolCallId,
            session_key_hash: call.sessionKeyHash,
            idempotency_key: call.idempotencyKey,
            requested_plan_id: call.requestedPlanId ?? null,
            input_digest: inputDigest,
          });

          const admissionPlaceholder = createCloudTaskAdmissionPlaceholder(requestFingerprint, inputDigest);

          // A valid owner may always read an admitted result of the exact
          // request. A staged task has not passed usage admission yet, so an
          // exact retry must resume the gates below rather than expose it as an
          // executable task or strand its idempotency key.
          const existing = await store.findTaskByIdempotency(idempotencyKey, owner);
          let stagedTask: CloudTask | undefined;
          if (existing) {
            if (existing.request_fingerprint !== requestFingerprint) {
              sendError(res, 409, "IDEMPOTENCY_CONFLICT", "幂等键已绑定其他请求");
              return;
            }
            if (existing.task.status !== "pending" ||
              !isCloudTaskAdmissionPlaceholder(existing.task.input, admissionPlaceholder)) {
              sendJson(res, 200, existing.task);
              return;
            }
            stagedTask = existing.task;
          }

          const cloudPlans = await cloudPlansForSkill(call.skillId);
          let grant: CloudSkillAccessGrant | undefined;

          // Feature Policy is an additional, server-side product gate. Missing
          // policy keeps the commercial subscription path backwards compatible;
          // an explicitly disabled or emergency-stopped execution policy blocks
          // only a new task, before its usage reservation or Executor call.
          if (!(await enforceDeviceFeaturePolicy(
            featurePolicyCtx,
            device,
            res,
            "skill.execute",
            { allowWhenMissing: true },
          ))) return;

          if (!allowDevelopmentTasks && cloudPlans.length === 0) {
            // Legacy envelopes retain their stable protocol error. A strict
            // production request without a commercial plan must fail closed;
            // otherwise removing a Skill from every plan would make it free
            // and would also bypass release revocation/compatibility checks.
            if (!call.strict) {
              sendError(res, 422, "INVALID_TASK", "云端 Skill 请求必须使用 longhub/cloud-skill-call/v1");
            } else {
              sendError(res, 403, "CLOUD_SKILL_SUBSCRIPTION_REQUIRED", "云端 Skill 未配置可用订阅计划");
            }
            return;
          }

          // `agent_id` in the request is not an authentication fact. For a
          // strict production call, require the separately enrolled,
          // server-owned tuple before subscription resolution, usage
          // reservation, task creation or Executor access. Exact replay above
          // intentionally remains a pure owner-scoped read after revocation.
          if (!allowDevelopmentTasks && call.strict && cloudPlans.length > 0) {
            let binding;
            try {
              binding = await store.resolveCloudAgentSkillBinding({
                tenant_id: device.tenant_id,
                device_id: device.device_id,
                ...(device.user_id === undefined ? {} : { user_id: device.user_id }),
                agent_id: call.agentId,
                skill_id: call.skillId,
              });
            } catch {
              sendError(res, 503, "AGENT_SKILL_BINDING_UNAVAILABLE", "Agent-Skill 绑定服务暂时不可用", true);
              return;
            }
            if (!binding) {
              sendError(res, 403, "AGENT_SKILL_BINDING_REQUIRED", "当前 Agent 未绑定该云端 Skill");
              return;
            }
          }

          if (cloudPlans.length > 0 && !allowDevelopmentTasks) {
            if (!device.user_id || (await store.getUser(device.user_id))?.status !== "active") {
              sendError(res, 403, "SUBSCRIPTION_REQUIRED", "需要有效的 LongHub 账号订阅");
              return;
            }
            const allowedPlanIds = call.requestedPlanId === undefined
              ? cloudPlans.map((plan) => plan.plan_id)
              : cloudPlans.filter((plan) => plan.plan_id === call.requestedPlanId).map((plan) => plan.plan_id);
            grant = allowedPlanIds.length > 0
              ? await store.resolveCloudSkillAccess({
                  user_id: device.user_id,
                  tenant_id: device.tenant_id,
                  skill_id: call.skillId,
                  allowed_plan_ids: allowedPlanIds,
                })
              : undefined;
            if (!grant) {
              sendError(res, 403, "CLOUD_SKILL_SUBSCRIPTION_REQUIRED", "云端 Skill 订阅无效、已到期或不匹配");
              return;
            }
            if (call.requestedPlanId !== undefined && grant.plan.plan_id !== call.requestedPlanId) {
              sendError(res, 403, "CLOUD_SKILL_PLAN_MISMATCH", "云端 Skill 计划与当前订阅不匹配");
              return;
            }
            if (!call.strict) {
              sendError(res, 422, "INVALID_TASK", "云端 Skill 请求必须使用 longhub/cloud-skill-call/v1");
              return;
            }

            const releaseCheck = await checkExecutionRelease(
              call.skillId,
              call.skillVersion,
              device,
              call.openclawVersion,
            );
            if (!releaseCheck.ok) {
              sendError(res, releaseCheck.status, releaseCheck.code, releaseCheck.message, releaseCheck.retryable ?? false);
              return;
            }
          }

          // The legacy envelope is parsed only far enough to preserve the
          // stable subscription error for unauthorised callers.  It must
          // never create a production task, including for an unknown skill
          // with no published Cloud Skill plans.
          if (!allowDevelopmentTasks && !call.strict) {
            sendError(res, 422, "INVALID_TASK", "云端 Skill 请求必须使用 longhub/cloud-skill-call/v1");
            return;
          }

          let task: CloudTask;
          let existed: boolean;
          if (stagedTask) {
            task = stagedTask;
            existed = true;
          } else {
            const created = await store.createTask(
              idempotencyKey,
              "skill.execute",
              grant && device.user_id ? admissionPlaceholder : call.input,
              owner,
              requestFingerprint,
            );
            task = created.task;
            existed = created.existed;
            if (existed && (task.status !== "pending" ||
              !isCloudTaskAdmissionPlaceholder(task.input, admissionPlaceholder))) {
              sendJson(res, 200, task);
              return;
            }
          }

          let reservationId: string | undefined;
          if (grant && device.user_id) {
            let reserved;
            try {
              reserved = await store.reserveCloudSkillExecution({
                task_id: task.task_id,
                user_id: device.user_id,
                tenant_id: device.tenant_id,
                device_id: device.device_id,
                agent_id: call.agentId,
                skill_id: call.skillId,
                plan_id: grant.plan.plan_id,
                subscription_id: grant.subscription.subscription_id,
                input_digest: inputDigest,
              });
            } catch {
              await store.discardPendingTask(task.task_id, admissionPlaceholder).catch(() => false);
              sendError(res, 503, "CLOUD_SKILL_USAGE_UNAVAILABLE", "云端 Skill 用量服务暂时不可用", true);
              return;
            }
            if (!reserved.ok) {
              const problem = cloudSkillReservationProblem(reserved.reason);
              if (reserved.retry_after_seconds !== undefined) res.setHeader("retry-after", String(reserved.retry_after_seconds));
              await store.discardPendingTask(task.task_id, admissionPlaceholder).catch(() => false);
              sendError(res, problem.status, problem.code, problem.message, problem.retryable);
              return;
            }
            reservationId = reserved.reservation.reservation_id;

            const leaseExpiresAt = Date.parse(reserved.reservation.lease_expires_at);
            if (reserved.reservation.released_at !== undefined || !Number.isFinite(leaseExpiresAt) ||
              leaseExpiresAt <= Date.now()) {
              const current = await store.getTask(task.task_id).catch(() => undefined);
              if (current && !isCloudTaskAdmissionPlaceholder(current.input, admissionPlaceholder)) {
                sendJson(res, 200, current);
                return;
              }
              await store.releaseCloudSkillExecution({
                reservation_id: reservationId,
                task_id: task.task_id,
                tenant_id: device.tenant_id,
                user_id: device.user_id,
              }).catch(() => undefined);
              await store.discardPendingTask(task.task_id, admissionPlaceholder).catch(() => false);
              sendError(res, 503, "CLOUD_SKILL_USAGE_UNAVAILABLE", "云端 Skill 用量预约已失效", true);
              return;
            }

            let admitted: CloudTask | undefined;
            try {
              admitted = await store.admitPendingTaskInput(task.task_id, admissionPlaceholder, call.input);
            } catch {
              await store.releaseCloudSkillExecution({
                reservation_id: reservationId,
                task_id: task.task_id,
                tenant_id: device.tenant_id,
                user_id: device.user_id,
              }).catch(() => undefined);
              await store.discardPendingTask(task.task_id, admissionPlaceholder).catch(() => false);
              sendError(res, 503, "CLOUD_SKILL_USAGE_UNAVAILABLE", "云端 Skill 用量服务暂时不可用", true);
              return;
            }
            if (!admitted) {
              const current = await store.getTask(task.task_id).catch(() => undefined);
              if (current && !isCloudTaskAdmissionPlaceholder(current.input, admissionPlaceholder)) {
                // Another exact retry won the placeholder CAS and owns task
                // execution. Its reservation is the same task-scoped record.
                sendJson(res, 200, current);
                return;
              }
              await store.releaseCloudSkillExecution({
                reservation_id: reservationId,
                task_id: task.task_id,
                tenant_id: device.tenant_id,
                user_id: device.user_id,
              }).catch(() => undefined);
              if (current?.status === "cancelled") {
                sendJson(res, 200, current);
              } else {
                sendError(res, 503, "CLOUD_SKILL_USAGE_UNAVAILABLE", "云端 Skill 用量服务暂时不可用", true);
              }
              return;
            }
            task = admitted;
          }
          logger.info("task.created", {
            task_id: task.task_id,
            skill: call.skillId,
            ...(grant ? { plan_id: grant.plan.plan_id } : {}),
          });
          void runTask({ taskId: task.task_id, device, call, grant, reservationId });
          sendJson(res, existed ? 200 : 201, task);
        } catch (error) {
          if (error instanceof CloudTaskRequestError) {
            sendError(res, error.status, error.code, error.message, error.retryable);
            return;
          }
          if (error instanceof RequestBodyError) {
            sendError(
              res,
              error.status,
              error.code === "BODY_TOO_LARGE" ? "REQUEST_TOO_LARGE" :
                error.code === "BODY_TIMEOUT" ? "REQUEST_TIMEOUT" : "INVALID_REQUEST",
              error.message,
              error.retryable,
            );
            return;
          }
          // Preserve the stable code for older bounded-body callers while all
          // new routes use RequestBodyError above.
          if (error instanceof Error && error.message === "BODY_TOO_LARGE") {
            sendError(res, 413, "REQUEST_TOO_LARGE", "请求体超过大小限制");
            return;
          }
          if (error instanceof Error && error.message === "IDEMPOTENCY_CONFLICT") {
            sendError(res, 409, "IDEMPOTENCY_CONFLICT", "幂等键已绑定其他请求");
            return;
          }
          logger.error("task.create_failed", { code: "TASK_CREATE_FAILED" });
          sendError(res, 503, "TASK_CREATE_FAILED", "云端任务暂时不可用", true);
        }
        return;
      }

      // /v1/tasks/{taskId}...
      if (parts[0] === "v1" && parts[1] === "tasks" && parts[2]) {
        const device = await authenticateCloudTaskDevice(req, res);
        if (!device) return;
        const requestedAgentId = taskAgentId(req);
        const task = await store.getTask(parts[2]);
        if (!task) {
          sendError(res, 404, "TASK_NOT_FOUND", `未知任务: ${parts[2]}`);
          return;
        }
        // Return the same 404 for a foreign task to avoid an existence oracle.
        // Ownership is immutable and comes from the creating authenticated device.
        if (!taskBelongsToDevice(task, device, requestedAgentId)) {
          sendError(res, 404, "TASK_NOT_FOUND", "未知任务");
          return;
        }

        if (req.method === "GET" && parts.length === 3) {
          sendJson(res, 200, task);
          return;
        }

        if (req.method === "POST" && parts[3] === "cancel") {
          if (task.status === "pending" || task.status === "running") {
            let cancelled: CloudTask | undefined;
            try {
              cancelled = await store.transitionIfStatus(
                task.task_id,
                ["pending", "running"],
                "cancelled",
              );
            } catch (error) {
              // PgStore updates the row before appending the event. If event
              // persistence fails after the CAS commit, still abort the
              // in-process worker and recover the committed cancelled row.
              activeTaskControllers.get(task.task_id)?.abort();
              if (store.releaseCloudSkillExecution) {
                await store.releaseCloudSkillExecution({
                  task_id: task.task_id,
                  tenant_id: device.tenant_id,
                  user_id: device.user_id,
                }).catch(() => undefined);
              }
              const current = await store.getTask(task.task_id).catch(() => undefined);
              if (current?.status !== "cancelled") throw error;
              cancelled = current;
            }
            if (cancelled) {
              activeTaskControllers.get(task.task_id)?.abort();
              if (store.releaseCloudSkillExecution) {
                await store.releaseCloudSkillExecution({
                  task_id: task.task_id,
                  tenant_id: device.tenant_id,
                  user_id: device.user_id,
                }).catch(() => undefined);
              }
            }
          }
          sendJson(res, 202, await store.getTask(task.task_id));
          return;
        }

        if (req.method === "GET" && parts[3] === "events") {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          const send = (event: { event_id: string; [k: string]: unknown }) => {
            res.write(`id: ${event.event_id}\ndata: ${JSON.stringify(event)}\n\n`);
          };
          const lastEventId = req.headers["last-event-id"];
          for (const event of await store.eventsAfter(
            task.task_id,
            typeof lastEventId === "string" ? lastEventId : undefined,
          )) {
            send(event);
          }
          const unsubscribe = store.subscribe(task.task_id, send);
          req.on("close", unsubscribe);
          return;
        }
      }

      sendError(res, 404, "NOT_FOUND", "未知路由");
    })().catch((err) => {
      logger.error("request.failed", { message: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) sendError(res, 500, "INTERNAL", "内部错误", true);
    });
  });
}
