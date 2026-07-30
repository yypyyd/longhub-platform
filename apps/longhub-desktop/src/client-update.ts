import { createHash, createPublicKey, randomUUID } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import {
  canonicalStringify,
  compareClientVersions,
  isClientUpdateRolloutEligible,
  verifyClientUpdateMetadata,
  type ClientUpdateManifest,
  type SignedClientUpdateMetadata,
} from "@longhub/pack-schema";

interface UpdateStateEntry {
  sequence: number;
  metadata_sha256: string;
}

interface UpdateState {
  schema_version: "longhub/client-update-state/v1";
  channels: Partial<Record<ClientUpdateManifest["channel"], UpdateStateEntry>>;
}

export interface ClientUpdateVerifierOptions {
  cloudBaseUrl: string;
  currentVersion: string;
  channel: ClientUpdateManifest["channel"];
  rolloutIdentity: string;
  trustedKeys: ReadonlyMap<string, string>;
  stateFile: string;
  rollbackRecordFile?: string;
  fetchImpl?: typeof fetch;
}

export interface TrustedClientUpdate {
  action: "none" | "update_available";
  reason?: "no_release" | "paused" | "not_in_rollout" | "current" | "rollback_blocked";
  metadata?: SignedClientUpdateMetadata;
  artifactUrl?: string;
}

export interface ClientUpdateTrustPolicy {
  schema_version: "longhub/client-update-trust/v1";
  status: "pending" | "approved";
  channel: ClientUpdateManifest["channel"];
  expected_signer_subject: string | null;
  approved_by: string | null;
  approved_at: string | null;
  trustedKeys: ReadonlyMap<string, string>;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...expected].sort().join("|");
}

/** 读取构建时随安装包预置的更新信任清单；正式模式要求审批、签名主体和至少一个 Ed25519 公钥。 */
export function loadClientUpdateTrustPolicy(path: string, requireApproved = false): ClientUpdateTrustPolicy {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (
    typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
    !exactKeys(parsed, [
      "schema_version", "status", "channel", "expected_signer_subject",
      "approved_by", "approved_at", "keys",
    ])
  ) throw new Error("客户端更新信任清单格式无效");
  const raw = parsed as Record<string, unknown>;
  if (
    raw.schema_version !== "longhub/client-update-trust/v1" ||
    (raw.status !== "pending" && raw.status !== "approved") ||
    (raw.channel !== "stable" && raw.channel !== "beta") ||
    !Array.isArray(raw.keys) || raw.keys.length > 32
  ) throw new Error("客户端更新信任清单字段无效");
  const trustedKeys = new Map<string, string>();
  for (const item of raw.keys) {
    if (
      typeof item !== "object" || item === null || Array.isArray(item) ||
      !exactKeys(item, ["key_id", "public_key_pem"])
    ) throw new Error("客户端更新信任公钥记录无效");
    const entry = item as Record<string, unknown>;
    if (
      typeof entry.key_id !== "string" || !/^[a-zA-Z0-9._-]{1,128}$/.test(entry.key_id) ||
      typeof entry.public_key_pem !== "string" || entry.public_key_pem.includes("PRIVATE KEY") ||
      trustedKeys.has(entry.key_id)
    ) throw new Error("客户端更新信任公钥字段无效");
    let publicKey;
    try {
      publicKey = createPublicKey(entry.public_key_pem);
    } catch {
      throw new Error(`客户端更新公钥 PEM 无效: ${entry.key_id}`);
    }
    if (publicKey.asymmetricKeyType !== "ed25519") {
      throw new Error(`客户端更新公钥必须是 Ed25519: ${entry.key_id}`);
    }
    trustedKeys.set(entry.key_id, publicKey.export({ type: "spki", format: "pem" }).toString());
  }
  const expectedSigner = raw.expected_signer_subject;
  const approvedBy = raw.approved_by;
  const approvedAt = raw.approved_at;
  if (
    (expectedSigner !== null && (typeof expectedSigner !== "string" || !expectedSigner.trim())) ||
    (approvedBy !== null && (typeof approvedBy !== "string" || !approvedBy.trim())) ||
    (approvedAt !== null && (typeof approvedAt !== "string" || !Number.isFinite(Date.parse(approvedAt))))
  ) throw new Error("客户端更新信任清单审批字段无效");
  const approvedFieldsComplete = trustedKeys.size > 0 &&
    typeof expectedSigner === "string" && typeof approvedBy === "string" && typeof approvedAt === "string";
  if (raw.status === "approved" && !approvedFieldsComplete) {
    throw new Error("已审批的客户端更新信任清单字段不完整");
  }
  if (requireApproved && raw.status !== "approved") {
    throw new Error("正式发布必须提供审批通过的 Update 公钥和 Authenticode 签名主体");
  }
  return {
    schema_version: "longhub/client-update-trust/v1",
    status: raw.status,
    channel: raw.channel,
    expected_signer_subject: expectedSigner as string | null,
    approved_by: approvedBy as string | null,
    approved_at: approvedAt as string | null,
    trustedKeys,
  };
}

function cloudOrigin(input: string): string {
  const url = new URL(input);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("客户端更新服务必须使用 HTTPS（本机测试除外）");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("客户端更新 Cloud URL 格式无效");
  return url.origin;
}

function metadataSha256(metadata: SignedClientUpdateMetadata): string {
  return createHash("sha256").update(canonicalStringify(metadata), "utf8").digest("hex");
}

function loadState(path: string): UpdateState {
  if (!existsSync(path)) return { schema_version: "longhub/client-update-state/v1", channels: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<UpdateState>;
  if (
    Object.keys(parsed).sort().join("|") !== "channels|schema_version" ||
    parsed.schema_version !== "longhub/client-update-state/v1" ||
    typeof parsed.channels !== "object" || parsed.channels === null || Array.isArray(parsed.channels)
  ) throw new Error("客户端更新防回滚状态损坏");
  for (const [channel, entry] of Object.entries(parsed.channels)) {
    if (
      (channel !== "stable" && channel !== "beta") ||
      typeof entry !== "object" || entry === null ||
      Object.keys(entry).sort().join("|") !== "metadata_sha256|sequence" ||
      !Number.isSafeInteger((entry as UpdateStateEntry).sequence) || (entry as UpdateStateEntry).sequence <= 0 ||
      !/^[a-f0-9]{64}$/.test((entry as UpdateStateEntry).metadata_sha256)
    ) throw new Error("客户端更新防回滚状态无效");
  }
  return parsed as UpdateState;
}

function saveState(path: string, state: UpdateState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function blockedRollbackVersion(path: string | undefined): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (
    typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
    !exactKeys(parsed, [
      "schema_version", "previous_version", "target_version", "sequence",
      "attempts", "reason", "rolled_back_at", "failed_state_path", "snapshot_path",
    ])
  ) throw new Error("客户端更新回滚记录损坏");
  const value = parsed as Record<string, unknown>;
  if (
    value.schema_version !== "longhub/client-update-last-rollback/v1" ||
    typeof value.previous_version !== "string" || typeof value.target_version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(value.previous_version) || !/^\d+\.\d+\.\d+$/.test(value.target_version) ||
    !Number.isSafeInteger(value.sequence) || (value.sequence as number) <= 0 ||
    !Number.isSafeInteger(value.attempts) || (value.attempts as number) < 1 ||
    typeof value.reason !== "string" || !value.reason ||
    typeof value.rolled_back_at !== "string" || !Number.isFinite(Date.parse(value.rolled_back_at)) ||
    typeof value.failed_state_path !== "string" || typeof value.snapshot_path !== "string"
  ) throw new Error("客户端更新回滚记录无效");
  return value.target_version;
}

/** 只接受预置公钥签名且序列未回退的客户端更新元数据；本类不执行安装。 */
export class ClientUpdateVerifier {
  constructor(private readonly options: ClientUpdateVerifierOptions) {}

  /** 获取指定历史版本的签名制品信息；不应用 rollout，也不降低本地最高 sequence。 */
  async fetchVersion(version: string): Promise<Required<Pick<TrustedClientUpdate, "metadata" | "artifactUrl">>> {
    compareClientVersions(version, version);
    if (this.options.trustedKeys.size === 0) throw new Error("客户端没有预置更新签名公钥");
    const origin = cloudOrigin(this.options.cloudBaseUrl);
    const endpoint = `/v1/client-releases/versions/${encodeURIComponent(version)}` +
      `?channel=${encodeURIComponent(this.options.channel)}`;
    const response = await (this.options.fetchImpl ?? fetch)(
      `${origin}${endpoint}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!response.ok) throw new Error(`获取当前版本回滚元数据失败 [${response.status}]`);
    const body = await response.json() as unknown;
    if (
      typeof body !== "object" || body === null || Array.isArray(body) ||
      Object.keys(body).sort().join("|") !== "release"
    ) throw new Error("当前版本回滚元数据响应格式无效");
    const release = (body as { release?: unknown }).release;
    if (!verifyClientUpdateMetadata(release, this.options.trustedKeys)) {
      throw new Error("当前版本回滚元数据签名无效或密钥不受信任");
    }
    if (
      release.manifest.version !== version || release.manifest.channel !== this.options.channel ||
      release.manifest.platform !== "win32" || release.manifest.arch !== "x64"
    ) throw new Error("当前版本回滚元数据与请求版本、渠道或平台不匹配");
    const artifactUrl = new URL(release.manifest.url_path, `${origin}/`);
    if (artifactUrl.origin !== origin || artifactUrl.pathname !== release.manifest.url_path) {
      throw new Error("客户端回滚安装器下载地址必须与 Cloud 同源");
    }
    return { metadata: release, artifactUrl: artifactUrl.toString() };
  }

  async check(): Promise<TrustedClientUpdate> {
    if (this.options.trustedKeys.size === 0) throw new Error("客户端没有预置更新签名公钥");
    const origin = cloudOrigin(this.options.cloudBaseUrl);
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(
      `${origin}/v1/client-releases/latest?channel=${encodeURIComponent(this.options.channel)}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!response.ok) throw new Error(`获取客户端更新元数据失败 [${response.status}]`);
    const body = await response.json() as unknown;
    if (
      typeof body !== "object" || body === null || Array.isArray(body) ||
      Object.keys(body).sort().join("|") !== "release"
    ) throw new Error("客户端更新响应格式无效");
    const release = (body as { release?: unknown }).release;
    if (release === null) return { action: "none", reason: "no_release" };
    if (!verifyClientUpdateMetadata(release, this.options.trustedKeys)) {
      throw new Error("客户端更新元数据签名无效或密钥不受信任");
    }
    if (
      release.manifest.channel !== this.options.channel ||
      release.manifest.platform !== "win32" ||
      release.manifest.arch !== "x64"
    ) throw new Error("客户端更新元数据与当前渠道或平台不匹配");

    const state = loadState(this.options.stateFile);
    const previous = state.channels[this.options.channel];
    const currentDigest = metadataSha256(release);
    if (previous && release.manifest.sequence < previous.sequence) {
      throw new Error(`客户端更新序列回退: ${release.manifest.sequence} < ${previous.sequence}`);
    }
    if (
      previous && release.manifest.sequence === previous.sequence &&
      currentDigest !== previous.metadata_sha256
    ) throw new Error("客户端更新同一序列出现不同签名元数据");

    const artifactUrl = new URL(release.manifest.url_path, `${origin}/`);
    if (artifactUrl.origin !== origin || artifactUrl.pathname !== release.manifest.url_path) {
      throw new Error("客户端更新下载地址必须与 Cloud 同源");
    }
    if (!previous || release.manifest.sequence > previous.sequence) {
      state.channels[this.options.channel] = {
        sequence: release.manifest.sequence,
        metadata_sha256: currentDigest,
      };
      saveState(this.options.stateFile, state);
    }
    if (blockedRollbackVersion(this.options.rollbackRecordFile) === release.manifest.version) {
      return { action: "none", reason: "rollback_blocked", metadata: release, artifactUrl: artifactUrl.toString() };
    }
    if (release.manifest.rollout.status === "paused") {
      return { action: "none", reason: "paused", metadata: release, artifactUrl: artifactUrl.toString() };
    }
    if (!isClientUpdateRolloutEligible(release.manifest.rollout, this.options.rolloutIdentity)) {
      return { action: "none", reason: "not_in_rollout", metadata: release, artifactUrl: artifactUrl.toString() };
    }
    return compareClientVersions(release.manifest.version, this.options.currentVersion) > 0
      ? { action: "update_available", metadata: release, artifactUrl: artifactUrl.toString() }
      : { action: "none", reason: "current", metadata: release, artifactUrl: artifactUrl.toString() };
  }
}

/** 下载后、执行安装前流式验证制品大小和签名元数据绑定的 SHA-256。 */
export async function verifyDownloadedClientUpdate(
  path: string,
  manifest: ClientUpdateManifest,
): Promise<void> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    const data = chunk as Buffer;
    size += data.length;
    if (size > manifest.size) throw new Error("客户端更新文件大小超过签名元数据");
    hash.update(data);
  }
  if (size !== manifest.size) throw new Error("客户端更新文件大小与签名元数据不一致");
  if (hash.digest("hex") !== manifest.sha256) throw new Error("客户端更新文件 SHA-256 与签名元数据不一致");
}

/** 下载到版本化暂存目录；拒绝重定向、超长响应和目标覆盖，返回前完成摘要验证。 */
export async function downloadTrustedClientUpdate(options: {
  metadata: SignedClientUpdateMetadata;
  artifactUrl: string;
  directory: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const { manifest } = options.metadata;
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(options.directory);
  if (
    !directoryStat.isDirectory() || directoryStat.isSymbolicLink() ||
    realpathSync.native(options.directory).toLowerCase() !== resolve(options.directory).toLowerCase()
  ) {
    throw new Error("客户端更新下载目录包含符号链接或异常条目");
  }
  const target = join(options.directory, manifest.filename);
  if (existsSync(target)) {
    const targetStat = lstatSync(target);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
      throw new Error("客户端更新缓存包含符号链接或异常条目");
    }
    await verifyDownloadedClientUpdate(target, manifest);
    return target;
  }
  const temporary = join(options.directory, `.${manifest.filename}.${randomUUID()}.download`);
  const response = await (options.fetchImpl ?? fetch)(options.artifactUrl, {
    redirect: "error",
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!response.ok || !response.body) throw new Error(`下载客户端更新失败 [${response.status}]`);
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) !== manifest.size) {
    throw new Error("客户端下载 Content-Length 与签名元数据不一致");
  }
  const output = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
  let size = 0;
  try {
    await once(output, "open");
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      const data = Buffer.from(chunk);
      size += data.length;
      if (size > manifest.size) throw new Error("客户端更新下载大小超过签名元数据");
      if (!output.write(data)) await once(output, "drain");
    }
    output.end();
    await finished(output);
    await verifyDownloadedClientUpdate(temporary, manifest);
    linkSync(temporary, target);
    unlinkSync(temporary);
    return target;
  } catch (error) {
    await new Promise<void>((resolveClosed) => {
      if (output.closed) {
        resolveClosed();
        return;
      }
      output.once("close", resolveClosed);
      output.destroy();
    });
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}
