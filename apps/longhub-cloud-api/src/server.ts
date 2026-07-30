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
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  computePackDigest,
  signPackDigest,
  validatePackContent,
  validatePackManifest,
  type PackFile,
  type PackManifest,
} from "@longhub/pack-schema";
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
import { handleModelGatewayRoutes } from "./model-gateway.js";
import { deviceActivationStatus, hashActivationCode, publicActivationCode } from "./activation-code.js";
import { readJson } from "./http-util.js";
import { scanThirdPartyPack } from "./pack-review.js";
import { decryptKnowledgeContent, encryptKnowledgeContent } from "./knowledge-crypto.js";
import type {
  ClientTelemetryAggregateRecord,
  CloudStore,
  DeviceRecord,
  EntitlementRecord,
  PackReleaseRecord,
} from "./store.js";

export interface SigningKey {
  keyId: string;
  privateKeyPem: string;
  publicKeyPem: string;
}

export interface CloudApiOptions {
  executorUrl: string;
  /** 缺省使用内存存储；生产传入 PgStore */
  store?: CloudStore;
  /** 管理面（Console）凭据；生产从密钥服务下发 */
  adminToken?: string;
  /** 发布签名密钥（Ed25519）；缺省自动生成（仅限开发），生产从密钥服务下发 */
  signingKey?: SigningKey;
  /** 客户端更新元数据专用密钥；不得与 Agent Pack 发布密钥共用 */
  updateSigningKey?: SigningKey;
  /** 密钥轮换期间保留的历史更新公钥（key ID → Ed25519 PEM） */
  updateTrustedPublicKeys?: ReadonlyMap<string, string>;
  /** 客户端安装包目录；缺省读取 CLIENT_RELEASE_DIR */
  clientReleaseDir?: string;
  /** 模型上游 API Key 的 32 字节 AES 主密钥 */
  modelEncryptionKey?: Uint8Array;
  /** 租户知识库正文的独立 32 字节 AES 数据密钥；不得与模型密钥共用 */
  knowledgeDataKey?: Uint8Array;
  /** 仅供本地开发/测试连接 HTTP 或私网模型服务 */
  allowInsecureModelUpstream?: boolean;
  /** 模型代理超时覆盖，仅供确定性测试。 */
  modelProxyTimeoutMs?: number;
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

async function readBody(req: NodeJS.ReadableStream): Promise<string> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

async function readBoundedBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw Object.assign(new Error("BODY_TOO_LARGE"), { code: "BODY_TOO_LARGE" });
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw Object.assign(new Error("BODY_TOO_LARGE"), { code: "BODY_TOO_LARGE" });
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function versionBelow(current: string, minimum: string): boolean {
  const parse = (value: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(value)?.slice(1).map(Number);
  const left = parse(current);
  const right = parse(minimum);
  if (!left || !right) return current.localeCompare(minimum) < 0;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index]! < right[index]!;
  }
  return false;
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
    desktop_version: event.desktop_version,
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

export function createCloudApiServer(options: CloudApiOptions): Server {
  const logger = createConsoleLogger("cloud-api");
  if (options.knowledgeDataKey && options.knowledgeDataKey.byteLength !== 32) {
    throw new Error("知识库数据加密密钥长度必须为 32 字节");
  }
  if (options.modelEncryptionKey && options.knowledgeDataKey &&
    Buffer.from(options.modelEncryptionKey).equals(Buffer.from(options.knowledgeDataKey))) {
    throw new Error("知识库数据密钥不得与模型配置密钥共用");
  }
  const store = options.store ?? new MemoryStore();
  const adminToken = options.adminToken ?? "longhub-dev-admin";
  const signingKey = options.signingKey ?? generateSigningKey();
  const updateSigningKey = options.updateSigningKey ?? generateSigningKey(`longhub-update-dev-${new Date().getFullYear()}`);
  const encodeKnowledge = (content: string, tenantId: string): string =>
    options.knowledgeDataKey ? encryptKnowledgeContent(content, tenantId, options.knowledgeDataKey) : content;
  const decodeKnowledge = (content: string, tenantId: string): string =>
    options.knowledgeDataKey ? decryptKnowledgeContent(content, tenantId, options.knowledgeDataKey) : content;
  const derivedPackPublicKey = canonicalEd25519PublicKey(signingKey.privateKeyPem, "private", "Agent Pack 签名私钥");
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
  if (updateSigningKey.keyId === signingKey.keyId || derivedUpdatePublicKey === derivedPackPublicKey) {
    throw new Error("客户端更新签名密钥必须与 Agent Pack 发布密钥分离");
  }
  if (derivedUpdatePublicKey !== configuredUpdatePublicKey) {
    throw new Error("客户端更新签名公钥与私钥不匹配");
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

  async function authenticateRegistered(req: IncomingMessage, res: ServerResponse): Promise<DeviceRecord | undefined> {
    const token = bearerToken(req);
    const device = token ? await store.findDeviceByToken(token) : undefined;
    if (!device || device.status !== "active") {
      sendError(res, 401, "UNAUTHORIZED", "缺少或无效的设备凭据");
      return undefined;
    }
    if (device.min_required_version && versionBelow(device.app_version, device.min_required_version)) {
      sendError(res, 426, "CLIENT_VERSION_UNSUPPORTED", "当前龙枢版本低于管理员要求，请先更新客户端");
      return undefined;
    }
    void store.updateDeviceOperations(device.device_id, { last_seen_at: new Date().toISOString() }).catch(() => undefined);
    return device;
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

  async function runTask(taskId: string, skillId: string, input: unknown): Promise<void> {
    await store.transition(taskId, "running");
    try {
      const res = await fetch(`${options.executorUrl}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ skillId, input }),
      });
      const body = (await res.json()) as { output?: unknown; code?: string; message?: string };
      const task = await store.getTask(taskId);
      if (task?.status === "cancelled") return;
      if (!res.ok) {
        await store.transition(taskId, "failed", {
          error: { code: body.code ?? "EXECUTOR_ERROR", message: body.message ?? "执行器错误", retryable: false },
        });
        return;
      }
      await store.transition(taskId, "succeeded", { output: body.output });
    } catch (err) {
      await store.transition(taskId, "failed", {
        error: {
          code: "EXECUTOR_UNREACHABLE",
          message: err instanceof Error ? err.message : String(err),
          retryable: true,
        },
      });
    }
  }

  const adminCtx: AdminRouteContext = { store, adminToken, logger };
  const accountCtx = { store, logger };
  const clientReleaseCtx: ClientReleaseContext = {
    admin: adminCtx,
    releaseDir: options.clientReleaseDir ?? process.env.CLIENT_RELEASE_DIR ?? "./client-releases",
    signingKey: updateSigningKey,
    trustedPublicKeys: updateTrustedPublicKeys,
  };

  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);

      // CORS：Portal / Admin Web 直连（生产建议 nginx 同源反代，此处兜底开发与跨端口访问）
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-headers", "authorization, content-type, idempotency-key, last-event-id");
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (await handleAccountRoutes(accountCtx, req, res, url, parts)) return;
      if (await handleClientReleaseRoutes(clientReleaseCtx, req, res, url)) return;

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
        authenticateDevice: authenticate,
      }, req, res, url)) return;
      if (await handleAdminRoutes(adminCtx, req, res, url, parts)) return;

      // 严格匿名遥测：Bearer 仅用于鉴权和进程内限流，身份不进入请求对象的聚合存储。
      if (req.method === "POST" && url.pathname === "/v1/client/telemetry") {
        const device = await authenticate(req, res);
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
        let parsed: {
          tenant_id?: string;
          platform?: string;
          app_version?: string;
          device_fingerprint?: string;
          display_name?: string;
        };
        try {
          parsed = JSON.parse(await readBody(req));
        } catch {
          sendError(res, 400, "INVALID_JSON", "请求体不是合法 JSON");
          return;
        }
        if (
          parsed.platform !== "windows" ||
          typeof parsed.app_version !== "string" ||
          typeof parsed.device_fingerprint !== "string" ||
          parsed.device_fingerprint.length === 0
        ) {
          sendError(res, 422, "INVALID_DEVICE", "platform 必须为 windows，app_version 和 device_fingerprint 必填");
          return;
        }
        const { device, existed } = await store.registerDevice({
          tenant_id: parsed.tenant_id ?? "tenant-default",
          platform: parsed.platform,
          app_version: parsed.app_version,
          device_fingerprint: parsed.device_fingerprint,
          display_name: parsed.display_name,
        });
        if (!existed) logger.info("device.registered", { device_id: device.device_id, tenant_id: device.tenant_id });
        sendJson(res, existed ? 200 : 201, device);
        return;
      }

      // GET /v1/packs/signing-key（公开：发布公钥供客户端钉住信任）
      if (req.method === "GET" && url.pathname === "/v1/packs/signing-key") {
        sendJson(res, 200, { key_id: signingKey.keyId, public_key_pem: signingKey.publicKeyPem });
        return;
      }

      // 管理面：套装上传→云端签名→发布 / 吊销（Console/Admin Web 使用管理凭据或管理员会话）
      if (parts[0] === "v1" && parts[1] === "admin" && parts[2] === "packs") {
        const identity = await requireAdmin(adminCtx, req, res, { write: true });
        if (!identity) return;
        if (req.method === "POST" && parts.length === 3) {
          let parsed: { manifest?: PackManifest; files?: Record<string, string> };
          try {
            parsed = JSON.parse(await readBody(req));
          } catch {
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

      // GET /v1/catalog/packs（设备视角：可见套装目录）
      if (req.method === "GET" && url.pathname === "/v1/catalog/packs") {
        if (!(await authenticate(req, res))) return;
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
        let parsed: { desktop_version?: string; installed_packs?: { pack_id: string; version: string }[] };
        try {
          parsed = JSON.parse(await readBody(req));
        } catch {
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
          let parsed: { device_id?: string; pack_id?: string; expires_at?: string };
          try {
            parsed = JSON.parse(await readBody(req));
          } catch {
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

      // POST /v1/tasks
      if (req.method === "POST" && url.pathname === "/v1/tasks") {
        if (!(await authenticate(req, res))) return;
        const idempotencyKey = req.headers["idempotency-key"];
        if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
          sendError(res, 400, "IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key 请求头");
          return;
        }
        let parsed: { kind?: string; input?: { skillId?: string; [k: string]: unknown } };
        try {
          parsed = JSON.parse(await readBody(req));
        } catch {
          sendError(res, 400, "INVALID_JSON", "请求体不是合法 JSON");
          return;
        }
        if (parsed.kind !== "skill.execute" || typeof parsed.input?.skillId !== "string") {
          sendError(res, 422, "INVALID_TASK", "kind 必须为 skill.execute 且 input.skillId 必填");
          return;
        }
        const { task, existed } = await store.createTask(idempotencyKey, parsed.kind, parsed.input);
        if (!existed) {
          logger.info("task.created", { task_id: task.task_id, skill: parsed.input.skillId });
          void runTask(task.task_id, parsed.input.skillId, parsed.input);
        }
        sendJson(res, existed ? 200 : 201, task);
        return;
      }

      // /v1/tasks/{taskId}...
      if (parts[0] === "v1" && parts[1] === "tasks" && parts[2]) {
        if (!(await authenticate(req, res))) return;
        const task = await store.getTask(parts[2]);
        if (!task) {
          sendError(res, 404, "TASK_NOT_FOUND", `未知任务: ${parts[2]}`);
          return;
        }

        if (req.method === "GET" && parts.length === 3) {
          sendJson(res, 200, task);
          return;
        }

        if (req.method === "POST" && parts[3] === "cancel") {
          if (task.status === "pending" || task.status === "running") {
            await store.transition(task.task_id, "cancelled");
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
