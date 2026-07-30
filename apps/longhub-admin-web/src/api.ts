/** 管理后台 API 客户端：默认同源（nginx 反代 /v1），可用 VITE_API_BASE 覆盖。 */
const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

export interface Metrics {
  users_total: number;
  devices_total: number;
  orders_paid_total: number;
  revenue_fen: number;
  releases_total: number;
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
    desktop_versions: Array<{ version: string; count: number }>;
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
  balance_fen: number;
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
  activation_code_id?: string;
  activated_at?: string;
  last_seen_at?: string;
  last_model_success_at?: string;
  last_error_code?: string;
  credential_rotated_at?: string;
  min_required_version?: string;
  rollout_group?: string;
  created_at: string;
}

export interface AdminActivationCode {
  activation_code_id: string;
  tenant_id: string;
  code_hint: string;
  label?: string;
  status: "active" | "revoked";
  max_uses: number;
  use_count: number;
  pack_ids: string[];
  expires_at: string;
  created_at: string;
}

export interface AdminEntitlement {
  entitlement_id: string;
  device_id: string;
  pack_id: string;
  scope: string;
  status: string;
  expires_at: string;
  created_at: string;
}

export interface AdminRelease {
  pack_id: string;
  version: string;
  status: string;
  digest: string;
  signature_key_id: string;
  min_desktop_version: string;
  created_at: string;
}

export interface AdminProduct {
  product_id: string;
  pack_id: string;
  name: string;
  description: string;
  price_monthly_fen: number;
  price_yearly_fen: number;
  status: "listed" | "unlisted";
  created_at: string;
}

export interface AdminOrder {
  order_id: string;
  user_id: string;
  type: "plan" | "recharge";
  pack_id?: string;
  period?: string;
  amount_fen: number;
  status: string;
  pay_method?: string;
  created_at: string;
  paid_at?: string;
}

export interface AdminTxn {
  txn_id: string;
  user_id: string;
  type: string;
  amount_fen: number;
  balance_after_fen: number;
  order_id?: string;
  remark?: string;
  created_at: string;
}

export interface AdminAudit {
  audit_id: string;
  actor: string;
  action: string;
  detail?: unknown;
  created_at: string;
}

export interface ClientRelease {
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
  };
  signature_key_id: string;
  signature: string;
  uploaded_by: string;
  uploaded_at: string;
  rollout_updated_by: string;
  rollout_updated_at: string;
  url: string;
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
  min_desktop_version: string;
  assistant_name: string;
  welcome_message: string;
  device_requests_per_minute: number;
  device_daily_tokens: number;
  tenant_monthly_tokens: number;
  max_device_concurrency: number;
  updated_at?: string;
}

export interface AdminKnowledgeDocument {
  document_id: string;
  tenant_id: string;
  title: string;
  source_label: string;
  bytes: number;
  created_at: string;
}

export interface AdminPackReview {
  review_id: string;
  publisher: string;
  pack_id: string;
  version: string;
  status: "submitted" | "rejected" | "approved" | "published";
  findings: string[];
  created_at: string;
  updated_at: string;
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, options: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const json = (await res.json()) as T & { code?: string; message?: string };
  if (!res.ok) throw new ApiError(json.code ?? "ERROR", json.message ?? "请求失败");
  return json;
}

/** 上传客户端安装包（二进制流） */
export async function uploadClientRelease(token: string, version: string, file: File): Promise<ClientRelease> {
  const query = `version=${encodeURIComponent(version)}&filename=${encodeURIComponent(file.name)}`;
  const res = await fetch(`${BASE}/v1/admin/client-releases?${query}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
    body: file,
  });
  const json = (await res.json()) as { release: ClientRelease; code?: string; message?: string };
  if (!res.ok) throw new ApiError(json.code ?? "ERROR", json.message ?? "上传失败");
  return json.release;
}

export function yuan(fen: number): string {
  return `¥${(fen / 100).toFixed(2).replace(/\.00$/, "")}`;
}
