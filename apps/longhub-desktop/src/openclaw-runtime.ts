import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 从龙枢云端获取固定模型配置，并生成仅供内嵌 OpenClaw 使用的配置。 */
export const CLIENT_RUNTIME_CONFIG_SCHEMA = "longhub/runtime-config/v1" as const;
export const CLIENT_RUNTIME_CONFIG_MAX_VALIDITY_MS = 10 * 60_000;

export interface ClientModelRuntimeConfig {
  provider_id: "longhub";
  base_path: "/v1/model";
  model_id: "longhub-default";
  display_name: string;
  api_type: "openai-completions" | "openai-responses";
  context_window: number;
  max_tokens: number;
  allow_user_model_selection: false;
}

export interface ClientRuntimeConfig extends ClientModelRuntimeConfig {
  schema_version: typeof CLIENT_RUNTIME_CONFIG_SCHEMA;
  config_version: string;
  issued_at: string;
  expires_at: string;
  compatible_desktop: { min_version: string; max_version?: string };
  product: {
    assistant_name: string;
    assistant_avatar_path: string;
    welcome_message: string;
    quick_tasks: string[];
  };
  features: {
    agent_catalog: boolean;
    file_upload: boolean;
    tool_execution: boolean;
  };
}

export class RuntimeConfigRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
    readonly cacheAllowed: boolean,
  ) {
    super(`获取龙枢运行配置失败 [${code}]`);
    this.name = "RuntimeConfigRequestError";
  }
}

export type RuntimeConfigFetchResult =
  | { status: "modified"; config: ClientRuntimeConfig; etag?: string }
  | { status: "not_modified"; etag: string; issued_at: string; expires_at: string };

function validEtag(value: string | null): value is string {
  return value !== null && /^(?:W\/)?"[A-Za-z0-9_-]{16,128}"$/.test(value);
}

function strictKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...expected].sort().join("|");
}

function canonicalIsoInstant(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const instant = Date.parse(value);
  if (!Number.isFinite(instant) || new Date(instant).toISOString() !== value) return undefined;
  return instant;
}

/** 严格白名单解析，缓存和在线响应复用同一校验器。 */
export function parseClientRuntimeConfig(value: unknown): ClientRuntimeConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("龙枢后台返回了无效的客户端模型配置");
  }
  const body = value as Record<string, unknown>;
  const issuedAt = canonicalIsoInstant(body.issued_at);
  const expiresAt = canonicalIsoInstant(body.expires_at);
  if (
    !strictKeys(body, [
      "schema_version", "config_version", "issued_at", "expires_at", "provider_id", "base_path",
      "model_id", "display_name", "api_type", "context_window", "max_tokens", "allow_user_model_selection",
      "compatible_desktop", "product", "features",
    ]) ||
    body.schema_version !== CLIENT_RUNTIME_CONFIG_SCHEMA ||
    typeof body.config_version !== "string" ||
    body.config_version.length < 1 || body.config_version.length > 128 ||
    issuedAt === undefined || expiresAt === undefined || expiresAt <= issuedAt ||
    expiresAt - issuedAt > CLIENT_RUNTIME_CONFIG_MAX_VALIDITY_MS ||
    body.provider_id !== "longhub" ||
    body.model_id !== "longhub-default" ||
    body.allow_user_model_selection !== false ||
    (body.api_type !== "openai-completions" && body.api_type !== "openai-responses") ||
    body.base_path !== "/v1/model" ||
    typeof body.display_name !== "string" || body.display_name.length < 1 || body.display_name.length > 128 ||
    typeof body.context_window !== "number" || !Number.isInteger(body.context_window) ||
    body.context_window < 1_024 || body.context_window > 10_000_000 ||
    typeof body.max_tokens !== "number" || !Number.isInteger(body.max_tokens) ||
    body.max_tokens < 256 || body.max_tokens > 1_000_000 || body.max_tokens > body.context_window
  ) throw new Error("龙枢后台返回了无效的客户端模型配置");
  const compatible = body.compatible_desktop;
  const product = body.product;
  const features = body.features;
  if (!compatible || typeof compatible !== "object" || Array.isArray(compatible) ||
    !strictKeys(compatible as Record<string, unknown>, (compatible as { max_version?: unknown }).max_version === undefined ? ["min_version"] : ["min_version", "max_version"]) ||
    typeof (compatible as { min_version?: unknown }).min_version !== "string" ||
    ((compatible as { max_version?: unknown }).max_version !== undefined && typeof (compatible as { max_version?: unknown }).max_version !== "string") ||
    !product || typeof product !== "object" || Array.isArray(product) ||
    !strictKeys(product as Record<string, unknown>, ["assistant_name", "assistant_avatar_path", "welcome_message", "quick_tasks"]) ||
    typeof (product as { assistant_name?: unknown }).assistant_name !== "string" ||
    typeof (product as { assistant_avatar_path?: unknown }).assistant_avatar_path !== "string" ||
    !/^\/assets\/[A-Za-z0-9._/-]{1,180}$/.test((product as { assistant_avatar_path: string }).assistant_avatar_path) ||
    (product as { assistant_avatar_path: string }).assistant_avatar_path.includes("..") ||
    typeof (product as { welcome_message?: unknown }).welcome_message !== "string" ||
    !Array.isArray((product as { quick_tasks?: unknown }).quick_tasks) ||
    (product as { quick_tasks: unknown[] }).quick_tasks.length > 8 ||
    (product as { quick_tasks: unknown[] }).quick_tasks.some((task) => typeof task !== "string" || task.length < 1 || task.length > 120) ||
    !features || typeof features !== "object" || Array.isArray(features) ||
    !strictKeys(features as Record<string, unknown>, ["agent_catalog", "file_upload", "tool_execution"]) ||
    Object.values(features as Record<string, unknown>).some((flag) => typeof flag !== "boolean")) {
    throw new Error("龙枢后台返回了无效的客户端运行策略");
  }
  return body as unknown as ClientRuntimeConfig;
}

export async function fetchClientRuntimeConfig(
  cloudBaseUrl: string,
  deviceToken: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5_000,
): Promise<ClientRuntimeConfig> {
  const result = await fetchClientRuntimeConfigWithEtag(cloudBaseUrl, deviceToken, fetchImpl, timeoutMs);
  if (result.status !== "modified") throw new Error("龙枢后台意外返回了未修改响应");
  return result.config;
}

export async function fetchClientRuntimeConfigWithEtag(
  cloudBaseUrl: string,
  deviceToken: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5_000,
  etag?: string,
): Promise<RuntimeConfigFetchResult> {
  let res: Response;
  try {
    res = await fetchImpl(`${cloudBaseUrl.replace(/\/$/, "")}/v1/client/runtime-config`, {
      headers: { authorization: `Bearer ${deviceToken}`, ...(etag ? { "if-none-match": etag } : {}) },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new RuntimeConfigRequestError("CLOUD_UNREACHABLE", undefined, true, true);
  }
  if (res.status === 304) {
    const responseEtag = res.headers.get("etag");
    const issuedAt = res.headers.get("x-longhub-config-issued-at");
    const expiresAt = res.headers.get("x-longhub-config-expires-at");
    if (!etag || responseEtag !== etag || !validEtag(responseEtag) || canonicalIsoInstant(issuedAt) === undefined ||
      canonicalIsoInstant(expiresAt) === undefined) throw new Error("龙枢后台返回了无效的配置缓存确认");
    return { status: "not_modified", etag: responseEtag, issued_at: issuedAt!, expires_at: expiresAt! };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    if (res.ok) throw new Error("龙枢后台返回了无效的客户端模型配置");
    body = {};
  }
  if (!res.ok) {
    const suppliedCode = body && typeof body === "object" && !Array.isArray(body)
      ? (body as { code?: unknown }).code
      : undefined;
    const code = typeof suppliedCode === "string" && /^[A-Z0-9_]{1,64}$/.test(suppliedCode)
      ? suppliedCode
      : `HTTP_${res.status}`;
    const transient = res.status === 429 || res.status >= 500;
    throw new RuntimeConfigRequestError(code, res.status, transient, transient);
  }
  const responseEtag = res.headers.get("etag");
  if (responseEtag !== null && !validEtag(responseEtag)) throw new Error("龙枢后台返回了无效的配置 ETag");
  return { status: "modified", config: parseClientRuntimeConfig(body), ...(responseEtag ? { etag: responseEtag } : {}) };
}

export function modelProxyBaseUrl(cloudBaseUrl: string, basePath: string): string {
  const cloud = new URL(cloudBaseUrl);
  const resolved = new URL(basePath, `${cloud.origin}/`);
  if (resolved.origin !== cloud.origin) throw new Error("模型代理地址必须与龙枢云端同源");
  return resolved.toString().replace(/\/$/, "");
}

export const LONGHUB_IDENTITY_MD = `# IDENTITY.md - Who Am I?

- **Name:** 龙枢助手
- **Creature:** 龙枢内置 AI 助手
- **Vibe:** 专业、简洁、可靠
- **Emoji:** 🐉
- **Avatar:** avatars/longhub.png
`;

/**
 * 初始化龙枢专属工作区。只写入缺失的品牌身份，不覆盖后续由产品或用户维护的内容。
 * 工作区由调用方放在 LongHub userData 下，绝不读取或复制 ~/.openclaw/workspace。
 */
export function initializeOpenClawWorkspace(workspaceDir: string, avatarSourcePath?: string): string {
  mkdirSync(workspaceDir, { recursive: true });
  if (avatarSourcePath) {
    if (!existsSync(avatarSourcePath)) throw new Error(`龙枢头像资源不存在: ${avatarSourcePath}`);
    const avatarDir = join(workspaceDir, "avatars");
    mkdirSync(avatarDir, { recursive: true });
    copyFileSync(avatarSourcePath, join(avatarDir, "longhub.png"));
  }
  const identityPath = join(workspaceDir, "IDENTITY.md");
  if (!existsSync(identityPath)) {
    writeFileSync(identityPath, LONGHUB_IDENTITY_MD, { encoding: "utf8", mode: 0o600 });
  }
  return identityPath;
}

/**
 * API Key 使用环境变量占位符，设备凭据不会以明文写入 openclaw.json。
 * allowlist 只包含一个模型，OpenClaw 无法切换到其他 provider/model。
 */
export function buildOpenClawConfig(
  cloudBaseUrl: string,
  runtime: ClientModelRuntimeConfig,
  workspaceDir: string,
): Record<string, unknown> {
  if (!workspaceDir.trim()) throw new Error("龙枢 OpenClaw 工作区路径不能为空");
  const modelRef = `${runtime.provider_id}/${runtime.model_id}`;
  return {
    gateway: { mode: "local" },
    agents: {
      defaults: {
        workspace: workspaceDir,
        skipBootstrap: true,
        model: { primary: modelRef },
        models: { [modelRef]: { alias: runtime.display_name } },
      },
    },
    models: {
      mode: "replace",
      providers: {
        [runtime.provider_id]: {
          baseUrl: modelProxyBaseUrl(cloudBaseUrl, runtime.base_path),
          apiKey: "${LONGHUB_MODEL_TOKEN}",
          api: runtime.api_type,
          models: [
            {
              id: runtime.model_id,
              name: runtime.display_name,
              reasoning: false,
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: runtime.context_window,
              maxTokens: runtime.max_tokens,
            },
          ],
        },
      },
    },
  };
}
