/**
 * 客户端安装包分发：上传时计算摘要并签署严格更新元数据；公开端只返回可由客户端预置公钥验证的
 * envelope。旧版未签名 releases.json 不会自动重签，只会停止公开并等待管理员重新上传。
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  CLIENT_UPDATE_SCHEMA,
  compareClientVersions,
  signClientUpdateManifest,
  verifyClientUpdateMetadata,
  type ClientUpdateManifest,
  type SignedClientUpdateMetadata,
} from "@longhub/pack-schema";
import { requireAdmin, type AdminRouteContext } from "./admin-routes.js";
import { sendError, sendJson } from "./http-util.js";
import type { SigningKey } from "./server.js";

export interface ClientReleaseRecord extends SignedClientUpdateMetadata {
  uploaded_by: string;
  uploaded_at: string;
  rollout_updated_by: string;
  rollout_updated_at: string;
}

export interface ClientReleaseContext {
  admin: AdminRouteContext;
  releaseDir: string;
  signingKey: SigningKey;
  trustedPublicKeys: ReadonlyMap<string, string>;
}

const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

function metaFile(dir: string): string {
  return join(dir, "releases.json");
}

function signedEnvelope(record: ClientReleaseRecord): SignedClientUpdateMetadata {
  return {
    manifest: record.manifest,
    signature_key_id: record.signature_key_id,
    signature: record.signature,
  };
}

function loadReleases(ctx: ClientReleaseContext): ClientReleaseRecord[] {
  const file = metaFile(ctx.releaseDir);
  if (!existsSync(file)) return [];
  const raw = JSON.parse(readFileSync(file, "utf-8")) as unknown;
  if (!Array.isArray(raw)) throw new Error("客户端发布索引必须是数组");
  const releases: ClientReleaseRecord[] = [];
  let legacyCount = 0;
  for (const item of raw) {
    if (
      typeof item !== "object" || item === null ||
      !("manifest" in item) ||
      (item as { manifest?: { schema_version?: string; rollout?: unknown } }).manifest?.schema_version !==
        CLIENT_UPDATE_SCHEMA ||
      !(item as { manifest?: { rollout?: unknown } }).manifest?.rollout ||
      (item as { manifest?: { rollback_data_strategy?: unknown } }).manifest?.rollback_data_strategy === undefined
    ) {
      legacyCount += 1;
      continue;
    }
    const candidate = item as Partial<ClientReleaseRecord>;
    if (
      typeof candidate.uploaded_by !== "string" ||
      typeof candidate.uploaded_at !== "string" ||
      !Number.isFinite(Date.parse(candidate.uploaded_at)) ||
      typeof candidate.rollout_updated_by !== "string" ||
      typeof candidate.rollout_updated_at !== "string" ||
      !Number.isFinite(Date.parse(candidate.rollout_updated_at)) ||
      !verifyClientUpdateMetadata(signedEnvelope(candidate as ClientReleaseRecord), ctx.trustedPublicKeys)
    ) {
      throw new Error("客户端发布索引包含签名无效或未知密钥的记录");
    }
    releases.push(candidate as ClientReleaseRecord);
  }
  if (legacyCount > 0) {
    ctx.admin.logger.warn("client_release.legacy_metadata_ignored", { count: legacyCount });
  }
  return releases.sort((left, right) => right.manifest.sequence - left.manifest.sequence);
}

function saveReleases(dir: string, releases: ClientReleaseRecord[]): void {
  mkdirSync(dir, { recursive: true });
  const target = metaFile(dir);
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(releases, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, target);
}

function adminView(record: ClientReleaseRecord): ClientReleaseRecord & { url: string } {
  return { ...record, url: record.manifest.url_path };
}

function validChannel(value: string | null): value is ClientUpdateManifest["channel"] {
  return value === "stable" || value === "beta";
}

async function readRolloutPolicyBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ status: "active" | "paused"; basis_points: number } | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const data = Buffer.from(chunk as Uint8Array);
    size += data.length;
    if (size <= 16 * 1024) chunks.push(data);
  }
  if (size > 16 * 1024) {
    sendError(res, 413, "PAYLOAD_TOO_LARGE", "灰度策略请求体超过 16 KiB");
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    sendError(res, 400, "INVALID_JSON", "请求体不是合法 JSON");
    return undefined;
  }
  if (
    typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
    Object.keys(parsed).sort().join("|") !== "basis_points|status"
  ) {
    sendError(res, 422, "VALIDATION_FAILED", "灰度策略字段无效");
    return undefined;
  }
  const body = parsed as Record<string, unknown>;
  if (
    (body.status !== "active" && body.status !== "paused") ||
    !Number.isInteger(body.basis_points) || (body.basis_points as number) < 0 ||
    (body.basis_points as number) > 10_000 ||
    (body.status === "active" && body.basis_points === 0)
  ) {
    sendError(res, 422, "VALIDATION_FAILED", "active 比例必须为 1..10000 基点，paused 可保留 0..10000");
    return undefined;
  }
  return body as { status: "active" | "paused"; basis_points: number };
}

/** 返回 true 表示本模块已处理该请求 */
export async function handleClientReleaseRoutes(
  ctx: ClientReleaseContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  // 公开：签名公钥只用于运维核对/轮换发现；Desktop 的信任锚必须随应用预置，不能信任本接口自举。
  if (req.method === "GET" && url.pathname === "/v1/client-releases/signing-key") {
    sendJson(res, 200, {
      purpose: "longhub-client-update-v2",
      key_id: ctx.signingKey.keyId,
      public_key_pem: ctx.signingKey.publicKeyPem,
    });
    return true;
  }

  // 公开：最新的已签名版本元数据。
  if (req.method === "GET" && url.pathname === "/v1/client-releases/latest") {
    const requestedChannel = url.searchParams.get("channel") ?? "stable";
    if (!validChannel(requestedChannel)) {
      sendError(res, 422, "INVALID_CHANNEL", "channel 必须为 stable 或 beta");
      return true;
    }
    const latest = loadReleases(ctx).find((release) => release.manifest.channel === requestedChannel);
    sendJson(res, 200, { release: latest ? signedEnvelope(latest) : null });
    return true;
  }

  // 公开：按精确版本返回可信元数据，供 Desktop 在升级前准备当前版本的回滚安装器。
  // 此接口不执行 rollout 判断，也不会把历史版本伪装成“最新版本”。
  const exactVersionMatch = /^\/v1\/client-releases\/versions\/([^/]+)$/.exec(url.pathname);
  if (req.method === "GET" && exactVersionMatch) {
    const requestedChannel = url.searchParams.get("channel") ?? "stable";
    if (!validChannel(requestedChannel)) {
      sendError(res, 422, "INVALID_CHANNEL", "channel 必须为 stable 或 beta");
      return true;
    }
    let version: string;
    try {
      version = decodeURIComponent(exactVersionMatch[1]!);
    } catch {
      sendError(res, 422, "VALIDATION_FAILED", "客户端版本编码无效");
      return true;
    }
    if (!/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(version)) {
      sendError(res, 422, "VALIDATION_FAILED", "version 需为 x.y.z 形式");
      return true;
    }
    const release = loadReleases(ctx).find((candidate) =>
      candidate.manifest.version === version && candidate.manifest.channel === requestedChannel
    );
    if (!release) {
      sendError(res, 404, "CLIENT_RELEASE_NOT_FOUND", "指定渠道的客户端版本不存在");
      return true;
    }
    sendJson(res, 200, { release: signedEnvelope(release) });
    return true;
  }

  // 管理：版本列表。
  if (req.method === "GET" && url.pathname === "/v1/admin/client-releases") {
    const identity = await requireAdmin(ctx.admin, req, res, { write: false });
    if (!identity) return true;
    sendJson(res, 200, { releases: loadReleases(ctx).map(adminView) });
    return true;
  }

  const rolloutMatch = /^\/v1\/admin\/client-releases\/([^/]+)\/rollout$/.exec(url.pathname);
  if (req.method === "PATCH" && rolloutMatch) {
    const identity = await requireAdmin(ctx.admin, req, res, { write: true });
    if (!identity) return true;
    let version: string;
    try {
      version = decodeURIComponent(rolloutMatch[1]!);
    } catch {
      sendError(res, 422, "VALIDATION_FAILED", "客户端版本编码无效");
      return true;
    }
    if (!/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(version)) {
      sendError(res, 422, "VALIDATION_FAILED", "version 需为 x.y.z 形式");
      return true;
    }
    const policy = await readRolloutPolicyBody(req, res);
    if (!policy) return true;
    const releases = loadReleases(ctx);
    const existing = releases.find((release) => release.manifest.version === version);
    if (!existing) {
      sendError(res, 404, "CLIENT_RELEASE_NOT_FOUND", "客户端版本不存在");
      return true;
    }
    const latestInChannel = releases.find((release) => release.manifest.channel === existing.manifest.channel);
    if (latestInChannel?.manifest.version !== version) {
      sendError(res, 409, "ROLLOUT_NOT_LATEST", "只能调整当前渠道最新版本的灰度策略");
      return true;
    }
    if (
      existing.manifest.rollout.status === policy.status &&
      existing.manifest.rollout.basis_points === policy.basis_points
    ) {
      sendError(res, 409, "ROLLOUT_UNCHANGED", "灰度策略没有变化");
      return true;
    }
    const updatedAt = new Date().toISOString();
    const manifest: ClientUpdateManifest = {
      ...existing.manifest,
      sequence: (releases[0]?.manifest.sequence ?? 0) + 1,
      rollout: {
        ...existing.manifest.rollout,
        status: policy.status,
        basis_points: policy.basis_points,
        updated_at: updatedAt,
      },
    };
    const updated: ClientReleaseRecord = {
      ...existing,
      manifest,
      signature_key_id: ctx.signingKey.keyId,
      signature: signClientUpdateManifest(manifest, ctx.signingKey.privateKeyPem),
      rollout_updated_by: identity.actor,
      rollout_updated_at: updatedAt,
    };
    saveReleases(ctx.releaseDir, [updated, ...releases.filter((release) => release !== existing)]);
    await ctx.admin.store.appendAudit(identity.actor, "client_release.rollout_update", {
      version,
      channel: manifest.channel,
      status: manifest.rollout.status,
      basis_points: manifest.rollout.basis_points,
      sequence: manifest.sequence,
      signature_key_id: updated.signature_key_id,
    });
    ctx.admin.logger.info("client_release.rollout_updated", {
      version,
      channel: manifest.channel,
      status: manifest.rollout.status,
      basis_points: manifest.rollout.basis_points,
      sequence: manifest.sequence,
    });
    sendJson(res, 200, { release: adminView(updated) });
    return true;
  }

  // 管理：上传安装包（二进制流）；同版本、旧版本和同名文件都不可覆盖。
  if (req.method === "POST" && url.pathname === "/v1/admin/client-releases") {
    const identity = await requireAdmin(ctx.admin, req, res, { write: true });
    if (!identity) return true;
    const version = url.searchParams.get("version")?.trim() ?? "";
    const rawName = url.searchParams.get("filename")?.trim() ?? "";
    const channelValue = url.searchParams.get("channel") ?? "stable";
    const filename = basename(rawName);
    if (!/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(version)) {
      sendError(res, 422, "VALIDATION_FAILED", "version 需为 x.y.z 形式");
      return true;
    }
    if (rawName !== filename || filename !== `LongHub-Setup-${version}.exe`) {
      sendError(res, 422, "VALIDATION_FAILED", "filename 必须与版本匹配：LongHub-Setup-x.y.z.exe");
      return true;
    }
    if (!validChannel(channelValue)) {
      sendError(res, 422, "INVALID_CHANNEL", "channel 必须为 stable 或 beta");
      return true;
    }
    const declaredHeader = req.headers["content-length"];
    const declared = declaredHeader === undefined ? undefined : Number(declaredHeader);
    if (declared !== undefined && (!Number.isSafeInteger(declared) || declared <= 0)) {
      sendError(res, 400, "INVALID_CONTENT_LENGTH", "Content-Length 必须为正整数");
      return true;
    }
    if (declared !== undefined && declared > MAX_UPLOAD_BYTES) {
      sendError(res, 413, "PAYLOAD_TOO_LARGE", "安装包超过大小上限");
      return true;
    }

    const releases = loadReleases(ctx);
    if (releases.some((release) => release.manifest.version === version)) {
      sendError(res, 409, "VERSION_EXISTS", `客户端版本 ${version} 已发布，禁止覆盖`);
      return true;
    }
    const latestInChannel = releases.find((release) => release.manifest.channel === channelValue);
    if (latestInChannel && compareClientVersions(version, latestInChannel.manifest.version) <= 0) {
      sendError(res, 409, "VERSION_ROLLBACK", `新版本必须高于 ${latestInChannel.manifest.version}`);
      return true;
    }

    mkdirSync(ctx.releaseDir, { recursive: true, mode: 0o750 });
    const target = join(ctx.releaseDir, filename);
    if (existsSync(target)) {
      sendError(res, 409, "ARTIFACT_EXISTS", "同名安装包已存在，禁止覆盖");
      return true;
    }
    const temporary = join(ctx.releaseDir, `.${filename}.${randomUUID()}.upload`);
    const hash = createHash("sha256");
    let size = 0;
    let tooLarge = false;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > MAX_UPLOAD_BYTES) {
          tooLarge = true;
          callback(new Error("PAYLOAD_TOO_LARGE"));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(req, meter, createWriteStream(temporary, { flags: "wx", mode: 0o640 }));
    } catch (error) {
      if (existsSync(temporary)) unlinkSync(temporary);
      if (tooLarge) sendError(res, 413, "PAYLOAD_TOO_LARGE", "安装包超过大小上限");
      else sendError(res, 500, "UPLOAD_FAILED", error instanceof Error ? error.message : "上传失败");
      return true;
    }
    if (size <= 0 || (declared !== undefined && size !== declared)) {
      unlinkSync(temporary);
      sendError(res, 400, "UPLOAD_SIZE_MISMATCH", "实际上传大小与 Content-Length 不一致");
      return true;
    }

    // 上传期间其他请求可能已经发布；签名和 link 前必须重新读取索引，避免重复序列与丢失更新。
    const currentReleases = loadReleases(ctx);
    if (currentReleases.some((release) => release.manifest.version === version)) {
      unlinkSync(temporary);
      sendError(res, 409, "VERSION_EXISTS", `客户端版本 ${version} 已发布，禁止覆盖`);
      return true;
    }
    const currentLatestInChannel = currentReleases.find(
      (release) => release.manifest.channel === channelValue,
    );
    if (currentLatestInChannel && compareClientVersions(version, currentLatestInChannel.manifest.version) <= 0) {
      unlinkSync(temporary);
      sendError(res, 409, "VERSION_ROLLBACK", `新版本必须高于 ${currentLatestInChannel.manifest.version}`);
      return true;
    }

    const uploadedAt = new Date().toISOString();
    const manifest: ClientUpdateManifest = {
      schema_version: CLIENT_UPDATE_SCHEMA,
      sequence: (currentReleases[0]?.manifest.sequence ?? 0) + 1,
      version,
      channel: channelValue,
      platform: "win32",
      arch: "x64",
      filename,
      size,
      sha256: hash.digest("hex"),
      url_path: `/downloads/${filename}`,
      published_at: uploadedAt,
      rollback_data_strategy: "snapshot_required",
      rollout: {
        status: "paused",
        basis_points: 0,
        seed: randomBytes(32).toString("hex"),
        updated_at: uploadedAt,
      },
    };
    const record: ClientReleaseRecord = {
      manifest,
      signature_key_id: ctx.signingKey.keyId,
      signature: signClientUpdateManifest(manifest, ctx.signingKey.privateKeyPem),
      uploaded_by: identity.actor,
      uploaded_at: uploadedAt,
      rollout_updated_by: identity.actor,
      rollout_updated_at: uploadedAt,
    };
    let targetLinked = false;
    try {
      // nginx 以非 root 用户读取共享下载目录；临时文件在发布前保持私有，
      // 建立公开硬链接前再固定为只读可分发权限。
      chmodSync(temporary, 0o644);
      linkSync(temporary, target);
      targetLinked = true;
      unlinkSync(temporary);
      saveReleases(ctx.releaseDir, [record, ...currentReleases]);
    } catch (error) {
      if (existsSync(temporary)) unlinkSync(temporary);
      if (targetLinked && existsSync(target)) unlinkSync(target);
      sendError(res, 500, "PUBLISH_FAILED", error instanceof Error ? error.message : "发布失败");
      return true;
    }
    await ctx.admin.store.appendAudit(identity.actor, "client_release.upload", {
      version,
      channel: channelValue,
      filename,
      size,
      sha256: manifest.sha256,
      sequence: manifest.sequence,
      signature_key_id: record.signature_key_id,
    });
    ctx.admin.logger.info("client_release.uploaded", {
      version,
      channel: channelValue,
      size,
      sequence: manifest.sequence,
      signature_key_id: record.signature_key_id,
    });
    sendJson(res, 201, { release: adminView(record) });
    return true;
  }

  return false;
}
