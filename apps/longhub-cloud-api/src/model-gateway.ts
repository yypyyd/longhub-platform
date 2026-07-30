/**
 * 龙枢模型网关：设备只看到一个固定的 OpenAI 兼容模型，真实上游地址、模型 ID 与
 * API Key 由管理后台维护。API Key 使用服务端主密钥 AES-256-GCM 加密后再入库。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
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
  api_key?: string;
  fallback_config_id?: string | null;
  request_timeout_ms?: number;
  max_retries?: number;
  circuit_breaker_threshold?: number;
  circuit_breaker_cooldown_ms?: number;
  min_desktop_version?: string;
  max_desktop_version?: string | null;
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

function isPrivateIpLiteral(hostname: string): boolean {
  const version = isIP(hostname);
  if (version === 4) {
    const [a = 0, b = 0] = hostname.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (version === 6) {
    const normalized = hostname.toLowerCase();
    return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb");
  }
  return false;
}

export function normalizeUpstreamBaseUrl(raw: string, allowInsecure = false): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" && !(allowInsecure && url.protocol === "http:")) {
    throw new Error("上游 Base URL 必须使用 HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("上游 Base URL 不能包含凭据、查询参数或 fragment");
  if (!allowInsecure && (url.hostname === "localhost" || isPrivateIpLiteral(url.hostname))) {
    throw new Error("上游 Base URL 不能指向本机或私网地址");
  }
  return url.toString().replace(/\/$/, "");
}

function adminView(config: ModelGatewayConfigRecord | undefined, encryptionReady: boolean): Record<string, unknown> {
  return {
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
    has_api_key: Boolean(config?.encrypted_api_key),
    fallback_config_id: config?.fallback_config_id,
    request_timeout_ms: config?.request_timeout_ms ?? PROXY_TIMEOUT_MS,
    max_retries: config?.max_retries ?? 0,
    circuit_breaker_threshold: config?.circuit_breaker_threshold ?? 5,
    circuit_breaker_cooldown_ms: config?.circuit_breaker_cooldown_ms ?? 60_000,
    min_desktop_version: config?.min_desktop_version ?? "0.0.0",
    max_desktop_version: config?.max_desktop_version,
    assistant_name: config?.assistant_name ?? "龙枢助手",
    assistant_avatar_path: config?.assistant_avatar_path ?? "/assets/longhub-avatar.png",
    welcome_message: config?.welcome_message ?? "你好，我是龙枢助手。",
    quick_tasks: config?.quick_tasks ?? [],
    features: config?.features ?? { agent_catalog: true, file_upload: true, tool_execution: true },
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
  return config;
}

function semanticVersion(value: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function compareVersion(left: string, right: string): number {
  const a = semanticVersion(left);
  const b = semanticVersion(right);
  if (!a || !b) return left.localeCompare(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! !== b[index]!) return a[index]! - b[index]!;
  }
  return 0;
}

export async function resolveModelGatewayConfig(store: CloudStore, device: DeviceRecord): Promise<ModelGatewayConfigRecord | undefined> {
  const configs = await store.listModelGatewayConfigs();
  const paidPlans = new Set<string>();
  if (device.user_id) {
    for (const order of await store.listOrders(device.user_id)) {
      if (order.status === "paid" && order.product_id) paidPlans.add(order.product_id);
    }
  }
  const matches = configs.filter((config) =>
    (config.scope_type === "device" && config.scope_id === device.device_id) ||
    (config.scope_type === "plan" && paidPlans.has(config.scope_id)) ||
    (config.scope_type === "tenant" && config.scope_id === device.tenant_id) ||
    config.scope_type === "global"
  );
  const rank = { global: 0, tenant: 1, plan: 2, device: 3 } as const;
  return matches.sort((a, b) => rank[b.scope_type] - rank[a.scope_type] || b.updated_at.localeCompare(a.updated_at))[0];
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

const circuitStates = new Map<string, { failures: number; openUntil: number }>();

function circuitOpen(config: ModelGatewayConfigRecord, now = Date.now()): boolean {
  const state = circuitStates.get(config.config_id);
  if (!state) return false;
  if (state.openUntil <= now) {
    circuitStates.delete(config.config_id);
    return false;
  }
  return true;
}

function recordCircuitSuccess(config: ModelGatewayConfigRecord): void {
  circuitStates.delete(config.config_id);
}

function recordCircuitFailure(config: ModelGatewayConfigRecord): void {
  const current = circuitStates.get(config.config_id) ?? { failures: 0, openUntil: 0 };
  const failures = current.failures + 1;
  circuitStates.set(config.config_id, {
    failures,
    openUntil: failures >= config.circuit_breaker_threshold ? Date.now() + config.circuit_breaker_cooldown_ms : 0,
  });
}

function retryableUpstreamStatus(status: number): boolean {
  return status === 429 || status >= 500;
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
  let input: Record<string, unknown>;
  try {
    input = await readLimitedJson(req);
  } catch (err) {
    const tooLarge = err instanceof Error && err.message === "MODEL_REQUEST_TOO_LARGE";
    sendError(res, tooLarge ? 413 : 400, tooLarge ? "MODEL_REQUEST_TOO_LARGE" : "INVALID_JSON", tooLarge ? "模型请求体过大" : "模型请求体不是合法 JSON");
    return;
  }
  const proxiedInput = JSON.stringify({ ...input, model: config.model_id });
  let usageLease: ModelUsageLease;
  try {
    usageLease = await beginModelUsage(ctx.store, device, config);
  } catch (error) {
    if (error instanceof ModelQuotaError) {
      sendError(res, 429, error.code, "当前设备或企业的模型额度暂不可用，请稍后重试", true);
      return;
    }
    sendError(res, 503, "MODEL_USAGE_UNAVAILABLE", "模型额度服务暂不可用，请稍后重试", true);
    return;
  }
  const fallback = config.fallback_config_id && config.fallback_config_id !== config.config_id
    ? await ctx.store.getModelGatewayConfig(config.fallback_config_id)
    : undefined;
  const usableFallback = fallback?.enabled && !fallback.emergency_disabled && fallback.encrypted_api_key &&
    fallback.api_type === config.api_type ? fallback : undefined;
  const candidates = circuitOpen(config)
    ? (usableFallback ? [usableFallback] : [])
    : [config, ...(usableFallback ? [usableFallback] : [])];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ctx.proxyTimeoutMs ?? config.request_timeout_ms);
  req.once("aborted", () => controller.abort());
  const startedAt = Date.now();
  let outputBytes = 0;
  let usageFinalized = false;
  try {
    if (candidates.length === 0) throw new Error("MODEL_CIRCUIT_OPEN");
    let upstream: Response | undefined;
    let selected = config;
    let lastError: unknown;
    for (const candidate of candidates) {
      for (let attempt = 0; attempt <= candidate.max_retries; attempt += 1) {
        try {
          const apiKey = decryptModelApiKey(candidate.encrypted_api_key!, ctx.encryptionKey!);
          const response = await fetch(upstreamEndpoint(candidate.base_url, endpoint), {
            method: "POST",
            headers: {
              authorization: `Bearer ${apiKey}`,
              "content-type": "application/json",
              accept: typeof req.headers.accept === "string" ? req.headers.accept : "application/json",
            },
            body: candidate.model_id === config.model_id ? proxiedInput : JSON.stringify({ ...input, model: candidate.model_id }),
            redirect: "error",
            signal: controller.signal,
          });
          if (retryableUpstreamStatus(response.status) && (attempt < candidate.max_retries || candidate !== candidates.at(-1))) {
            await response.body?.cancel().catch(() => undefined);
            if (attempt === candidate.max_retries) recordCircuitFailure(candidate);
            continue;
          }
          upstream = response;
          selected = candidate;
          if (response.ok) recordCircuitSuccess(candidate);
          else if (retryableUpstreamStatus(response.status)) recordCircuitFailure(candidate);
          break;
        } catch (error) {
          lastError = error;
          if (controller.signal.aborted) throw error;
          if (attempt === candidate.max_retries) recordCircuitFailure(candidate);
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
    if (!upstream.body) {
      res.end();
      await usageLease.complete({ success: upstream.ok, inputBytes: Buffer.byteLength(proxiedInput), outputBytes: 0, headers: upstream.headers })
        .catch(() => ctx.logger.warn("model.usage_dropped"));
      usageFinalized = true;
      return;
    }
    const reader = upstream.body.getReader();
    try {
      while (!res.destroyed) {
        const chunk = await reader.read();
        if (chunk.done) break;
        outputBytes += chunk.value.byteLength;
        if (!res.write(Buffer.from(chunk.value))) await new Promise<void>((resolve) => res.once("drain", resolve));
      }
    } finally {
      reader.releaseLock();
    }
    if (!res.destroyed) res.end();
    await usageLease.complete({ success: upstream.ok, inputBytes: Buffer.byteLength(proxiedInput), outputBytes, headers: upstream.headers })
      .catch(() => ctx.logger.warn("model.usage_dropped"));
    usageFinalized = true;
  } catch (err) {
    void ctx.store.updateDeviceOperations(device.device_id, {
      last_error_code: err instanceof Error && err.name === "AbortError" ? "MODEL_TIMEOUT" : "MODEL_NETWORK_ERROR",
    }).catch(() => undefined);
    recordModelMetric(
      ctx,
      config.api_type,
      err instanceof Error && err.name === "AbortError" ? "timeout" : "network_error",
      startedAt,
    );
    if (!res.headersSent) sendError(res, 502, "MODEL_UPSTREAM_ERROR", err instanceof Error ? err.message : "上游模型请求失败", true);
    else res.destroy(err instanceof Error ? err : undefined);
    if (!usageFinalized) {
      await usageLease.complete({ success: false, inputBytes: Buffer.byteLength(proxiedInput), outputBytes })
        .catch(() => ctx.logger.warn("model.usage_dropped"));
      usageFinalized = true;
    }
  } finally {
    clearTimeout(timeout);
    if (!usageFinalized) usageLease.release();
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
    if (config && (compareVersion(device.app_version, config.min_desktop_version) < 0 ||
      (config.max_desktop_version && compareVersion(device.app_version, config.max_desktop_version) > 0))) {
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
      compatible_desktop: {
        min_version: config?.min_desktop_version ?? "0.0.0",
        ...(config?.max_desktop_version ? { max_version: config.max_desktop_version } : {}),
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

  if (url.pathname === "/v1/admin/model-config" && req.method === "GET") {
    if (!(await requireAdmin(ctx.admin, req, res, { write: false }))) return true;
    sendJson(res, 200, adminView(await ctx.store.getModelGatewayConfig(), Boolean(ctx.encryptionKey)));
    return true;
  }
  if (url.pathname === "/v1/admin/model-policies" && req.method === "GET") {
    if (!(await requireAdmin(ctx.admin, req, res, { write: false }))) return true;
    sendJson(res, 200, { policies: (await ctx.store.listModelGatewayConfigs()).map((config) => adminView(config, Boolean(ctx.encryptionKey))) });
    return true;
  }
  if (url.pathname === "/v1/admin/model-config" && req.method === "POST") {
    const identity = await requireAdmin(ctx.admin, req, res, { write: true });
    if (!identity) return true;
    if (!ctx.encryptionKey) {
      sendError(res, 503, "MODEL_ENCRYPTION_UNAVAILABLE", "服务端未配置 MODEL_CONFIG_KEY，不能保存模型密钥");
      return true;
    }
    const parsed = await readJson<AdminModelConfigInput>(req, res);
    if (!parsed) return true;
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
      const timeoutMs = parsed.request_timeout_ms ?? current?.request_timeout_ms ?? PROXY_TIMEOUT_MS;
      const maxRetries = parsed.max_retries ?? current?.max_retries ?? 0;
      const breakerThreshold = parsed.circuit_breaker_threshold ?? current?.circuit_breaker_threshold ?? 5;
      const breakerCooldown = parsed.circuit_breaker_cooldown_ms ?? current?.circuit_breaker_cooldown_ms ?? 60_000;
      const minDesktopVersion = parsed.min_desktop_version ?? current?.min_desktop_version ?? "0.0.0";
      const maxDesktopVersion = parsed.max_desktop_version === null ? undefined : parsed.max_desktop_version ?? current?.max_desktop_version;
      const assistantName = (parsed.assistant_name ?? current?.assistant_name ?? "龙枢助手").trim();
      const avatarPath = parsed.assistant_avatar_path ?? current?.assistant_avatar_path ?? "/assets/longhub-avatar.png";
      const welcomeMessage = (parsed.welcome_message ?? current?.welcome_message ?? "你好，我是龙枢助手。").trim();
      const quickTasks = parsed.quick_tasks ?? current?.quick_tasks ?? [];
      const features = {
        agent_catalog: parsed.features?.agent_catalog ?? current?.features?.agent_catalog ?? true,
        file_upload: parsed.features?.file_upload ?? current?.features?.file_upload ?? true,
        tool_execution: parsed.features?.tool_execution ?? current?.features?.tool_execution ?? true,
      };
      const deviceRate = parsed.device_requests_per_minute ?? current?.device_requests_per_minute ?? 60;
      const deviceDailyTokens = parsed.device_daily_tokens ?? current?.device_daily_tokens ?? 1_000_000;
      const tenantMonthlyTokens = parsed.tenant_monthly_tokens ?? current?.tenant_monthly_tokens ?? 100_000_000;
      const maxConcurrency = parsed.max_device_concurrency ?? current?.max_device_concurrency ?? 2;
      const inputCost = parsed.input_cost_microunits_per_million ?? current?.input_cost_microunits_per_million ?? 0;
      const outputCost = parsed.output_cost_microunits_per_million ?? current?.output_cost_microunits_per_million ?? 0;
      const cacheCost = parsed.cache_cost_microunits_per_million ?? current?.cache_cost_microunits_per_million ?? 0;
      if (!modelId || !displayName || !validPositiveInteger(contextWindow, 1_024, 10_000_000) || !validPositiveInteger(maxTokens, 256, 1_000_000) || maxTokens > contextWindow) {
        sendError(res, 422, "INVALID_MODEL_CONFIG", "模型 ID、显示名和合法的上下文/输出上限必填");
        return true;
      }
      if (!validPositiveInteger(timeoutMs, 1_000, PROXY_TIMEOUT_MS) || !validPositiveInteger(maxRetries, 0, 2) ||
        !validPositiveInteger(breakerThreshold, 1, 100) || !validPositiveInteger(breakerCooldown, 1_000, 3_600_000) ||
        !semanticVersion(minDesktopVersion) || (maxDesktopVersion && (!semanticVersion(maxDesktopVersion) || compareVersion(maxDesktopVersion, minDesktopVersion) < 0)) ||
        !validText(assistantName, 64) || !validAvatarPath(avatarPath) || !validText(welcomeMessage, 500) ||
        !Array.isArray(quickTasks) || quickTasks.length > 8 || quickTasks.some((task) => !validText(task, 120))) {
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
        encrypted_api_key: encryptedApiKey,
        fallback_config_id: parsed.fallback_config_id === null ? undefined : parsed.fallback_config_id ?? current?.fallback_config_id,
        request_timeout_ms: timeoutMs,
        max_retries: maxRetries,
        circuit_breaker_threshold: breakerThreshold,
        circuit_breaker_cooldown_ms: breakerCooldown,
        min_desktop_version: minDesktopVersion,
        max_desktop_version: maxDesktopVersion,
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
        assistant_name: saved.assistant_name,
        features: saved.features,
        min_desktop_version: saved.min_desktop_version,
        max_desktop_version: saved.max_desktop_version,
      });
      ctx.logger.info("model.config.updated", { actor: identity.actor, enabled: saved.enabled, model_id: saved.model_id });
      sendJson(res, 200, adminView(saved, true));
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
      const upstream = await fetch(upstreamEndpoint(config.base_url, "models"), {
        headers: { authorization: `Bearer ${decryptModelApiKey(config.encrypted_api_key!, ctx.encryptionKey!)}` },
        redirect: "error",
        signal: controller.signal,
      });
      if (!upstream.ok) {
        sendError(res, 502, "MODEL_TEST_FAILED", `上游 /models 返回 HTTP ${upstream.status}`);
      } else {
        sendJson(res, 200, { ok: true });
      }
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
