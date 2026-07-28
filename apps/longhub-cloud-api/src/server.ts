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
import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  computePackDigest,
  signPackDigest,
  validatePackManifest,
  type PackFile,
  type PackManifest,
} from "@longhub/pack-schema";
import { createConsoleLogger } from "@longhub/observability";
import { MemoryStore } from "./memory-store.js";
import type { CloudStore, DeviceRecord, EntitlementRecord, PackReleaseRecord } from "./store.js";

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

function isEntitled(entitlements: EntitlementRecord[], packId: string): boolean {
  const now = new Date().toISOString();
  return entitlements.some((e) => e.pack_id === packId && e.status === "active" && e.expires_at > now);
}

function toPackSummary(releases: PackReleaseRecord[]): {
  pack_id: string;
  name: string;
  latest_version: string;
  min_desktop_version: string;
  capabilities: { capability_id: string; version: string }[];
} {
  const latest = releases[releases.length - 1]!;
  return {
    pack_id: latest.pack_id,
    name: latest.pack_id,
    latest_version: latest.version,
    min_desktop_version: latest.min_desktop_version,
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

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
}

export function createCloudApiServer(options: CloudApiOptions): Server {
  const logger = createConsoleLogger("cloud-api");
  const store = options.store ?? new MemoryStore();
  const adminToken = options.adminToken ?? "longhub-dev-admin";
  const signingKey = options.signingKey ?? generateSigningKey();

  async function authenticate(req: IncomingMessage, res: ServerResponse): Promise<DeviceRecord | undefined> {
    const token = bearerToken(req);
    const device = token ? await store.findDeviceByToken(token) : undefined;
    if (!device || device.status !== "active") {
      sendError(res, 401, "UNAUTHORIZED", "缺少或无效的设备凭据");
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

  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);

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

      // 管理面：套装上传→云端签名→发布 / 吊销（Console 使用管理凭据）
      if (parts[0] === "v1" && parts[1] === "admin" && parts[2] === "packs") {
        if (bearerToken(req) !== adminToken) {
          sendError(res, 401, "UNAUTHORIZED", "缺少或无效的管理凭据");
          return;
        }
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
          // 云端重算摘要并签名：上传方无需持有发布私钥
          const digest = computePackDigest(parsed.files);
          const manifest: PackManifest = {
            ...parsed.manifest,
            integrity: { algorithm: "sha256", digest, signatureKeyId: signingKey.keyId },
          };
          const validated = validatePackManifest(manifest);
          if (!validated.ok) {
            sendError(
              res,
              422,
              "MANIFEST_INVALID",
              validated.issues.map((i) => `${i.path}: ${i.message}`).join("; "),
            );
            return;
          }
          const pack: PackFile = {
            manifest: validated.manifest,
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
          sendJson(res, 202, { pack_id: release.pack_id, version: release.version, status: release.status });
          return;
        }
      }

      // GET /v1/catalog/packs（设备视角：可见套装目录）
      if (req.method === "GET" && url.pathname === "/v1/catalog/packs") {
        if (!(await authenticate(req, res))) return;
        const releases = (await store.listReleases()).filter((r) => r.status === "active");
        const byPack = new Map<string, PackReleaseRecord[]>();
        for (const r of releases) {
          byPack.set(r.pack_id, [...(byPack.get(r.pack_id) ?? []), r]);
        }
        sendJson(res, 200, { packs: [...byPack.values()].map(toPackSummary) });
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
          if (current?.status === "revoked") {
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

      // 管理面：授予/撤销授权（Console 使用管理凭据）
      if (parts[0] === "v1" && parts[1] === "admin" && parts[2] === "entitlements") {
        if (bearerToken(req) !== adminToken) {
          sendError(res, 401, "UNAUTHORIZED", "缺少或无效的管理凭据");
          return;
        }
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
