/**
 * 客户端安装包分发：
 * - 公开：GET /v1/client-releases/latest（官网下载页展示最新版本）
 * - 管理：GET /v1/admin/client-releases（列表）、
 *         POST /v1/admin/client-releases?version=&filename=（上传安装包，二进制流）
 * 安装包与元数据存放于 CLIENT_RELEASE_DIR（由 nginx 以 /downloads/ 静态提供下载）。
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { requireAdmin, type AdminRouteContext } from "./admin-routes.js";
import { sendError, sendJson } from "./http-util.js";

export interface ClientReleaseRecord {
  version: string;
  filename: string;
  size: number;
  uploaded_by: string;
  uploaded_at: string;
}

export interface ClientReleaseContext {
  admin: AdminRouteContext;
  releaseDir: string;
}

const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

function metaFile(dir: string): string {
  return join(dir, "releases.json");
}

function loadReleases(dir: string): ClientReleaseRecord[] {
  const file = metaFile(dir);
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, "utf-8")) as ClientReleaseRecord[];
}

function saveReleases(dir: string, releases: ClientReleaseRecord[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(metaFile(dir), JSON.stringify(releases, null, 2), "utf-8");
}

function withUrl(record: ClientReleaseRecord): ClientReleaseRecord & { url: string } {
  return { ...record, url: `/downloads/${record.filename}` };
}

/** 返回 true 表示本模块已处理该请求 */
export async function handleClientReleaseRoutes(
  ctx: ClientReleaseContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  // 公开：最新版本
  if (req.method === "GET" && url.pathname === "/v1/client-releases/latest") {
    const releases = loadReleases(ctx.releaseDir);
    const latest = releases[0];
    sendJson(res, 200, { release: latest ? withUrl(latest) : null });
    return true;
  }

  // 管理：版本列表
  if (req.method === "GET" && url.pathname === "/v1/admin/client-releases") {
    const identity = await requireAdmin(ctx.admin, req, res, { write: false });
    if (!identity) return true;
    sendJson(res, 200, { releases: loadReleases(ctx.releaseDir).map(withUrl) });
    return true;
  }

  // 管理：上传安装包（请求体为安装包二进制）
  if (req.method === "POST" && url.pathname === "/v1/admin/client-releases") {
    const identity = await requireAdmin(ctx.admin, req, res, { write: true });
    if (!identity) return true;
    const version = url.searchParams.get("version")?.trim() ?? "";
    const rawName = url.searchParams.get("filename")?.trim() ?? "";
    const filename = basename(rawName);
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      sendError(res, 422, "VALIDATION_FAILED", "version 需为 x.y.z 形式");
      return true;
    }
    if (!/^[\w.-]+\.exe$/i.test(filename)) {
      sendError(res, 422, "VALIDATION_FAILED", "filename 需为 .exe 文件名");
      return true;
    }
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > MAX_UPLOAD_BYTES) {
      sendError(res, 413, "PAYLOAD_TOO_LARGE", "安装包超过大小上限");
      return true;
    }
    mkdirSync(ctx.releaseDir, { recursive: true });
    const target = join(ctx.releaseDir, filename);
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
    });
    try {
      await pipeline(req, createWriteStream(target));
    } catch (err) {
      sendError(res, 500, "UPLOAD_FAILED", err instanceof Error ? err.message : String(err));
      return true;
    }
    const record: ClientReleaseRecord = {
      version,
      filename,
      size,
      uploaded_by: identity.actor,
      uploaded_at: new Date().toISOString(),
    };
    const releases = [record, ...loadReleases(ctx.releaseDir).filter((r) => r.version !== version)];
    saveReleases(ctx.releaseDir, releases);
    await ctx.admin.store.appendAudit(identity.actor, "client_release.upload", { version, filename, size });
    ctx.admin.logger.info("client_release.uploaded", { version, filename, size });
    sendJson(res, 201, { release: withUrl(record) });
    return true;
  }

  return false;
}
