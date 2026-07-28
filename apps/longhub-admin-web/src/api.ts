/** 管理后台 API 客户端：默认同源（nginx 反代 /v1），可用 VITE_API_BASE 覆盖。 */
const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

export interface Metrics {
  users_total: number;
  devices_total: number;
  orders_paid_total: number;
  revenue_fen: number;
  releases_total: number;
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
  version: string;
  filename: string;
  size: number;
  uploaded_by: string;
  uploaded_at: string;
  url: string;
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
