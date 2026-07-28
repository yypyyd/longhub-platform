/** 官网 API 客户端：默认同源（nginx 反代 /v1），可用 VITE_API_BASE 覆盖。 */
const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

export interface Me {
  user_id: string;
  email: string;
  status: string;
  balance_fen: number;
  created_at: string;
}

export interface Product {
  product_id: string;
  pack_id: string;
  name: string;
  description: string;
  price_monthly_fen: number;
  price_yearly_fen: number;
  status: string;
}

export interface Order {
  order_id: string;
  type: "plan" | "recharge";
  product_id?: string;
  pack_id?: string;
  period?: string;
  amount_fen: number;
  status: string;
  created_at: string;
  paid_at?: string;
}

export interface Txn {
  txn_id: string;
  type: string;
  amount_fen: number;
  balance_after_fen: number;
  remark?: string;
  created_at: string;
}

export interface Device {
  device_id: string;
  status: string;
  platform: string;
  app_version: string;
  display_name?: string;
  created_at: string;
}

export interface Entitlement {
  entitlement_id: string;
  device_id: string;
  pack_id: string;
  status: string;
  expires_at: string;
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

export function yuan(fen: number): string {
  return `¥${(fen / 100).toFixed(2).replace(/\.00$/, "")}`;
}
