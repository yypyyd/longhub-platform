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
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import {
  CLIENT_RUNTIME_CONFIG_MAX_VALIDITY_MS,
  fetchClientRuntimeConfigWithEtag,
  parseClientRuntimeConfig,
  RuntimeConfigRequestError,
  type ClientRuntimeConfig,
} from "./openclaw-runtime.js";

const CACHE_SCHEMA = "longhub/runtime-config-cache/v2" as const;
export const RUNTIME_CONFIG_MAX_CACHE_AGE_MS = CLIENT_RUNTIME_CONFIG_MAX_VALIDITY_MS;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

interface RuntimeConfigCacheRecord {
  schema_version: typeof CACHE_SCHEMA;
  cloud_origin: string;
  device_id: string;
  etag: string;
  cached_at: string;
  config: ClientRuntimeConfig;
}

export interface RuntimeConfigResolution {
  config: ClientRuntimeConfig;
  source: "network" | "cache";
  attempts: number;
}

export interface ResolveRuntimeConfigOptions {
  cloudBaseUrl: string;
  deviceId: string;
  deviceToken: string;
  cacheFile: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  requestTimeoutMs?: number;
  onCacheWriteFailure?: () => void;
}

export class RuntimeConfigUnavailableError extends Error {
  readonly code = "CLOUD_UNREACHABLE";

  constructor(readonly reason: "missing" | "expired" | "invalid") {
    super(`龙枢运行配置暂时不可用 [cache_${reason}]`);
    this.name = "RuntimeConfigUnavailableError";
  }
}

function cloudOrigin(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash) throw new Error("龙枢云端地址格式无效");
  return url.origin;
}

function validDeviceId(deviceId: string): boolean {
  return /^[a-zA-Z0-9._-]{1,128}$/.test(deviceId);
}

function parseCacheRecord(
  value: unknown,
  expectedOrigin: string,
  expectedDeviceId: string,
  now: number,
): RuntimeConfigCacheRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeConfigUnavailableError("invalid");
  }
  const record = value as Partial<RuntimeConfigCacheRecord>;
  if (
    Object.keys(record).sort().join("|") !== "cached_at|cloud_origin|config|device_id|etag|schema_version" ||
    record.schema_version !== CACHE_SCHEMA ||
    record.cloud_origin !== expectedOrigin ||
    record.device_id !== expectedDeviceId ||
    typeof record.cached_at !== "string" || typeof record.etag !== "string" ||
    (record.etag !== "" && !/^(?:W\/)?"[A-Za-z0-9_-]{16,128}"$/.test(record.etag))
  ) throw new RuntimeConfigUnavailableError("invalid");
  const cachedAt = Date.parse(record.cached_at);
  if (
    !Number.isFinite(cachedAt) || new Date(cachedAt).toISOString() !== record.cached_at ||
    cachedAt > now + MAX_CLOCK_SKEW_MS || now < cachedAt - MAX_CLOCK_SKEW_MS
  ) {
    throw new RuntimeConfigUnavailableError("invalid");
  }
  let config: ClientRuntimeConfig;
  try {
    config = parseClientRuntimeConfig(record.config);
  } catch {
    throw new RuntimeConfigUnavailableError("invalid");
  }
  const issuedAt = Date.parse(config.issued_at);
  const expiresAt = Date.parse(config.expires_at);
  if (
    issuedAt > cachedAt + MAX_CLOCK_SKEW_MS ||
    expiresAt - issuedAt > RUNTIME_CONFIG_MAX_CACHE_AGE_MS ||
    now >= expiresAt ||
    now - cachedAt >= RUNTIME_CONFIG_MAX_CACHE_AGE_MS
  ) throw new RuntimeConfigUnavailableError("expired");
  return { ...record, config } as RuntimeConfigCacheRecord;
}

function readCache(path: string, origin: string, deviceId: string, now: number): RuntimeConfigCacheRecord {
  if (!existsSync(path)) throw new RuntimeConfigUnavailableError("missing");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new RuntimeConfigUnavailableError("invalid");
  try {
    return parseCacheRecord(JSON.parse(readFileSync(path, "utf8")), origin, deviceId, now);
  } catch (error) {
    if (error instanceof RuntimeConfigUnavailableError) throw error;
    throw new RuntimeConfigUnavailableError("invalid");
  }
}

function writeCache(path: string, record: RuntimeConfigCacheRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("运行配置缓存目标不是普通文件");
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function retryDelay(baseMs: number, failedAttempt: number, random: () => number): number {
  const exponential = baseMs * 2 ** (failedAttempt - 1);
  return Math.round(exponential * (1 + Math.max(0, Math.min(1, random())) * 0.25));
}

function assertCurrentConfig(config: ClientRuntimeConfig, now: number): void {
  const issuedAt = Date.parse(config.issued_at);
  const expiresAt = Date.parse(config.expires_at);
  if (issuedAt > now + MAX_CLOCK_SKEW_MS || now >= expiresAt) {
    throw new Error("龙枢后台返回了已过期或尚未生效的客户端模型配置");
  }
}

/** 在线优先；只有明确的瞬时错误重试耗尽后才允许使用未过期的设备绑定缓存。 */
export async function resolveClientRuntimeConfig(
  options: ResolveRuntimeConfigOptions,
): Promise<RuntimeConfigResolution> {
  if (!validDeviceId(options.deviceId)) throw new Error("龙枢设备 ID 格式无效");
  const origin = cloudOrigin(options.cloudBaseUrl);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((delayMs) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const random = options.random ?? Math.random;
  const maxAttempts = options.maxAttempts ?? 3;
  const backoffBaseMs = options.backoffBaseMs ?? 500;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5 || backoffBaseMs < 0) {
    throw new Error("龙枢运行配置重试策略无效");
  }
  let cached: RuntimeConfigCacheRecord | undefined;
  try {
    cached = readCache(options.cacheFile, origin, options.deviceId, now());
  } catch {
    cached = undefined;
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const fetched = await fetchClientRuntimeConfigWithEtag(
        options.cloudBaseUrl,
        options.deviceToken,
        options.fetchImpl,
        options.requestTimeoutMs,
        cached?.etag || undefined,
      );
      const fetchedAt = now();
      const config = fetched.status === "not_modified"
        ? parseClientRuntimeConfig({ ...cached!.config, issued_at: fetched.issued_at, expires_at: fetched.expires_at })
        : fetched.config;
      const etag = fetched.etag ?? "";
      assertCurrentConfig(config, fetchedAt);
      try {
        writeCache(options.cacheFile, {
          schema_version: CACHE_SCHEMA,
          cloud_origin: origin,
          device_id: options.deviceId,
          etag,
          cached_at: new Date(fetchedAt).toISOString(),
          config,
        });
      } catch {
        options.onCacheWriteFailure?.();
      }
      return { config, source: "network", attempts: attempt };
    } catch (error) {
      const transient = error instanceof RuntimeConfigRequestError && error.retryable && error.cacheAllowed;
      if (!transient) throw error;
      if (attempt < maxAttempts) await sleep(retryDelay(backoffBaseMs, attempt, random));
    }
  }

  try {
    return {
      config: readCache(options.cacheFile, origin, options.deviceId, now()).config,
      source: "cache",
      attempts: maxAttempts,
    };
  } catch (error) {
    if (error instanceof RuntimeConfigUnavailableError) throw error;
    throw new RuntimeConfigUnavailableError("invalid");
  }
}
