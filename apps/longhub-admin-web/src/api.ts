/** 管理后台 API 客户端：默认同源（nginx 反代 /v1），可用 VITE_API_BASE 覆盖。 */
import { isValidManagerInstallerFilename } from "./manager-release-model";
const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

export interface Metrics {
  users_total: number;
  devices_total: number;
  operations: {
    window_hours: 24;
    client_starts: number;
    previous_exit_clean: number;
    previous_exit_unclean: number;
    crash_rate: number | null;
    model_requests: number;
    model_successes: number;
    model_success_rate: number | null;
    model_latency_buckets: Record<"lt_1s" | "1_to_3s" | "3_to_10s" | "10_to_30s" | "gte_30s", number>;
    update_healthy: number;
    update_failed: number;
    update_rollback: number;
    update_success_rate: number | null;
    product_errors: number;
    top_product_errors: Array<{ code: string; count: number }>;
    manager_versions: Array<{ version: string; count: number }>;
  };
  model_usage: {
    requests: number;
    input_tokens: number;
    output_tokens: number;
    cache_tokens: number;
    estimated_tokens: number;
    cost_microunits: number;
  };
}

export interface AdminUser {
  user_id: string;
  email: string;
  status: string;
  created_at: string;
}

export interface AdminDevice {
  device_id: string;
  tenant_id: string;
  status: string;
  platform: string;
  app_version: string;
  display_name?: string;
  user_id?: string;
  last_seen_at?: string;
  last_model_success_at?: string;
  last_error_code?: string;
  credential_rotated_at?: string;
  min_required_version?: string;
  rollout_group?: string;
  created_at: string;
}

export interface AdminOrder {
  order_id: string;
  user_id: string;
  type: "cloud_skill_plan";
  plan_id?: string;
  tenant_id?: string;
  period?: string;
  amount_fen: number;
  status: string;
  created_at: string;
  paid_at?: string;
}

export interface AdminAudit {
  audit_id: string;
  actor: string;
  action: string;
  detail?: unknown;
  created_at: string;
}

export interface ManagerRelease {
  manifest: {
    schema_version: "longhub/client-update/v2";
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
    rollback_data_strategy: "snapshot_required" | "backward_compatible";
    rollout: {
      status: "active" | "paused";
      basis_points: number;
      seed: string;
      updated_at: string;
    };
    /** clean-launch 发布面只接受免费 LongHub Manager。 */
    product_surface: "longhub-manager";
  };
  signature_key_id: string;
  signature: string;
  uploaded_by: string;
  uploaded_at: string;
  rollout_updated_by: string;
  rollout_updated_at: string;
  url: string;
}

export type CloudArtifactSurface = "cloud-plugin" | "cloud-cli";

export interface CloudArtifactRelease {
  manifest: {
    schema_version: "longhub/cloud-plugin-release/v1" | "longhub/cloud-cli-release/v1";
    product_surface: "longhub-cloud-plugin" | "longhub-cloud-cli";
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
    rollout: {
      status: "active" | "paused";
      basis_points: number;
      seed: string;
      updated_at: string;
    };
    signature_key_id: string;
    signature: string;
  };
  uploaded_by: string;
  uploaded_at: string;
  rollout_updated_by: string;
  rollout_updated_at: string;
  withdrawn_by?: string;
  withdrawn_at?: string;
  url: string;
}

/** 云端 Skill 的商业记录；用户本地 OpenClaw 不属于此域。 */
export interface AdminCloudSkillPlan {
  plan_id: string;
  name: string;
  description: string;
  skill_ids: string[];
  price_monthly_fen: number;
  price_yearly_fen: number;
  included_calls: number;
  requests_per_minute: number;
  max_concurrency: number;
  status: "listed" | "unlisted";
  created_at: string;
}

export interface AdminCloudSkillSubscription {
  subscription_id: string;
  user_id: string;
  tenant_id: string;
  plan_id: string;
  status: "active" | "cancelled" | "expired" | "refunded" | "suspended";
  period: "monthly" | "yearly";
  starts_at: string;
  expires_at: string;
  source_order_id: string;
  created_at: string;
  cancelled_at?: string;
  refunded_at?: string;
}

/** 云端 Skill 薄适配器的发布元数据；制品正文不会在列表接口中返回。 */
export interface AdminCloudSkillAdapterRelease {
  skill_id: string;
  version: string;
  status: "active" | "revoked";
  digest: string;
  signature_key_id: string;
  min_manager_version: string;
  openclaw_version: string;
  compatibility: {
    manager_min_version: string;
    openclaw_version: string;
  };
  created_at: string;
  revoked_at?: string;
}

export interface AdminModelConfig {
  configured: boolean;
  config_id: string;
  scope_type: "global" | "tenant" | "plan" | "device";
  scope_id: string;
  enabled: boolean;
  emergency_disabled: boolean;
  base_url: string;
  model_id: string;
  display_name: string;
  api_type: "openai-completions" | "openai-responses";
  context_window: number;
  max_tokens: number;
  has_api_key: boolean;
  encryption_ready: boolean;
  request_timeout_ms: number;
  max_retries: number;
  min_manager_version: string;
  device_requests_per_minute: number;
  device_daily_tokens: number;
  tenant_monthly_tokens: number;
  max_device_concurrency: number;
  updated_at?: string;
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; token?: string } = {},
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const raw = await res.text();
  let json: (T & { code?: string; message?: string }) | undefined;
  try {
    json = JSON.parse(raw) as T & { code?: string; message?: string };
  } catch {
    json = undefined;
  }
  if (!res.ok) throw new ApiError(json?.code ?? (res.status === 404 ? "NOT_FOUND" : "ERROR"), json?.message ?? "请求失败");
  if (!json) throw new ApiError("INVALID_RESPONSE", "服务返回了无法识别的响应");
  return json;
}

/** 上传 LongHub Manager 安装包（二进制流）；服务端继续使用既有 client-releases 路由。 */
export async function uploadManagerRelease(token: string, version: string, file: File): Promise<ManagerRelease> {
  if (!isValidManagerInstallerFilename(version, file.name)) {
    throw new ApiError("INVALID_MANAGER_RELEASE_FILENAME", "Manager 安装包文件名必须与版本匹配：LongHub-Manager-Setup-x.y.z.exe");
  }
  const query = `version=${encodeURIComponent(version)}&filename=${encodeURIComponent(file.name)}`;
  const res = await fetch(`${BASE}/v1/admin/client-releases?${query}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
    body: file,
  });
  const raw = await res.text();
  let json: { release?: ManagerRelease; code?: string; message?: string } | undefined;
  try {
    json = JSON.parse(raw) as { release?: ManagerRelease; code?: string; message?: string };
  } catch {
    json = undefined;
  }
  if (!res.ok) throw new ApiError(json?.code ?? "ERROR", json?.message ?? "上传失败");
  if (!json?.release) throw new ApiError("INVALID_RESPONSE", "服务未返回版本信息");
  return json.release;
}

export async function uploadCloudArtifactRelease(
  token: string,
  surface: CloudArtifactSurface,
  version: string,
  file: File,
): Promise<CloudArtifactRelease> {
  const expected = surface === "cloud-plugin"
    ? `longhub-openclaw-cloud-plugin-${version}.tgz`
    : `longhub-cloud-cli-${version}.tgz`;
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version) || file.name !== expected) {
    throw new ApiError("INVALID_CLOUD_ARTIFACT_FILENAME", `制品文件名必须为 ${expected}`);
  }
  const query = new URLSearchParams({ version, filename: file.name, channel: "stable" });
  const res = await fetch(`${BASE}/v1/admin/${surface}-releases?${query}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
    body: file,
  });
  const raw = await res.text();
  let json: { release?: CloudArtifactRelease; code?: string; message?: string } | undefined;
  try { json = JSON.parse(raw) as typeof json; } catch { json = undefined; }
  if (!res.ok) throw new ApiError(json?.code ?? "UPLOAD_FAILED", json?.message ?? "制品上传失败");
  if (!json?.release) throw new ApiError("INVALID_RESPONSE", "服务未返回制品发布信息");
  return json.release;
}

export function yuan(fen: number): string {
  return `¥${(fen / 100).toFixed(2).replace(/\.00$/, "")}`;
}
