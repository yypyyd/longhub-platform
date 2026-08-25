import { WindowsCredentialManager, type DeviceCredentialVault } from "@longhub/windows-credential";
import type { CloudSkillRequest } from "./protocol.js";

export const LONGHUB_CLOUD_API_URL_ENV = "LONGHUB_CLOUD_API_URL" as const;
export const DEFAULT_LONGHUB_CLOUD_API_URL = "https://154-9-26-158.sslip.io" as const;
export const SUPPORTED_OPENCLAW_VERSION = "2026.7.1-2" as const;

const DEFAULT_TIMEOUT_MS = 310_000;
const DEFAULT_POLL_MS = 750;
const MAX_RESPONSE_BYTES = 1 << 20;

export interface CloudSkillClientOptions {
  baseUrl?: string;
  vault?: DeviceCredentialVault;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  pollMs?: number;
  openclawVersion?: string;
}

export interface CloudSkillClient {
  execute(request: CloudSkillRequest, signal?: AbortSignal): Promise<unknown>;
}

export class CloudSkillError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly requestId?: string;

  constructor(code: string, message: string, retryable = false, requestId?: string) {
    super(message);
    this.name = "CloudSkillError";
    this.code = code;
    this.retryable = retryable;
    this.requestId = requestId;
  }
}

function normalizeBaseUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("LongHub Cloud API 地址无效"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("LongHub Cloud API 地址必须是无凭据、无查询参数的 HTTP(S) origin");
  }
  if (parsed.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname)) {
    throw new Error("非回环 Cloud API 地址必须使用 HTTPS");
  }
  return parsed.toString().replace(/\/+$/u, "");
}

function boundedString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" && value.length <= 256 ? value.trim() : fallback;
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new CloudSkillError("RESPONSE_TOO_LARGE", "云端响应过大");
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new CloudSkillError("RESPONSE_TOO_LARGE", "云端响应过大"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(data);
}

function publicMessage(code: string): string {
  const messages: Record<string, string> = {
    DEVICE_CREDENTIAL_REQUIRED: "LongHub Cloud 插件尚未完成设备配对",
    DEVICE_REVOKED: "LongHub 设备凭据已撤销，请重新执行 longhub-cloud pair",
    CLOUD_SKILL_SUBSCRIPTION_REQUIRED: "当前账号没有可用的 Cloud Skill 订阅",
    SUBSCRIPTION_REQUIRED: "需要有效的 LongHub 账号订阅",
    AGENT_SKILL_BINDING_REQUIRED: "当前 Agent 尚未绑定该 Cloud Skill",
    CLOUD_SKILL_PLAN_MISMATCH: "Cloud Skill 计划与当前订阅不匹配",
    SKILL_INCOMPATIBLE: "当前 OpenClaw 版本与 Cloud Skill 不兼容",
    INVALID_TASK: "Cloud Skill 请求格式无效",
    IDEMPOTENCY_CONFLICT: "Cloud Skill 请求幂等键冲突",
    TASK_NOT_FOUND: "Cloud Skill 任务不存在",
  };
  return messages[code] ?? "LongHub Cloud Skill 暂时不可用";
}

function errorFromResponse(status: number, body: string): CloudSkillError {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const code = typeof parsed.code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/u.test(parsed.code) ? parsed.code : "CLOUD_API_REJECTED";
    return new CloudSkillError(code, publicMessage(code), parsed.retryable === true || status >= 500, typeof parsed.request_id === "string" ? parsed.request_id : undefined);
  } catch {
    return new CloudSkillError(status >= 500 ? "CLOUD_API_UNAVAILABLE" : "CLOUD_API_REJECTED", "LongHub Cloud Skill 请求被拒绝", status >= 500);
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new CloudSkillError("REQUEST_CANCELLED", "请求已取消")); return; }
    const onAbort = () => { clearTimeout(timer); reject(new CloudSkillError("REQUEST_CANCELLED", "请求已取消")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function terminal(status: unknown): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "timed_out";
}

export function createCloudSkillClient(options: CloudSkillClientOptions = {}): CloudSkillClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_LONGHUB_CLOUD_API_URL);
  const vault = options.vault ?? new WindowsCredentialManager();
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 15 * 60_000) throw new Error("Cloud API 超时配置无效");
  if (!Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 10_000) throw new Error("Cloud API 轮询配置无效");
  return {
    async execute(request, callerSignal) {
      const credentials = await vault.read(baseUrl);
      if (!credentials) throw new CloudSkillError("DEVICE_CREDENTIAL_REQUIRED", publicMessage("DEVICE_CREDENTIAL_REQUIRED"));
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = () => controller.abort();
      callerSignal?.addEventListener("abort", onAbort, { once: true });
      let taskId: string | undefined;
      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${credentials.deviceToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "Idempotency-Key": request.idempotency_key,
          "X-LongHub-Agent-ID": request.agent_id,
        };
        const version = boundedString(options.openclawVersion, SUPPORTED_OPENCLAW_VERSION);
        headers["X-LongHub-OpenClaw-Version"] = version;
        const createResponse = await fetchImpl(`${baseUrl}/v1/tasks`, { method: "POST", headers, body: JSON.stringify(request), redirect: "error", signal: controller.signal });
        const createBody = await readBounded(createResponse, MAX_RESPONSE_BYTES);
        if (!createResponse.ok) throw errorFromResponse(createResponse.status, createBody);
        let task = JSON.parse(createBody) as Record<string, unknown>;
        if (typeof task.task_id !== "string") throw new CloudSkillError("INVALID_CLOUD_RESPONSE", "云端任务响应无效");
        taskId = task.task_id;
        while (!terminal(task.status)) {
          await abortableDelay(pollMs, controller.signal);
          const statusResponse = await fetchImpl(`${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}`, { method: "GET", headers: { Authorization: `Bearer ${credentials.deviceToken}`, Accept: "application/json", "X-LongHub-Agent-ID": request.agent_id }, redirect: "error", signal: controller.signal });
          const statusBody = await readBounded(statusResponse, MAX_RESPONSE_BYTES);
          if (!statusResponse.ok) throw errorFromResponse(statusResponse.status, statusBody);
          task = JSON.parse(statusBody) as Record<string, unknown>;
        }
        if (task.status !== "succeeded") {
          const detail = typeof task.error === "object" && task.error !== null ? task.error as Record<string, unknown> : {};
          const code = typeof detail.code === "string" ? detail.code : `TASK_${String(task.status).toUpperCase()}`;
          throw new CloudSkillError(code, publicMessage(code), detail.retryable === true);
        }
        return task.output;
      } catch (error) {
        if (controller.signal.aborted) {
          if (taskId) await fetchImpl(`${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST", headers: { Authorization: `Bearer ${credentials.deviceToken}`, "Content-Type": "application/json", "X-LongHub-Agent-ID": request.agent_id }, body: "{}", redirect: "error" }).catch(() => undefined);
          if (callerSignal?.aborted) throw new CloudSkillError("REQUEST_CANCELLED", "LongHub Cloud Skill 请求已取消");
          throw new CloudSkillError("CLOUD_API_TIMEOUT", "LongHub Cloud Skill 请求超时", true);
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        callerSignal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

export function createCloudSkillClientFromEnv(env: NodeJS.ProcessEnv = process.env, options: Omit<CloudSkillClientOptions, "baseUrl"> = {}): CloudSkillClient {
  return createCloudSkillClient({ ...options, baseUrl: env[LONGHUB_CLOUD_API_URL_ENV]?.trim() || DEFAULT_LONGHUB_CLOUD_API_URL });
}
