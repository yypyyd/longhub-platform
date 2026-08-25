/**
 * 龙枢模型网关：设备只看到一个固定的 OpenAI 兼容模型，真实上游地址、模型 ID 与
 * API Key 由管理后台维护。API Key 使用服务端主密钥 AES-256-GCM 加密后再入库。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { compareSemver } from "@longhub/feature-policy";
import type { StructuredLogger } from "@longhub/observability";
import { requireAdmin, type AdminRouteContext } from "./admin-routes.js";
import { readBody, readJson, sendError, sendJson } from "./http-util.js";
import { beginModelUsage, ModelQuotaError, type ModelUsageLease } from "./model-usage.js";
import type {
  CloudStore,
  DeviceRecord,
  ModelGatewayConfigRecord,
  ModelRequestAggregateRecord,
} from "./store.js";

const PUBLIC_MODEL_ID = "longhub-default";
const MAX_PROXY_BODY_BYTES = 8 * 1024 * 1024;
const PROXY_TIMEOUT_MS = 5 * 60 * 1000;
export const RUNTIME_CONFIG_SCHEMA = "longhub/runtime-config/v1" as const;
export const RUNTIME_CONFIG_TTL_MS = 10 * 60_000;

export interface ModelGatewayContext {
  store: CloudStore;
  admin: AdminRouteContext;
  logger: StructuredLogger;
  encryptionKey?: Uint8Array;
  allowInsecureUpstream?: boolean;
  /** 仅用于确定性测试；生产默认五分钟。 */
  proxyTimeoutMs?: number;
  /** 仅用于确定性 DNS 中止测试；生产使用系统解析器。 */
  resolveUpstreamHostname?: UpstreamHostnameResolver;
  authenticateDevice(req: IncomingMessage, res: ServerResponse): Promise<DeviceRecord | undefined>;
}

interface AdminModelConfigInput {
  config_id?: string;
  scope_type?: "global" | "tenant" | "plan" | "device";
  scope_id?: string;
  enabled?: boolean;
  emergency_disabled?: boolean;
  base_url?: string;
  model_id?: string;
  display_name?: string;
  api_type?: "openai-completions" | "openai-responses";
  context_window?: number;
  max_tokens?: number;
  input_capabilities?: ("text" | "image")[];
  api_key?: string;
  fallback_config_id?: string | null;
  request_timeout_ms?: number;
  max_retries?: number;
  circuit_breaker_threshold?: number;
  circuit_breaker_cooldown_ms?: number;
  min_manager_version?: string;
  max_manager_version?: string | null;
  assistant_name?: string;
  assistant_avatar_path?: string;
  welcome_message?: string;
  quick_tasks?: string[];
  features?: { agent_catalog?: boolean; file_upload?: boolean; tool_execution?: boolean };
  device_requests_per_minute?: number;
  device_daily_tokens?: number;
  tenant_monthly_tokens?: number;
  max_device_concurrency?: number;
  input_cost_microunits_per_million?: number;
  output_cost_microunits_per_million?: number;
  cache_cost_microunits_per_million?: number;
}

/**
 * These fields belonged to the retired Desktop product shell (assistant
 * branding, welcome copy and compatibility feature toggles).  The database
 * columns remain so an explicitly enabled legacy fixture can still read old
 * rows, but the clean-launch Admin contract must never accept or expose them.
 */
const LEGACY_MODEL_UI_FIELDS = [
  "assistant_name",
  "assistant_avatar_path",
  "welcome_message",
  "quick_tasks",
  "features",
] as const;

function legacyModelUiField(input: AdminModelConfigInput): string | undefined {
  return LEGACY_MODEL_UI_FIELDS.find((field) => Object.prototype.hasOwnProperty.call(input, field));
}

/** MODEL_CONFIG_KEY 使用 base64/base64url 编码的 32 字节随机值。 */
export function parseModelEncryptionKey(value: string | undefined): Buffer | undefined {
  if (!value) return undefined;
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32) throw new Error("MODEL_CONFIG_KEY 必须是 base64 编码的 32 字节密钥");
  return key;
}

export function encryptModelApiKey(apiKey: string, key: Uint8Array): string {
  if (key.byteLength !== 32) throw new Error("模型配置加密密钥长度必须为 32 字节");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64url")}:${ciphertext.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}`;
}

export function decryptModelApiKey(encrypted: string, key: Uint8Array): string {
  if (key.byteLength !== 32) throw new Error("模型配置加密密钥长度必须为 32 字节");
  const [version, ivText, ciphertextText, tagText] = encrypted.split(":");
  if (version !== "v1" || !ivText || !ciphertextText || !tagText) throw new Error("模型 API Key 密文格式无效");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

const DISALLOWED_UPSTREAM_ADDRESSES = new BlockList();
const ALLOWED_GLOBAL_IPV6_ADDRESSES = new BlockList();
ALLOWED_GLOBAL_IPV6_ADDRESSES.addSubnet("2000::", 3, "ipv6");
const DISALLOWED_IPV4_SUBNETS = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const;

for (const [address, prefix] of DISALLOWED_IPV4_SUBNETS) {
  DISALLOWED_UPSTREAM_ADDRESSES.addSubnet(address, prefix, "ipv4");
  DISALLOWED_UPSTREAM_ADDRESSES.addSubnet(`::ffff:${address}`, 96 + prefix, "ipv6");
}
for (const [address, prefix] of [
  ["::", 96],
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  DISALLOWED_UPSTREAM_ADDRESSES.addSubnet(address, prefix, "ipv6");
}

function bareHostname(hostname: string): string {
  const unbracketed = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const zoneIndex = unbracketed.includes(":") ? unbracketed.indexOf("%") : -1;
  return (zoneIndex >= 0 ? unbracketed.slice(0, zoneIndex) : unbracketed).replace(/\.$/, "").toLowerCase();
}

export function isDisallowedUpstreamAddress(address: string): boolean {
  const normalized = bareHostname(address);
  const version = isIP(normalized);
  if (version === 4) return DISALLOWED_UPSTREAM_ADDRESSES.check(normalized, "ipv4");
  if (version === 6) {
    return !ALLOWED_GLOBAL_IPV6_ADDRESSES.check(normalized, "ipv6") ||
      DISALLOWED_UPSTREAM_ADDRESSES.check(normalized, "ipv6");
  }
  return false;
}

export function isAllowedConnectedAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = bareHostname(address);
  return isIP(normalized) !== 0 && !isDisallowedUpstreamAddress(normalized);
}

export type UpstreamHostnameResolver = (hostname: string) => Promise<readonly LookupAddress[]>;

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : clientAbortError();
}

/** Race an unabortable resolver against the request signal and ignore its late result. */
function waitForAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

const resolveSystemHostname: UpstreamHostnameResolver = (hostname) => dnsLookup(hostname, {
  all: true,
  verbatim: true,
});

function upstreamAddressError(address: string): Error {
  return new Error(`上游地址解析到本机、私网、链路本地或保留地址: ${address}`);
}

/**
 * Resolve once, reject the entire answer set if any address is unsafe, then
 * pin that immutable set into the socket lookup callback.  The connection
 * therefore cannot perform a second DNS lookup that could be rebound.
 */
export async function createPinnedUpstreamLookup(
  hostname: string,
  resolveHostname: UpstreamHostnameResolver = resolveSystemHostname,
  signal?: AbortSignal,
): Promise<LookupFunction> {
  const expectedHostname = bareHostname(hostname);
  const resolution = resolveHostname(expectedHostname);
  const resolved = [...await (signal ? waitForAbort(resolution, signal) : resolution)].map((entry) => ({
    address: bareHostname(entry.address),
    family: entry.family,
  }));
  if (resolved.length === 0) throw new Error("上游域名未解析到任何地址");
  for (const entry of resolved) {
    if (isIP(entry.address) !== entry.family || (entry.family !== 4 && entry.family !== 6)) {
      throw new Error("上游域名解析结果无效");
    }
    if (isDisallowedUpstreamAddress(entry.address)) throw upstreamAddressError(entry.address);
  }
  return (queriedHostname, options, callback) => {
    if (bareHostname(queriedHostname) !== expectedHostname) {
      callback(new Error("上游连接尝试解析未校验的域名"), "", 0);
      return;
    }
    const requestedFamily = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : options.family;
    const candidates = requestedFamily === 4 || requestedFamily === 6
      ? resolved.filter((entry) => entry.family === requestedFamily)
      : resolved;
    if (candidates.length === 0) {
      callback(new Error("上游域名没有匹配地址族的已校验地址"), "", 0);
      return;
    }
    if (options.all) callback(null, candidates);
    else callback(null, candidates[0]!.address, candidates[0]!.family);
  };
}

export function normalizeUpstreamBaseUrl(raw: string, allowInsecure = false): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" && !(allowInsecure && url.protocol === "http:")) {
    throw new Error("上游 Base URL 必须使用 HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("上游 Base URL 不能包含凭据、查询参数或 fragment");
  const hostname = bareHostname(url.hostname);
  if (!allowInsecure && ((hostname === "localhost" || hostname.endsWith(".localhost")) || isDisallowedUpstreamAddress(hostname))) {
    throw new Error("上游 Base URL 不能指向本机或私网地址");
  }
  return url.toString().replace(/\/$/, "");
}

interface UpstreamHttpResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  body: IncomingMessage;
}

async function requestUpstream(
  rawUrl: string,
  options: {
    method?: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
    onRequestStarted?: () => void;
    resolveHostname?: UpstreamHostnameResolver;
  },
  allowInsecure = false,
): Promise<UpstreamHttpResponse> {
  const target = new URL(normalizeUpstreamBaseUrl(rawUrl, allowInsecure));
  const hostname = bareHostname(target.hostname);
  const lookup = !allowInsecure && isIP(hostname) === 0
    ? await createPinnedUpstreamLookup(hostname, options.resolveHostname, options.signal)
    : undefined;
  if (options.signal.aborted) throw abortError(options.signal);
  const requestImpl = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<UpstreamHttpResponse>((resolve, reject) => {
    let settled = false;
    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    if (options.signal.aborted) {
      rejectOnce(abortError(options.signal));
      return;
    }
    const upstreamRequest = requestImpl(target, {
      method: options.method ?? "GET",
      headers: {
        ...options.headers,
        "accept-encoding": "identity",
        ...(options.body ? { "content-length": String(Buffer.byteLength(options.body)) } : {}),
      },
      lookup,
      agent: false,
      signal: options.signal,
    }, (response) => {
      const remoteAddress = response.socket.remoteAddress;
      if (!allowInsecure && !isAllowedConnectedAddress(remoteAddress)) {
        const error = upstreamAddressError(remoteAddress ?? "unknown");
        response.destroy();
        rejectOnce(error);
        return;
      }
      const status = response.statusCode ?? 502;
      if (status >= 300 && status < 400) {
        const error = new Error(`上游重定向已禁止: HTTP ${status}`);
        response.destroy();
        rejectOnce(error);
        return;
      }
      const headers = new Headers();
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        headers.append(response.rawHeaders[index]!, response.rawHeaders[index + 1]!);
      }
      settled = true;
      resolve({ status, ok: status >= 200 && status < 300, headers, body: response });
    });
    // Count an upstream attempt only after the request object was created.
    // DNS resolution and an already-aborted signal must not be billed as a
    // network attempt.
    options.onRequestStarted?.();
    upstreamRequest.once("error", (error) => rejectOnce(error));
    upstreamRequest.once("socket", (socket) => {
      const send = (): void => {
        const remoteAddress = socket.remoteAddress;
        if (!allowInsecure && !isAllowedConnectedAddress(remoteAddress)) {
          upstreamRequest.destroy(upstreamAddressError(remoteAddress ?? "unknown"));
          return;
        }
        upstreamRequest.end(options.body);
      };
      if (socket.connecting) socket.once(target.protocol === "https:" ? "secureConnect" : "connect", send);
      else send();
    });
  });
}

function adminView(
  config: ModelGatewayConfigRecord | undefined,
  encryptionReady: boolean,
  includeLegacyUi = false,
): Record<string, unknown> {
  const view: Record<string, unknown> = {
    configured: Boolean(config),
    config_id: config?.config_id ?? "default",
    scope_type: config?.scope_type ?? "global",
    scope_id: config?.scope_id ?? "-",
    enabled: config?.enabled ?? false,
    emergency_disabled: config?.emergency_disabled ?? false,
    base_url: config?.base_url ?? "",
    model_id: config?.model_id ?? "",
    display_name: config?.display_name ?? "龙枢默认模型",
    api_type: config?.api_type ?? "openai-completions",
    context_window: config?.context_window ?? 128_000,
    max_tokens: config?.max_tokens ?? 8_192,
    input_capabilities: config?.input_capabilities ?? ["text"],
    has_api_key: Boolean(config?.encrypted_api_key),
    fallback_config_id: config?.fallback_config_id,
    request_timeout_ms: config?.request_timeout_ms ?? PROXY_TIMEOUT_MS,
    max_retries: config?.max_retries ?? 0,
    circuit_breaker_threshold: config?.circuit_breaker_threshold ?? 5,
    circuit_breaker_cooldown_ms: config?.circuit_breaker_cooldown_ms ?? 60_000,
    min_manager_version: config?.min_manager_version ?? "0.0.0",
    max_manager_version: config?.max_manager_version,
    device_requests_per_minute: config?.device_requests_per_minute ?? 60,
    device_daily_tokens: config?.device_daily_tokens ?? 1_000_000,
    tenant_monthly_tokens: config?.tenant_monthly_tokens ?? 100_000_000,
    max_device_concurrency: config?.max_device_concurrency ?? 2,
    input_cost_microunits_per_million: config?.input_cost_microunits_per_million ?? 0,
    output_cost_microunits_per_million: config?.output_cost_microunits_per_million ?? 0,
    cache_cost_microunits_per_million: config?.cache_cost_microunits_per_million ?? 0,
    encryption_ready: encryptionReady,
    updated_at: config?.updated_at,
  };
  if (includeLegacyUi) {
    Object.assign(view, {
      assistant_name: config?.assistant_name ?? "龙枢助手",
      assistant_avatar_path: config?.assistant_avatar_path ?? "/assets/longhub-avatar.png",
      welcome_message: config?.welcome_message ?? "你好，我是龙枢助手。",
      quick_tasks: config?.quick_tasks ?? [],
      features: config?.features ?? { agent_catalog: true, file_upload: true, tool_execution: true },
    });
  }
  return view;
}

function validPositiveInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

async function configuredModel(
  ctx: ModelGatewayContext,
  res: ServerResponse,
  device: DeviceRecord,
): Promise<ModelGatewayConfigRecord | undefined> {
  const config = await resolveModelGatewayConfig(ctx.store, device);
  if (config?.emergency_disabled) {
    sendError(res, 503, "MODEL_POLICY_DISABLED", "龙枢服务当前已由管理员暂停，请稍后重试", true);
    return undefined;
  }
  if (!config?.enabled || !config.encrypted_api_key || !ctx.encryptionKey) {
    sendError(res, 503, "MODEL_NOT_CONFIGURED", "龙枢后台尚未启用默认模型，请联系管理员", true);
    return undefined;
  }
  if (!modelGatewayConfigSupportsDevice(config, device)) {
    sendError(res, 426, "CLIENT_VERSION_UNSUPPORTED", "当前客户端不在模型执行兼容范围内，请更新客户端");
    return undefined;
  }
  return config;
}

function semanticVersion(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    compareSemver(value, value);
    return true;
  } catch {
    return false;
  }
}

function modelGatewayConfigSupportsDevice(
  config: ModelGatewayConfigRecord,
  device: DeviceRecord,
): boolean {
  try {
    return compareSemver(device.app_version, config.min_manager_version) >= 0 &&
      (config.max_manager_version === undefined || compareSemver(device.app_version, config.max_manager_version) <= 0);
  } catch {
    return false;
  }
}

export async function resolveModelGatewayConfig(store: CloudStore, device: DeviceRecord): Promise<ModelGatewayConfigRecord | undefined> {
  const configs = await store.listModelGatewayConfigs();
  const activePlanIds = await activeCloudSkillPlanIdsForDevice(store, device);
  const matches = configs.filter((config) => modelGatewayConfigApplies(config, device, activePlanIds));
  const rank = { global: 0, tenant: 1, plan: 2, device: 3 } as const;
  return matches.sort((a, b) => rank[b.scope_type] - rank[a.scope_type] || b.updated_at.localeCompare(a.updated_at))[0];
}

async function activeCloudSkillPlanIdsForDevice(
  store: CloudStore,
  device: DeviceRecord,
  now = new Date(),
): Promise<Set<string>> {
  if (!device.user_id) return new Set();
  const nowMs = now.getTime();
  const planIds = new Set<string>();
  for (const subscription of await store.listCloudSkillSubscriptions(device.user_id)) {
    const startsAt = Date.parse(subscription.starts_at);
    const expiresAt = Date.parse(subscription.expires_at);
    if (subscription.user_id === device.user_id && subscription.tenant_id === device.tenant_id &&
      subscription.status === "active" && Number.isFinite(startsAt) && Number.isFinite(expiresAt) &&
      startsAt <= nowMs && nowMs < expiresAt) {
      planIds.add(subscription.plan_id);
    }
  }
  return planIds;
}

function modelGatewayConfigApplies(
  config: ModelGatewayConfigRecord,
  device: DeviceRecord,
  activePlanIds: ReadonlySet<string>,
): boolean {
  return (
    (config.scope_type === "device" && config.scope_id === device.device_id) ||
    (config.scope_type === "plan" && activePlanIds.has(config.scope_id)) ||
    (config.scope_type === "tenant" && config.scope_id === device.tenant_id) ||
    config.scope_type === "global"
  );
}

function validPolicyId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value);
}

function validText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function validAvatarPath(value: unknown): value is string {
  return typeof value === "string" && /^\/assets\/[A-Za-z0-9._/-]{1,180}$/.test(value) && !value.includes("..");
}

async function readLimitedJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_PROXY_BODY_BYTES) throw new Error("MODEL_REQUEST_TOO_LARGE");
  const body = await readBody(req);
  if (Buffer.byteLength(body, "utf8") > MAX_PROXY_BODY_BYTES) throw new Error("MODEL_REQUEST_TOO_LARGE");
  const parsed = JSON.parse(body) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("MODEL_REQUEST_INVALID");
  return parsed as Record<string, unknown>;
}

function upstreamEndpoint(baseUrl: string, endpoint: "models" | "chat/completions" | "responses"): string {
  return `${baseUrl}/${endpoint}`;
}

export function modelLatencyBucket(durationMs: number): ModelRequestAggregateRecord["latency_bucket"] {
  if (durationMs < 1_000) return "lt_1s";
  if (durationMs < 3_000) return "1_to_3s";
  if (durationMs < 10_000) return "3_to_10s";
  if (durationMs < 30_000) return "10_to_30s";
  return "gte_30s";
}

function recordModelMetric(
  ctx: ModelGatewayContext,
  apiType: ModelRequestAggregateRecord["api_type"],
  outcome: ModelRequestAggregateRecord["outcome"],
  startedAt: number,
): void {
  const bucketStart = new Date();
  bucketStart.setUTCMinutes(0, 0, 0);
  void ctx.store.incrementModelRequestMetrics([{
    bucket_start: bucketStart.toISOString(),
    api_type: apiType,
    outcome,
    latency_bucket: modelLatencyBucket(Date.now() - startedAt),
    count: 1,
  }]).catch(() => ctx.logger.warn("model.metrics_dropped"));
}

type ModelCircuitState = { failures: number; openUntil: number };

/**
 * Circuit state belongs to one CloudStore/server boundary.  Keying a single
 * process-wide map by config_id lets two independent tenants or test servers
 * that both use the conventional "default" id open each other's circuit.
 * WeakMap also releases the in-memory state when an ephemeral server/store is
 * discarded.
 */
const circuitStatesByStore = new WeakMap<CloudStore, Map<string, ModelCircuitState>>();

function circuitStates(store: CloudStore): Map<string, ModelCircuitState> {
  const existing = circuitStatesByStore.get(store);
  if (existing) return existing;
  const created = new Map<string, ModelCircuitState>();
  circuitStatesByStore.set(store, created);
  return created;
}

function circuitOpen(store: CloudStore, config: ModelGatewayConfigRecord, now = Date.now()): boolean {
  const states = circuitStates(store);
  const state = states.get(config.config_id);
  if (!state) return false;
  if (state.openUntil <= now) {
    states.delete(config.config_id);
    return false;
  }
  return true;
}

function recordCircuitSuccess(store: CloudStore, config: ModelGatewayConfigRecord): void {
  circuitStates(store).delete(config.config_id);
}

function recordCircuitFailure(store: CloudStore, config: ModelGatewayConfigRecord): void {
  const states = circuitStates(store);
  const current = states.get(config.config_id) ?? { failures: 0, openUntil: 0 };
  const failures = current.failures + 1;
  states.set(config.config_id, {
    failures,
    openUntil: failures >= config.circuit_breaker_threshold ? Date.now() + config.circuit_breaker_cooldown_ms : 0,
  });
}

function retryableUpstreamStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function clientAbortError(): Error {
  const error = new Error("模型客户端已断开连接");
  error.name = "AbortError";
  return error;
}

function waitForResponseDrain(res: ServerResponse): Promise<void> {
  if (res.destroyed) return Promise.reject(clientAbortError());
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      res.off("drain", onDrain);
      res.off("close", onClose);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onClose = (): void => {
      cleanup();
      reject(clientAbortError());
    };
    res.once("drain", onDrain);
    res.once("close", onClose);
  });
}

async function completeModelUsageLease(
  ctx: ModelGatewayContext,
  lease: ModelUsageLease,
  params: { success: boolean; inputBytes: number; outputBytes: number; headers?: Headers },
): Promise<void> {
  await lease.complete(params).catch(() => ctx.logger.warn("model.usage_dropped"));
}

async function proxyModelRequest(
  ctx: ModelGatewayContext,
  req: IncomingMessage,
  res: ServerResponse,
  config: ModelGatewayConfigRecord,
  device: DeviceRecord,
  endpoint: "chat/completions" | "responses",
): Promise<void> {
  if ((config.api_type === "openai-completions" && endpoint !== "chat/completions") ||
      (config.api_type === "openai-responses" && endpoint !== "responses")) {
    sendError(res, 404, "MODEL_API_NOT_ENABLED", "当前默认模型未启用该 OpenAI 接口");
    return;
  }
  const controller = new AbortController();
  let timedOut = false;
  let abortSource: "client" | "timeout" | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const abortForRequestClose = (): void => {
    if (controller.signal.aborted) return;
    abortSource = "client";
    controller.abort(clientAbortError());
  };
  const abortForResponseClose = (): void => {
    if (!res.writableFinished) abortForRequestClose();
  };
  req.once("aborted", abortForRequestClose);
  res.once("close", abortForResponseClose);
  if (req.aborted || res.destroyed) abortForRequestClose();

  const startedAt = Date.now();
  let outputBytes = 0;
  let attemptedUpstream = false;
  let selectedLease: ModelUsageLease | undefined;
  let selectedBody = "";
  let selectedHeaders: Headers | undefined;
  try {
    if (controller.signal.aborted) return;
    let input: Record<string, unknown>;
    try {
      input = await readLimitedJson(req);
    } catch (err) {
      if (controller.signal.aborted || res.destroyed) return;
      const tooLarge = err instanceof Error && err.message === "MODEL_REQUEST_TOO_LARGE";
      sendError(res, tooLarge ? 413 : 400, tooLarge ? "MODEL_REQUEST_TOO_LARGE" : "INVALID_JSON", tooLarge ? "模型请求体过大" : "模型请求体不是合法 JSON");
      return;
    }
    if (controller.signal.aborted) return;

    let usableFallback: ModelGatewayConfigRecord | undefined;
    if (config.fallback_config_id && config.fallback_config_id !== config.config_id) {
      try {
        const fallback = await ctx.store.getModelGatewayConfig(config.fallback_config_id);
        if (controller.signal.aborted) return;
        const fallbackApplies = fallback && modelGatewayConfigSupportsDevice(fallback, device)
          ? modelGatewayConfigApplies(fallback, device, await activeCloudSkillPlanIdsForDevice(ctx.store, device))
          : false;
        if (controller.signal.aborted) return;
        if (fallback?.enabled && !fallback.emergency_disabled && fallback.encrypted_api_key &&
          fallback.api_type === config.api_type && fallbackApplies) {
          usableFallback = fallback;
        }
      } catch {
        if (controller.signal.aborted) return;
        ctx.logger.warn("model.fallback_unavailable", { config_id: config.config_id });
      }
    }
    const candidates = circuitOpen(ctx.store, config)
      ? (usableFallback ? [usableFallback] : [])
      : [config, ...(usableFallback ? [usableFallback] : [])];
    if (candidates.length === 0) throw new Error("MODEL_CIRCUIT_OPEN");
    timeout = setTimeout(() => {
      if (controller.signal.aborted) return;
      timedOut = true;
      abortSource = "timeout";
      controller.abort(new Error("模型请求超时"));
    }, ctx.proxyTimeoutMs ?? config.request_timeout_ms);

    let upstream: UpstreamHttpResponse | undefined;
    let selected = config;
    let lastError: unknown;
    for (const candidate of candidates) {
      if (controller.signal.aborted) throw clientAbortError();
      const candidateBody = candidate.model_id === config.model_id
        ? JSON.stringify({ ...input, model: config.model_id })
        : JSON.stringify({ ...input, model: candidate.model_id });
      let candidateLease: ModelUsageLease | undefined;
      try {
        candidateLease = await beginModelUsage(ctx.store, device, candidate, new Date(), controller.signal);
      } catch (error) {
        if (controller.signal.aborted) throw clientAbortError();
        if (error instanceof ModelQuotaError) {
          sendError(res, 429, error.code, "当前设备或企业的模型额度暂不可用，请稍后重试", true);
          return;
        }
        sendError(res, 503, "MODEL_USAGE_UNAVAILABLE", "模型额度服务暂不可用，请稍后重试", true);
        return;
      }
      let candidateAttempted = false;
      let candidateHeaders: Headers | undefined;
      try {
        if (controller.signal.aborted) throw clientAbortError();
        for (let attempt = 0; attempt <= candidate.max_retries; attempt += 1) {
          try {
            if (controller.signal.aborted) throw clientAbortError();
            const apiKey = decryptModelApiKey(candidate.encrypted_api_key!, ctx.encryptionKey!);
            const response = await requestUpstream(upstreamEndpoint(candidate.base_url, endpoint), {
              method: "POST",
              headers: {
                authorization: `Bearer ${apiKey}`,
                "content-type": "application/json",
                accept: typeof req.headers.accept === "string" ? req.headers.accept : "application/json",
              },
              body: candidateBody,
              signal: controller.signal,
              onRequestStarted: () => {
                candidateAttempted = true;
                attemptedUpstream = true;
              },
              resolveHostname: ctx.resolveUpstreamHostname,
            }, ctx.allowInsecureUpstream);
            candidateHeaders = response.headers;
            if (retryableUpstreamStatus(response.status) && (attempt < candidate.max_retries || candidate !== candidates.at(-1))) {
              response.body.destroy();
              if (attempt === candidate.max_retries) recordCircuitFailure(ctx.store, candidate);
              continue;
            }
            upstream = response;
            selected = candidate;
            selectedBody = candidateBody;
            selectedHeaders = response.headers;
            selectedLease = candidateLease;
            candidateLease = undefined;
            if (response.ok) recordCircuitSuccess(ctx.store, candidate);
            else if (retryableUpstreamStatus(response.status)) recordCircuitFailure(ctx.store, candidate);
            break;
          } catch (error) {
            lastError = error;
            if (controller.signal.aborted) throw error;
            if (attempt === candidate.max_retries) recordCircuitFailure(ctx.store, candidate);
          }
        }
      } finally {
        if (candidateLease) {
          if (candidateAttempted) {
            await completeModelUsageLease(ctx, candidateLease, {
              success: false,
              inputBytes: Buffer.byteLength(candidateBody),
              outputBytes: 0,
              headers: candidateHeaders,
            });
          } else {
            candidateLease.release();
          }
        }
      }
      if (upstream) break;
    }
    if (!upstream) throw lastError instanceof Error ? lastError : new Error("MODEL_UPSTREAM_ERROR");
    // 延迟定义为服务端收到上游响应头的 TTFB 桶，不等待流式响应全部完成。
    recordModelMetric(ctx, selected.api_type, upstream.ok ? "success" : "upstream_rejected", startedAt);
    void ctx.store.updateDeviceOperations(device.device_id, upstream.ok
      ? { last_model_success_at: new Date().toISOString(), last_error_code: undefined }
      : { last_error_code: "MODEL_UPSTREAM_REJECTED" }).catch(() => undefined);
    res.statusCode = upstream.status;
    for (const name of ["content-type", "cache-control", "x-request-id", "openai-processing-ms", "openai-version"]) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    try {
      for await (const value of upstream.body) {
        if (res.destroyed) throw clientAbortError();
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        outputBytes += chunk.byteLength;
        if (!res.write(chunk)) await waitForResponseDrain(res);
      }
    } finally {
      if (res.destroyed && !upstream.body.destroyed) upstream.body.destroy();
    }
    if (!res.destroyed) res.end();
    if (!selectedLease) throw new Error("MODEL_USAGE_LEASE_MISSING");
    const completedLease = selectedLease;
    selectedLease = undefined;
    await completeModelUsageLease(ctx, completedLease!, {
      success: upstream.ok,
      inputBytes: Buffer.byteLength(selectedBody),
      outputBytes,
      headers: upstream.headers,
    });
  } catch (err) {
    if (attemptedUpstream) {
      void ctx.store.updateDeviceOperations(device.device_id, {
        last_error_code: timedOut ? "MODEL_TIMEOUT" : "MODEL_NETWORK_ERROR",
      }).catch(() => undefined);
      recordModelMetric(
        ctx,
        config.api_type,
        timedOut ? "timeout" : "network_error",
        startedAt,
      );
    }
    if (!res.destroyed && !res.headersSent) {
      sendError(res, 502, "MODEL_UPSTREAM_ERROR", "上游模型服务暂时不可用，请稍后重试", true);
    }
    else if (!res.destroyed) res.destroy(err instanceof Error ? err : undefined);
    if (selectedLease) {
      const failedLease = selectedLease;
      selectedLease = undefined;
      await completeModelUsageLease(ctx, failedLease, {
        success: false,
        inputBytes: Buffer.byteLength(selectedBody),
        outputBytes,
        headers: selectedHeaders,
      });
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    req.off("aborted", abortForRequestClose);
    res.off("close", abortForResponseClose);
    selectedLease?.release();
  }
}

/** 返回 true 表示模型网关已处理该请求。 */
export async function handleModelGatewayRoutes(
  ctx: ModelGatewayContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/v1/client/runtime-config") {
    const device = await ctx.authenticateDevice(req, res);
    if (!device) return true;
    const config = await resolveModelGatewayConfig(ctx.store, device);
    if (config?.emergency_disabled) {
      sendError(res, 503, "CLIENT_DISABLED_BY_POLICY", "龙枢服务当前已由管理员暂停，请稍后重试", true);
      return true;
    }
    if (config && !modelGatewayConfigSupportsDevice(config, device)) {
      sendError(res, 426, "CLIENT_VERSION_UNSUPPORTED", "当前龙枢版本不在后台允许范围内，请更新客户端");
      return true;
    }
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + RUNTIME_CONFIG_TTL_MS);
    const configVersion = config?.updated_at ?? "unconfigured";
    const etag = `W/"${createHash("sha256").update(`${config?.config_id ?? "default"}\n${configVersion}`).digest("base64url")}"`;
    res.setHeader("cache-control", "private, no-store");
    res.setHeader("etag", etag);
    res.setHeader("x-longhub-config-issued-at", issuedAt.toISOString());
    res.setHeader("x-longhub-config-expires-at", expiresAt.toISOString());
    if (req.headers["if-none-match"] === etag) {
      res.statusCode = 304;
      res.end();
      return true;
    }
    sendJson(res, 200, {
      schema_version: RUNTIME_CONFIG_SCHEMA,
      config_version: configVersion,
      issued_at: issuedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      provider_id: "longhub",
      base_path: "/v1/model",
      model_id: PUBLIC_MODEL_ID,
      display_name: config?.display_name ?? "龙枢默认模型",
      api_type: config?.api_type ?? "openai-completions",
      context_window: config?.context_window ?? 128_000,
      max_tokens: config?.max_tokens ?? 8_192,
      allow_user_model_selection: false,
      compatible_manager: {
        min_version: config?.min_manager_version ?? "0.0.0",
        ...(config?.max_manager_version ? { max_version: config.max_manager_version } : {}),
      },
      product: {
        assistant_name: config?.assistant_name ?? "龙枢助手",
        assistant_avatar_path: config?.assistant_avatar_path ?? "/assets/longhub-avatar.png",
        welcome_message: config?.welcome_message ?? "你好，我是龙枢助手。",
        quick_tasks: config?.quick_tasks ?? [],
      },
      features: config?.features ?? { agent_catalog: true, file_upload: true, tool_execution: true },
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/v1/client/model-capabilities") {
    const device = await ctx.authenticateDevice(req, res);
    if (!device) return true;
    const config = await resolveModelGatewayConfig(ctx.store, device);
    if (config?.emergency_disabled) {
      sendError(res, 503, "CLIENT_DISABLED_BY_POLICY", "模型能力当前已暂停", true);
      return true;
    }
    if (config && !modelGatewayConfigSupportsDevice(config, device)) {
      sendError(res, 426, "CLIENT_VERSION_UNSUPPORTED", "当前客户端不在模型能力兼容范围内");
      return true;
    }
    const input = config?.input_capabilities ?? ["text"];
    sendJson(res, 200, {
      schema_version: "longhub/model-capabilities/v1",
      model_id: PUBLIC_MODEL_ID,
      input,
      file_inputs: {
        text_extraction: true,
        image_understanding: input.includes("image"),
      },
    });
    return true;
  }

  if (url.pathname === "/v1/admin/model-config" && req.method === "GET") {
    if (!(await requireAdmin(ctx.admin, req, res, { write: false }))) return true;
    sendJson(res, 200, adminView(
      await ctx.store.getModelGatewayConfig(),
      Boolean(ctx.encryptionKey),
      ctx.admin.legacySurfaceEnabled === true,
    ));
    return true;
  }
  if (url.pathname === "/v1/admin/model-policies" && req.method === "GET") {
    if (!(await requireAdmin(ctx.admin, req, res, { write: false }))) return true;
    sendJson(res, 200, {
      policies: (await ctx.store.listModelGatewayConfigs()).map((config) => adminView(
        config,
        Boolean(ctx.encryptionKey),
        ctx.admin.legacySurfaceEnabled === true,
      )),
    });
    return true;
  }
  if (url.pathname === "/v1/admin/model-config" && req.method === "POST") {
    const identity = await requireAdmin(ctx.admin, req, res, { write: true });
    if (!identity) return true;
    const parsed = await readJson<AdminModelConfigInput>(req, res);
    if (!parsed) return true;
    const includeLegacyUi = ctx.admin.legacySurfaceEnabled === true;
    if (!includeLegacyUi) {
      const field = legacyModelUiField(parsed);
      if (field) {
        sendError(res, 422, "LEGACY_MODEL_UI_FIELDS_DISABLED", `${field} 属于已下线的客户端界面字段`);
        return true;
      }
    }
    if (!ctx.encryptionKey) {
      sendError(res, 503, "MODEL_ENCRYPTION_UNAVAILABLE", "服务端未配置 MODEL_CONFIG_KEY，不能保存模型密钥");
      return true;
    }
    try {
      const configId = parsed.config_id ?? "default";
      if (!validPolicyId(configId)) throw new Error("策略 ID 无效");
      const current = await ctx.store.getModelGatewayConfig(configId);
      const scopeType = parsed.scope_type ?? current?.scope_type ?? "global";
      const scopeId = parsed.scope_id ?? current?.scope_id ?? "-";
      if (!validPolicyId(scopeId) || (scopeType === "global" && scopeId !== "-")) throw new Error("策略作用域无效");
      const baseUrl = normalizeUpstreamBaseUrl(parsed.base_url ?? current?.base_url ?? "", ctx.allowInsecureUpstream);
      const modelId = (parsed.model_id ?? current?.model_id ?? "").trim();
      const displayName = (parsed.display_name ?? current?.display_name ?? "龙枢默认模型").trim();
      const apiType = parsed.api_type ?? current?.api_type ?? "openai-completions";
      const contextWindow = parsed.context_window ?? current?.context_window ?? 128_000;
      const maxTokens = parsed.max_tokens ?? current?.max_tokens ?? 8_192;
      const inputCapabilities = parsed.input_capabilities ?? current?.input_capabilities ?? ["text"];
      const timeoutMs = parsed.request_timeout_ms ?? current?.request_timeout_ms ?? PROXY_TIMEOUT_MS;
      const maxRetries = parsed.max_retries ?? current?.max_retries ?? 0;
      const breakerThreshold = parsed.circuit_breaker_threshold ?? current?.circuit_breaker_threshold ?? 5;
      const breakerCooldown = parsed.circuit_breaker_cooldown_ms ?? current?.circuit_breaker_cooldown_ms ?? 60_000;
      const minManagerVersion = parsed.min_manager_version ?? current?.min_manager_version ?? "0.0.0";
      const maxManagerVersion = parsed.max_manager_version === null ? undefined : parsed.max_manager_version ?? current?.max_manager_version;
      const assistantName = (includeLegacyUi
        ? parsed.assistant_name ?? current?.assistant_name ?? "龙枢助手"
        : current?.assistant_name ?? "龙枢助手").trim();
      const avatarPath = includeLegacyUi
        ? parsed.assistant_avatar_path ?? current?.assistant_avatar_path ?? "/assets/longhub-avatar.png"
        : current?.assistant_avatar_path ?? "/assets/longhub-avatar.png";
      const welcomeMessage = (includeLegacyUi
        ? parsed.welcome_message ?? current?.welcome_message ?? "你好，我是龙枢助手。"
        : current?.welcome_message ?? "你好，我是龙枢助手。").trim();
      const quickTasks = includeLegacyUi
        ? parsed.quick_tasks ?? current?.quick_tasks ?? []
        : current?.quick_tasks ?? [];
      const features = {
        agent_catalog: includeLegacyUi
          ? parsed.features?.agent_catalog ?? current?.features?.agent_catalog ?? true
          : current?.features?.agent_catalog ?? true,
        file_upload: includeLegacyUi
          ? parsed.features?.file_upload ?? current?.features?.file_upload ?? true
          : current?.features?.file_upload ?? true,
        tool_execution: includeLegacyUi
          ? parsed.features?.tool_execution ?? current?.features?.tool_execution ?? true
          : current?.features?.tool_execution ?? true,
      };
      const deviceRate = parsed.device_requests_per_minute ?? current?.device_requests_per_minute ?? 60;
      const deviceDailyTokens = parsed.device_daily_tokens ?? current?.device_daily_tokens ?? 1_000_000;
      const tenantMonthlyTokens = parsed.tenant_monthly_tokens ?? current?.tenant_monthly_tokens ?? 100_000_000;
      const maxConcurrency = parsed.max_device_concurrency ?? current?.max_device_concurrency ?? 2;
      const inputCost = parsed.input_cost_microunits_per_million ?? current?.input_cost_microunits_per_million ?? 0;
      const outputCost = parsed.output_cost_microunits_per_million ?? current?.output_cost_microunits_per_million ?? 0;
      const cacheCost = parsed.cache_cost_microunits_per_million ?? current?.cache_cost_microunits_per_million ?? 0;
      if (!modelId || !displayName || !validPositiveInteger(contextWindow, 1_024, 10_000_000) || !validPositiveInteger(maxTokens, 256, 1_000_000) || maxTokens > contextWindow ||
        !Array.isArray(inputCapabilities) || (inputCapabilities.length !== 1 && inputCapabilities.length !== 2) ||
        inputCapabilities[0] !== "text" || (inputCapabilities.length === 2 && inputCapabilities[1] !== "image")) {
        sendError(res, 422, "INVALID_MODEL_CONFIG", "模型 ID、显示名和合法的上下文/输出上限必填");
        return true;
      }
      if (!validPositiveInteger(timeoutMs, 1_000, PROXY_TIMEOUT_MS) || !validPositiveInteger(maxRetries, 0, 2) ||
        !validPositiveInteger(breakerThreshold, 1, 100) || !validPositiveInteger(breakerCooldown, 1_000, 3_600_000) ||
        !semanticVersion(minManagerVersion) || (maxManagerVersion !== undefined &&
          (!semanticVersion(maxManagerVersion) || compareSemver(maxManagerVersion, minManagerVersion) < 0)) ||
        (includeLegacyUi && (!validText(assistantName, 64) || !validAvatarPath(avatarPath) || !validText(welcomeMessage, 500) ||
          !Array.isArray(quickTasks) || quickTasks.length > 8 || quickTasks.some((task) => !validText(task, 120))))) {
        sendError(res, 422, "INVALID_RUNTIME_POLICY", "运行策略范围、兼容版本、重试或产品字段无效");
        return true;
      }
      if (!validPositiveInteger(deviceRate, 1, 10_000) || !validPositiveInteger(deviceDailyTokens, 1_000, 1_000_000_000) ||
        !validPositiveInteger(tenantMonthlyTokens, 1_000, 100_000_000_000) || !validPositiveInteger(maxConcurrency, 1, 100) ||
        !validPositiveInteger(inputCost, 0, 1_000_000_000) || !validPositiveInteger(outputCost, 0, 1_000_000_000) ||
        !validPositiveInteger(cacheCost, 0, 1_000_000_000)) {
        sendError(res, 422, "INVALID_MODEL_QUOTA", "模型速率、额度、并发或成本参数无效");
        return true;
      }
      const suppliedApiKey = parsed.api_key?.trim();
      const encryptedApiKey = suppliedApiKey ? encryptModelApiKey(suppliedApiKey, ctx.encryptionKey) : current?.encrypted_api_key;
      if ((parsed.enabled ?? current?.enabled ?? false) && !encryptedApiKey) {
        sendError(res, 422, "MODEL_API_KEY_REQUIRED", "启用模型前必须配置 API Key");
        return true;
      }
      const saved = await ctx.store.setModelGatewayConfig({
        config_id: configId,
        scope_type: scopeType,
        scope_id: scopeId,
        enabled: parsed.enabled ?? current?.enabled ?? false,
        emergency_disabled: parsed.emergency_disabled ?? current?.emergency_disabled ?? false,
        base_url: baseUrl,
        model_id: modelId,
        display_name: displayName,
        api_type: apiType,
        context_window: contextWindow,
        max_tokens: maxTokens,
        input_capabilities: [...inputCapabilities],
        encrypted_api_key: encryptedApiKey,
        fallback_config_id: parsed.fallback_config_id === null ? undefined : parsed.fallback_config_id ?? current?.fallback_config_id,
        request_timeout_ms: timeoutMs,
        max_retries: maxRetries,
        circuit_breaker_threshold: breakerThreshold,
        circuit_breaker_cooldown_ms: breakerCooldown,
        min_manager_version: minManagerVersion,
        max_manager_version: maxManagerVersion,
        assistant_name: assistantName,
        assistant_avatar_path: avatarPath,
        welcome_message: welcomeMessage,
        quick_tasks: [...quickTasks],
        features,
        device_requests_per_minute: deviceRate,
        device_daily_tokens: deviceDailyTokens,
        tenant_monthly_tokens: tenantMonthlyTokens,
        max_device_concurrency: maxConcurrency,
        input_cost_microunits_per_million: inputCost,
        output_cost_microunits_per_million: outputCost,
        cache_cost_microunits_per_million: cacheCost,
        updated_at: new Date().toISOString(),
      });
      await ctx.store.appendAudit(identity.actor, "model.config.update", {
        enabled: saved.enabled,
        base_url: saved.base_url,
        model_id: saved.model_id,
        api_type: saved.api_type,
        api_key_replaced: Boolean(suppliedApiKey),
        config_id: saved.config_id,
        scope_type: saved.scope_type,
        scope_id: saved.scope_id,
        emergency_disabled: saved.emergency_disabled,
        fallback_config_id: saved.fallback_config_id,
        ...(includeLegacyUi ? {
          assistant_name: saved.assistant_name,
          features: saved.features,
        } : {}),
        min_manager_version: saved.min_manager_version,
        max_manager_version: saved.max_manager_version,
      });
      ctx.logger.info("model.config.updated", { actor: identity.actor, enabled: saved.enabled, model_id: saved.model_id });
      sendJson(res, 200, adminView(saved, true, includeLegacyUi));
    } catch (err) {
      sendError(res, 422, "INVALID_MODEL_CONFIG", err instanceof Error ? err.message : "模型配置无效");
    }
    return true;
  }

  if (url.pathname === "/v1/admin/model-config/test" && req.method === "POST") {
    if (!(await requireAdmin(ctx.admin, req, res, { write: true }))) return true;
    const config = await ctx.store.getModelGatewayConfig(url.searchParams.get("config_id") ?? "default");
    if (!config?.enabled || config.emergency_disabled || !config.encrypted_api_key || !ctx.encryptionKey) {
      sendError(res, 503, "MODEL_NOT_CONFIGURED", "该模型策略尚未启用");
      return true;
    }
    if (!config) return true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const upstream = await requestUpstream(upstreamEndpoint(config.base_url, "models"), {
        headers: { authorization: `Bearer ${decryptModelApiKey(config.encrypted_api_key!, ctx.encryptionKey!)}` },
        signal: controller.signal,
        resolveHostname: ctx.resolveUpstreamHostname,
      }, ctx.allowInsecureUpstream);
      if (!upstream.ok) {
        sendError(res, 502, "MODEL_TEST_FAILED", `上游 /models 返回 HTTP ${upstream.status}`);
      } else {
        sendJson(res, 200, { ok: true });
      }
      upstream.body.destroy();
    } catch (err) {
      sendError(res, 502, "MODEL_TEST_FAILED", err instanceof Error ? err.message : "上游连接失败");
    } finally {
      clearTimeout(timeout);
    }
    return true;
  }

  if (url.pathname === "/v1/model/models" && req.method === "GET") {
    const device = await ctx.authenticateDevice(req, res);
    if (!device) return true;
    const config = await configuredModel(ctx, res, device);
    if (!config) return true;
    sendJson(res, 200, { object: "list", data: [{ id: PUBLIC_MODEL_ID, object: "model", created: 0, owned_by: "longhub" }] });
    return true;
  }
  if ((url.pathname === "/v1/model/chat/completions" || url.pathname === "/v1/model/responses") && req.method === "POST") {
    const device = await ctx.authenticateDevice(req, res);
    if (!device) return true;
    const config = await configuredModel(ctx, res, device);
    if (!config) return true;
    await proxyModelRequest(ctx, req, res, config, device, url.pathname.endsWith("responses") ? "responses" : "chat/completions");
    return true;
  }
  return false;
}
