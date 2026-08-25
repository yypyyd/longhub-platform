import { createHash, randomBytes, randomUUID, sign as signBytes, verify as verifyBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { requireAdmin, type AdminRouteContext } from "./admin-routes.js";
import { sendError, sendJson } from "./http-util.js";
import type { SigningKey } from "./server.js";

export type ArtifactSurface = "cloud-plugin" | "cloud-cli";

interface ArtifactManifest {
  schema_version: string;
  product_surface: string;
  sequence: number;
  version: string;
  channel: "stable" | "beta";
  platform: "win32";
  arch: "x64";
  filename: string;
  size: number;
  sha256: string;
  url_path: string;
  published_at: string;
  compatibility: { openclaw_version: string; node: string };
  rollout: { status: "active" | "paused"; basis_points: number; seed: string; updated_at: string };
  signature_key_id: string;
  signature: string;
}

interface ArtifactRecord {
  manifest: ArtifactManifest;
  uploaded_by: string;
  uploaded_at: string;
  rollout_updated_by: string;
  rollout_updated_at: string;
  withdrawn_by?: string;
  withdrawn_at?: string;
}

export interface CloudArtifactReleaseContext {
  admin: AdminRouteContext;
  releaseDir: string;
  signingKey: SigningKey;
  surface: ArtifactSurface;
}

const MAX_UPLOAD_BYTES = 128 * 1024 * 1024;

function schema(surface: ArtifactSurface): string { return surface === "cloud-plugin" ? "longhub/cloud-plugin-release/v1" : "longhub/cloud-cli-release/v1"; }
function product(surface: ArtifactSurface): string { return surface === "cloud-plugin" ? "longhub-cloud-plugin" : "longhub-cloud-cli"; }
function publicPrefix(surface: ArtifactSurface): string { return surface === "cloud-plugin" ? "/v1/cloud-plugin-releases" : "/v1/cloud-cli-releases"; }
function adminPrefix(surface: ArtifactSurface): string { return surface === "cloud-plugin" ? "/v1/admin/cloud-plugin-releases" : "/v1/admin/cloud-cli-releases"; }
function downloadPrefix(surface: ArtifactSurface): string { return surface === "cloud-plugin" ? "/downloads/cloud-plugin/" : "/downloads/cloud-cli/"; }
function filenameFor(surface: ArtifactSurface, version: string): string { return surface === "cloud-plugin" ? "longhub-openclaw-cloud-plugin-" + version + ".tgz" : "longhub-cloud-cli-" + version + ".tgz"; }
function indexPath(ctx: CloudArtifactReleaseContext): string { return join(ctx.releaseDir, "releases.json"); }
function escapePath(value: string): string { return value.replaceAll("/", "\\/"); }

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + canonicalize(record[key])).join(",") + "}";
}

function signedPayload(manifest: ArtifactManifest): string {
  const unsigned = { ...manifest } as Record<string, unknown>;
  delete unsigned.signature;
  return canonicalize(unsigned);
}

function signManifest(manifest: ArtifactManifest, key: SigningKey): string {
  return signBytes(null, Buffer.from(signedPayload(manifest), "utf8"), key.privateKeyPem).toString("base64");
}

function validSignature(value: string): boolean {
  return /^[A-Za-z0-9+/]{86}==$/.test(value) && Buffer.from(value, "base64").length === 64;
}

function load(ctx: CloudArtifactReleaseContext): ArtifactRecord[] {
  const file = indexPath(ctx);
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error("release index must be an array");
  return parsed.filter((item): item is ArtifactRecord => {
    if (!item || typeof item !== "object") return false;
    const record = item as Partial<ArtifactRecord>;
    const manifest = record.manifest as Partial<ArtifactManifest> | undefined;
    return Boolean(manifest && manifest.schema_version === schema(ctx.surface) && manifest.product_surface === product(ctx.surface) &&
      typeof manifest.signature_key_id === "string" && typeof manifest.signature === "string" && validSignature(manifest.signature) &&
      verifyBytes(null, Buffer.from(signedPayload(manifest as ArtifactManifest), "utf8"), ctx.signingKey.publicKeyPem, Buffer.from(manifest.signature, "base64")));
  }).sort((left, right) => right.manifest.sequence - left.manifest.sequence);
}

function save(ctx: CloudArtifactReleaseContext, records: ArtifactRecord[]): void {
  mkdirSync(ctx.releaseDir, { recursive: true });
  const target = indexPath(ctx);
  const temporary = target + "." + randomUUID() + ".tmp";
  writeFileSync(temporary, JSON.stringify(records, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, target);
}

function adminView(record: ArtifactRecord): ArtifactRecord & { url: string } { return { ...record, url: record.manifest.url_path }; }

async function rolloutBody(req: IncomingMessage, res: ServerResponse): Promise<{ status: "active" | "paused"; basis_points: number } | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
  const bodyBytes = Buffer.concat(chunks);
  if (bodyBytes.length > 16 * 1024) { sendError(res, 413, "PAYLOAD_TOO_LARGE", "灰度策略请求体过大"); return undefined; }
  let parsed: unknown;
  try { parsed = JSON.parse(bodyBytes.toString("utf8")); } catch { sendError(res, 400, "INVALID_JSON", "请求体不是合法 JSON"); return undefined; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { sendError(res, 422, "VALIDATION_FAILED", "灰度策略字段无效"); return undefined; }
  const body = parsed as Record<string, unknown>;
  if ((body.status !== "active" && body.status !== "paused") || !Number.isInteger(body.basis_points) || Number(body.basis_points) < 0 || Number(body.basis_points) > 10_000 || (body.status === "active" && body.basis_points === 0)) {
    sendError(res, 422, "VALIDATION_FAILED", "灰度比例无效"); return undefined;
  }
  return { status: body.status, basis_points: Number(body.basis_points) };
}

export async function handleCloudArtifactReleaseRoutes(ctx: CloudArtifactReleaseContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const publicRoot = publicPrefix(ctx.surface);
  const adminRoot = adminPrefix(ctx.surface);
  const downloadRoot = downloadPrefix(ctx.surface);
  if (req.method === "GET" && url.pathname === publicRoot + "/signing-key") {
    sendJson(res, 200, { purpose: "longhub-" + ctx.surface + "-release-v1", key_id: ctx.signingKey.keyId, public_key_pem: ctx.signingKey.publicKeyPem });
    return true;
  }
  if (req.method === "GET" && url.pathname === publicRoot + "/latest") {
    const channel = url.searchParams.get("channel") ?? "stable";
    if (channel !== "stable" && channel !== "beta") { sendError(res, 422, "INVALID_CHANNEL", "channel 无效"); return true; }
    const found = load(ctx).find((record) => !record.withdrawn_at && record.manifest.channel === channel &&
      record.manifest.rollout.status === "active" && record.manifest.rollout.basis_points > 0);
    sendJson(res, 200, { release: found?.manifest ?? null });
    return true;
  }
  const versionMatch = new RegExp("^" + escapePath(publicRoot) + "/versions/([^/]+)$").exec(url.pathname);
  if (req.method === "GET" && versionMatch) {
    const version = decodeURIComponent(versionMatch[1]!);
    const found = load(ctx).find((record) => record.manifest.version === version);
    if (!found) sendError(res, 404, "RELEASE_NOT_FOUND", "指定版本不存在");
    else if (found.withdrawn_at) sendError(res, 410, "RELEASE_WITHDRAWN", "指定版本已撤回");
    else sendJson(res, 200, { release: found.manifest });
    return true;
  }
  if (req.method === "GET" && url.pathname.startsWith(downloadRoot)) {
    const filename = basename(url.pathname);
    const found = load(ctx).find((record) => record.manifest.filename === filename);
    const path = join(ctx.releaseDir, filename);
    if (!found || !existsSync(path)) { sendError(res, 404, "RELEASE_NOT_FOUND", "制品不存在"); return true; }
    if (found.withdrawn_at) { sendError(res, 410, "RELEASE_WITHDRAWN", "制品已撤回"); return true; }
    res.writeHead(200, { "content-type": "application/gzip", "cache-control": "public, max-age=300", "content-length": String(found.manifest.size) });
    createReadStream(path).pipe(res);
    return true;
  }
  if (req.method === "GET" && url.pathname === adminRoot) {
    const identity = await requireAdmin(ctx.admin, req, res, { write: false });
    if (!identity) return true;
    sendJson(res, 200, { releases: load(ctx).map(adminView) });
    return true;
  }
  const rolloutMatch = new RegExp("^" + escapePath(adminRoot) + "/([^/]+)/rollout$").exec(url.pathname);
  if (req.method === "PATCH" && rolloutMatch) {
    const identity = await requireAdmin(ctx.admin, req, res, { write: true });
    if (!identity) return true;
    const version = decodeURIComponent(rolloutMatch[1]!);
    const policy = await rolloutBody(req, res);
    if (!policy) return true;
    const records = load(ctx);
    const existing = records.find((record) => record.manifest.version === version);
    if (!existing) { sendError(res, 404, "RELEASE_NOT_FOUND", "版本不存在"); return true; }
    if (existing.withdrawn_at) { sendError(res, 410, "RELEASE_WITHDRAWN", "版本已撤回"); return true; }
    const latest = records.find((record) => record.manifest.channel === existing.manifest.channel);
    if (latest?.manifest.version !== version) { sendError(res, 409, "ROLLOUT_NOT_LATEST", "只能调整最新版本"); return true; }
    const updatedAt = new Date().toISOString();
    const manifest: ArtifactManifest = { ...existing.manifest, sequence: (records[0]?.manifest.sequence ?? 0) + 1, rollout: { ...existing.manifest.rollout, ...policy, updated_at: updatedAt } };
    manifest.signature = signManifest(manifest, ctx.signingKey);
    const updated: ArtifactRecord = { ...existing, manifest, rollout_updated_by: identity.actor, rollout_updated_at: updatedAt };
    save(ctx, [updated, ...records.filter((record) => record !== existing)]);
    await ctx.admin.store.appendAudit(identity.actor, ctx.surface + ".release.rollout", { version, status: policy.status, basis_points: policy.basis_points });
    sendJson(res, 200, { release: adminView(updated) });
    return true;
  }
  const withdrawMatch = new RegExp("^" + escapePath(adminRoot) + "/([^/]+)$").exec(url.pathname);
  if (req.method === "DELETE" && withdrawMatch) {
    const identity = await requireAdmin(ctx.admin, req, res, { write: true });
    if (!identity) return true;
    const version = decodeURIComponent(withdrawMatch[1]!);
    const records = load(ctx);
    const existing = records.find((record) => record.manifest.version === version);
    if (!existing) { sendError(res, 404, "RELEASE_NOT_FOUND", "版本不存在"); return true; }
    if (existing.withdrawn_at) { sendError(res, 409, "RELEASE_ALREADY_WITHDRAWN", "版本已撤回"); return true; }
    const withdrawnAt = new Date().toISOString();
    const withdrawn: ArtifactRecord = { ...existing, withdrawn_by: identity.actor, withdrawn_at: withdrawnAt };
    save(ctx, [withdrawn, ...records.filter((record) => record !== existing)]);
    await ctx.admin.store.appendAudit(identity.actor, ctx.surface + ".release.withdraw", { version, withdrawn_at: withdrawnAt });
    sendJson(res, 200, { release: adminView(withdrawn) });
    return true;
  }
  if (req.method === "POST" && url.pathname === adminRoot) {
    const identity = await requireAdmin(ctx.admin, req, res, { write: true });
    if (!identity) return true;
    const version = url.searchParams.get("version")?.trim() ?? "";
    const rawFilename = url.searchParams.get("filename")?.trim() ?? "";
    const channel = url.searchParams.get("channel") ?? "stable";
    const filename = basename(rawFilename);
    if (!/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(version) || rawFilename !== filename || filename !== filenameFor(ctx.surface, version)) {
      sendError(res, 422, "VALIDATION_FAILED", "release version 或文件名无效"); return true;
    }
    if (channel !== "stable" && channel !== "beta") { sendError(res, 422, "INVALID_CHANNEL", "channel 无效"); return true; }
    const records = load(ctx);
    if (records.some((record) => record.manifest.version === version)) { sendError(res, 409, "VERSION_EXISTS", "版本不可覆盖"); return true; }
    const declared = req.headers["content-length"] === undefined ? undefined : Number(req.headers["content-length"]);
    if (declared !== undefined && (!Number.isSafeInteger(declared) || declared <= 0 || declared > MAX_UPLOAD_BYTES)) { sendError(res, 413, "PAYLOAD_TOO_LARGE", "制品大小无效"); return true; }
    mkdirSync(ctx.releaseDir, { recursive: true, mode: 0o750 });
    const temporary = join(ctx.releaseDir, "." + filename + "." + randomUUID() + ".upload");
    const target = join(ctx.releaseDir, filename);
    const hash = createHash("sha256"); let size = 0; let tooLarge = false;
    const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) { size += chunk.length; if (size > MAX_UPLOAD_BYTES) { tooLarge = true; callback(new Error("PAYLOAD_TOO_LARGE")); return; } hash.update(chunk); callback(null, chunk); } });
    try { await pipeline(req, meter, createWriteStream(temporary, { flags: "wx", mode: 0o640 })); }
    catch { if (existsSync(temporary)) unlinkSync(temporary); sendError(res, tooLarge ? 413 : 500, tooLarge ? "PAYLOAD_TOO_LARGE" : "UPLOAD_FAILED", "制品上传失败"); return true; }
    if (size <= 0 || (declared !== undefined && size !== declared) || existsSync(target)) { if (existsSync(temporary)) unlinkSync(temporary); sendError(res, existsSync(target) ? 409 : 400, existsSync(target) ? "ARTIFACT_EXISTS" : "UPLOAD_SIZE_MISMATCH", "制品大小或文件冲突"); return true; }
    const now = new Date().toISOString();
    const manifest: ArtifactManifest = {
      schema_version: schema(ctx.surface), product_surface: product(ctx.surface), sequence: (records[0]?.manifest.sequence ?? 0) + 1,
      version, channel, platform: "win32", arch: "x64", filename, size, sha256: hash.digest("hex"),
      url_path: downloadPrefix(ctx.surface) + filename, published_at: now,
      compatibility: { openclaw_version: "2026.7.1-2", node: ">=20" },
      rollout: { status: "paused", basis_points: 0, seed: randomBytes(32).toString("hex"), updated_at: now },
      signature_key_id: ctx.signingKey.keyId, signature: "",
    };
    manifest.signature = signManifest(manifest, ctx.signingKey);
    const record: ArtifactRecord = { manifest, uploaded_by: identity.actor, uploaded_at: now, rollout_updated_by: identity.actor, rollout_updated_at: now };
    try { linkSync(temporary, target); unlinkSync(temporary); save(ctx, [record, ...records]); }
    catch { if (existsSync(temporary)) unlinkSync(temporary); if (existsSync(target)) unlinkSync(target); sendError(res, 500, "PUBLISH_FAILED", "制品发布失败"); return true; }
    await ctx.admin.store.appendAudit(identity.actor, ctx.surface + ".release.upload", { version, filename, size, sha256: manifest.sha256 });
    sendJson(res, 201, { release: adminView(record) });
    return true;
  }
  return false;
}
