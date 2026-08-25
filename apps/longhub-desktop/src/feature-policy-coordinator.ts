import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  FEATURE_POLICY_MAX_BYTES,
  FEATURE_POLICY_MAX_VALIDITY_MS,
  FEATURE_POLICY_REFRESH_INTERVAL_MS,
  FeaturePolicyValidationError,
  decideFeatureAccess,
  parseFeaturePolicyJson,
  resolveFeaturePolicy,
  type FeatureAccessDenialReason,
  type FeatureId,
  type FeaturePolicyAudience,
  type FeaturePolicyDocument,
  type FeaturePolicyScope,
  type ResolvedFeaturePolicy,
} from "@longhub/feature-policy";

const CACHE_SCHEMA = "longhub/feature-policy-cache/v1" as const;
const CACHE_MAX_BYTES = FEATURE_POLICY_MAX_BYTES + 8 * 1024;
const ETAG_PATTERN = /^(?:W\/)?"[\x21\x23-\x7e]{1,256}"$/;

type TargetedScope = Exclude<FeaturePolicyScope, "global">;
type PolicySource = "network" | "cache";

interface FeaturePolicyCacheRecord {
  readonly schema_version: typeof CACHE_SCHEMA;
  readonly cloud_origin: string;
  readonly device_id: string;
  readonly etag: string;
  readonly cached_at: string;
  readonly document: FeaturePolicyDocument;
}

export interface FeaturePolicySnapshot {
  readonly document: FeaturePolicyDocument;
  readonly source: PolicySource;
  readonly refreshed_at: string;
}

export type LocalFeaturePolicyDenialReason =
  | FeatureAccessDenialReason
  | "POLICY_UNAVAILABLE"
  | "POLICY_OFFLINE";

export type LocalFeaturePolicyDecision =
  | {
      readonly allowed: true;
      readonly source: PolicySource;
      readonly policy: ResolvedFeaturePolicy;
    }
  | {
      readonly allowed: false;
      readonly reason: LocalFeaturePolicyDenialReason;
      readonly source?: PolicySource;
      readonly policy?: ResolvedFeaturePolicy;
      readonly missing?: readonly string[];
    };

export interface FeaturePolicyDecisionContext {
  readonly agentId?: string;
  readonly entitlements?: readonly string[];
  readonly permissions?: readonly string[];
}

export interface FeaturePolicyCoordinatorOptions {
  readonly cloudBaseUrl: string;
  readonly deviceId: string;
  readonly deviceToken: string;
  readonly desktopVersion: string;
  readonly cacheFile: string;
  readonly audience?: FeaturePolicyAudience;
  readonly scopeIds?: Readonly<Partial<Record<TargetedScope, string | readonly string[]>>>;
  readonly entitlements?: readonly string[];
  readonly permissions?: readonly string[];
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly refreshIntervalMs?: number;
  readonly requestTimeoutMs?: number;
  readonly onEmergencyDisabled?: (featureIds: readonly FeatureId[]) => void;
  readonly onRefresh?: (snapshot: FeaturePolicySnapshot) => void;
  readonly onError?: (error: FeaturePolicyCoordinatorError) => void;
}

export class FeaturePolicyCoordinatorError extends Error {
  readonly code = "FEATURE_POLICY_UNAVAILABLE";

  constructor(readonly reason: "auth" | "protocol" | "network" | "cache", message: string) {
    super(message);
    this.name = "FeaturePolicyCoordinatorError";
  }
}

function cloudOrigin(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("龙枢云端地址格式无效");
  }
  return url.origin;
}

function assertDeviceId(deviceId: string): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(deviceId)) throw new Error("龙枢设备 ID 格式无效");
}

function validEtag(value: string): boolean {
  return value === "" || ETAG_PATTERN.test(value);
}

function assertCurrentDocument(document: FeaturePolicyDocument, now: number): void {
  if (!Number.isFinite(now)) {
    throw new FeaturePolicyCoordinatorError("protocol", "策略校验时间无效");
  }
  if (Date.parse(document.issued_at) > now || Date.parse(document.expires_at) <= now) {
    throw new FeaturePolicyCoordinatorError("protocol", "云端返回的功能策略尚未生效或已经过期");
  }
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return keys.length === expectedKeys.length
    && keys.every((key, index) => key === expectedKeys[index]);
}

function parseCache(
  input: unknown,
  expectedOrigin: string,
  expectedDeviceId: string,
  now: number,
): FeaturePolicyCacheRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new FeaturePolicyCoordinatorError("cache", "功能策略缓存格式无效");
  }
  if (!exactKeys(input, [
    "schema_version",
    "cloud_origin",
    "device_id",
    "etag",
    "cached_at",
    "document",
  ])) {
    throw new FeaturePolicyCoordinatorError("cache", "功能策略缓存字段无效");
  }
  const record = input as Partial<FeaturePolicyCacheRecord>;
  if (
    record.schema_version !== CACHE_SCHEMA
    || record.cloud_origin !== expectedOrigin
    || record.device_id !== expectedDeviceId
    || typeof record.etag !== "string"
    || !validEtag(record.etag)
    || typeof record.cached_at !== "string"
  ) {
    throw new FeaturePolicyCoordinatorError("cache", "功能策略缓存绑定无效");
  }
  const cachedAt = Date.parse(record.cached_at);
  if (!Number.isFinite(cachedAt) || new Date(cachedAt).toISOString() !== record.cached_at || cachedAt > now) {
    throw new FeaturePolicyCoordinatorError("cache", "功能策略缓存时间无效");
  }
  let document: FeaturePolicyDocument;
  try {
    document = parseFeaturePolicyJson(JSON.stringify(record.document));
  } catch {
    throw new FeaturePolicyCoordinatorError("cache", "功能策略缓存内容无效");
  }
  if (
    Date.parse(document.issued_at) > cachedAt
    || Date.parse(document.expires_at) <= now
    || now - cachedAt >= FEATURE_POLICY_MAX_VALIDITY_MS
  ) {
    throw new FeaturePolicyCoordinatorError("cache", "功能策略缓存已过期");
  }
  return { ...record, document } as FeaturePolicyCacheRecord;
}

function readCache(path: string, origin: string, deviceId: string, now: number): FeaturePolicyCacheRecord {
  if (!existsSync(path)) throw new FeaturePolicyCoordinatorError("cache", "功能策略缓存不存在");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > CACHE_MAX_BYTES) {
    throw new FeaturePolicyCoordinatorError("cache", "功能策略缓存不是受信普通文件");
  }
  try {
    return parseCache(JSON.parse(readFileSync(path, "utf8")), origin, deviceId, now);
  } catch (error) {
    if (error instanceof FeaturePolicyCoordinatorError) throw error;
    throw new FeaturePolicyCoordinatorError("cache", "功能策略缓存无法读取");
  }
}

function writeCache(path: string, record: FeaturePolicyCacheRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("功能策略缓存目标不是普通文件");
  }
  const temporary = path + "." + process.pid + "." + randomUUID() + ".tmp";
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, JSON.stringify(record) + "\n", "utf8");
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function removeCache(path: string): void {
  try {
    if (!existsSync(path)) return;
    const stat = lstatSync(path);
    if (stat.isFile() && !stat.isSymbolicLink()) unlinkSync(path);
  } catch {
    // 内存状态已经 fail-closed；磁盘清理失败不能恢复策略可用性。
  }
}

async function responseTextBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > FEATURE_POLICY_MAX_BYTES) {
    throw new FeaturePolicyCoordinatorError("protocol", "功能策略响应过大");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    bytes += result.value.byteLength;
    if (bytes > FEATURE_POLICY_MAX_BYTES) {
      await reader.cancel();
      throw new FeaturePolicyCoordinatorError("protocol", "功能策略响应过大");
    }
    chunks.push(result.value);
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(merged);
}

function asCoordinatorError(error: unknown): FeaturePolicyCoordinatorError {
  if (error instanceof FeaturePolicyCoordinatorError) return error;
  if (error instanceof FeaturePolicyValidationError) {
    return new FeaturePolicyCoordinatorError("protocol", "功能策略响应协议无效");
  }
  return new FeaturePolicyCoordinatorError("network", "功能策略网络请求失败");
}

export class FeaturePolicyCoordinator {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private snapshotValue: FeaturePolicySnapshot | undefined;
  private inFlight: Promise<FeaturePolicySnapshot> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private emergencyIds = new Set<FeatureId>();

  constructor(private readonly options: FeaturePolicyCoordinatorOptions) {
    assertDeviceId(options.deviceId);
    this.origin = cloudOrigin(options.cloudBaseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    const interval = options.refreshIntervalMs ?? FEATURE_POLICY_REFRESH_INTERVAL_MS;
    if (!Number.isInteger(interval) || interval < 1_000) throw new Error("功能策略刷新间隔无效");
  }

  current(): FeaturePolicySnapshot | undefined {
    const snapshot = this.snapshotValue;
    if (!snapshot || Date.parse(snapshot.document.expires_at) <= this.now()) return undefined;
    return snapshot;
  }

  refresh(): Promise<FeaturePolicySnapshot> {
    if (this.inFlight) return this.inFlight;
    const request = this.performRefresh();
    this.inFlight = request;
    void request.finally(() => {
      if (this.inFlight === request) this.inFlight = undefined;
    }).catch(() => undefined);
    return request;
  }

  startPolling(): void {
    if (this.timer) return;
    const interval = this.options.refreshIntervalMs ?? FEATURE_POLICY_REFRESH_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.refresh().catch((error) => this.options.onError?.(asCoordinatorError(error)));
    }, interval);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.snapshotValue = undefined;
  }

  decide(featureId: FeatureId, context: FeaturePolicyDecisionContext = {}): LocalFeaturePolicyDecision {
    const snapshot = this.current();
    if (!snapshot) return { allowed: false, reason: "POLICY_UNAVAILABLE" };
    let policy: ResolvedFeaturePolicy | undefined;
    try {
      policy = resolveFeaturePolicy(snapshot.document, featureId, {
        manager_version: this.options.desktopVersion,
        audience: this.options.audience ?? "user",
        scope_ids: {
          ...this.options.scopeIds,
          device: this.options.deviceId,
          ...(context.agentId ? { agent: context.agentId } : {}),
        },
        now: new Date(this.now()),
      });
    } catch {
      this.snapshotValue = undefined;
      return { allowed: false, reason: "POLICY_UNAVAILABLE" };
    }
    if (snapshot.source === "cache" && policy?.risk_level === "high") {
      return { allowed: false, reason: "POLICY_OFFLINE", source: "cache", policy };
    }
    const decision = decideFeatureAccess(policy, {
      entitlements: context.entitlements ?? this.options.entitlements ?? [],
      permissions: context.permissions ?? this.options.permissions ?? [],
    });
    if (decision.allowed) return { allowed: true, source: snapshot.source, policy: policy! };
    return {
      allowed: false,
      reason: decision.reason,
      source: snapshot.source,
      ...(policy ? { policy } : {}),
      ...(decision.missing ? { missing: decision.missing } : {}),
    };
  }

  private publish(
    document: FeaturePolicyDocument,
    source: PolicySource,
    refreshedAt: number,
  ): FeaturePolicySnapshot {
    const snapshot: FeaturePolicySnapshot = {
      document,
      source,
      refreshed_at: new Date(refreshedAt).toISOString(),
    };
    this.snapshotValue = snapshot;
    const nextEmergency = new Set(
      document.features.filter((entry) => entry.emergency_disabled).map((entry) => entry.feature_id),
    );
    const newlyDisabled = [...nextEmergency].filter((featureId) => !this.emergencyIds.has(featureId));
    this.emergencyIds = nextEmergency;
    if (newlyDisabled.length > 0) this.options.onEmergencyDisabled?.(newlyDisabled);
    this.options.onRefresh?.(snapshot);
    return snapshot;
  }

  private async performRefresh(): Promise<FeaturePolicySnapshot> {
    const startedAt = this.now();
    let cached: FeaturePolicyCacheRecord | undefined;
    try {
      cached = readCache(this.options.cacheFile, this.origin, this.options.deviceId, startedAt);
    } catch {
      cached = undefined;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? 10_000);
    timeout.unref();
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(this.origin + "/v1/client/feature-policy", {
          method: "GET",
          headers: {
            authorization: "Bearer " + this.options.deviceToken,
            "x-longhub-manager-version": this.options.desktopVersion,
            ...(cached?.etag ? { "if-none-match": cached.etag } : {}),
          },
          signal: controller.signal,
        });
      } catch {
        if (!cached) {
          throw new FeaturePolicyCoordinatorError(
            "network",
            "功能策略网络请求失败且无可用缓存",
          );
        }
        return this.publish(cached.document, "cache", this.now());
      }
      const refreshedAt = this.now();
      if (response.status === 401 || response.status === 403) {
        this.snapshotValue = undefined;
        removeCache(this.options.cacheFile);
        throw new FeaturePolicyCoordinatorError("auth", "功能策略凭据无效");
      }
      if (response.status === 304) {
        if (!cached) throw new FeaturePolicyCoordinatorError("protocol", "功能策略 304 缺少绑定缓存");
        assertCurrentDocument(cached.document, refreshedAt);
        writeCache(this.options.cacheFile, {
          ...cached,
          cached_at: new Date(refreshedAt).toISOString(),
        });
        return this.publish(cached.document, "network", refreshedAt);
      }
      if (response.status === 429 || response.status >= 500) {
        if (!cached) {
          throw new FeaturePolicyCoordinatorError(
            "network",
            "功能策略服务暂时不可用且无可用缓存",
          );
        }
        return this.publish(cached.document, "cache", refreshedAt);
      }
      if (response.status !== 200) {
        throw new FeaturePolicyCoordinatorError(
          "protocol",
          "功能策略服务返回不可接受状态 " + response.status,
        );
      }
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "application/json") {
        throw new FeaturePolicyCoordinatorError("protocol", "功能策略响应类型无效");
      }
      const document = parseFeaturePolicyJson(await responseTextBounded(response));
      assertCurrentDocument(document, refreshedAt);
      const etag = response.headers.get("etag") ?? "";
      if (!validEtag(etag)) throw new FeaturePolicyCoordinatorError("protocol", "功能策略 ETag 无效");
      writeCache(this.options.cacheFile, {
        schema_version: CACHE_SCHEMA,
        cloud_origin: this.origin,
        device_id: this.options.deviceId,
        etag,
        cached_at: new Date(refreshedAt).toISOString(),
        document,
      });
      return this.publish(document, "network", refreshedAt);
    } catch (error) {
      const normalized = asCoordinatorError(error);
      if (normalized.reason === "protocol" || normalized.reason === "auth") {
        this.snapshotValue = undefined;
        removeCache(this.options.cacheFile);
      }
      throw normalized;
    } finally {
      clearTimeout(timeout);
    }
  }
}
