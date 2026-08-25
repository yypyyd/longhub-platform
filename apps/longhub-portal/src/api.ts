/**
 * LongHub Portal API 客户端。
 *
 * Portal 只消费当前的账号、设备和 Cloud Skill 订阅契约。用户本地
 * OpenClaw 的配置、会话和第三方能力不经过这里，也不由这里授权。
 */
const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

export interface Me {
  user_id: string;
  email: string;
  status: string;
  created_at: string;
}

export interface CloudSkillPlan {
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

export type CloudSkillOrderStatus = "pending" | "paid" | "cancelled" | "refunded";

export interface CloudSkillOrder {
  order_id: string;
  user_id: string;
  type: "cloud_skill_plan";
  plan_id: string;
  tenant_id?: string;
  period: "monthly" | "yearly";
  amount_fen: number;
  status: CloudSkillOrderStatus;
  created_at: string;
  paid_at?: string;
  refunded_at?: string;
}

export interface CloudSkillSubscription {
  subscription_id: string;
  user_id: string;
  tenant_id: string;
  plan_id: string;
  status: "active" | "cancelled" | "expired" | "refunded" | "suspended";
  period: "monthly" | "yearly";
  starts_at: string;
  expires_at: string;
  cancelled_at?: string;
  refunded_at?: string;
  source_order_id: string;
  created_at: string;
}

export interface CloudSkillEntitlement {
  entitlement_id: string;
  subscription_id: string;
  tenant_id: string;
  user_id: string;
  skill_id: string;
  plan_id: string;
  status: "active" | "suspended" | "revoked";
  expires_at: string;
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

/** Result of the one-time longhub-cloud CLI → Portal possession proof. */
export interface PairDeviceResult {
  device: Device;
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
    /** 发布门禁写入的当前产品身份；首发只允许免费 LongHub Manager。 */
    product_surface: "longhub-manager";
  };
  signature_key_id: string;
  signature: string;
}

export interface CloudCliRelease {
  schema_version: "longhub/cloud-cli-release/v1";
  product_surface: "longhub-cloud-cli";
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
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 0,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * 调用同源 API，并把非 JSON/错误响应转换为稳定的 ApiError。
 * 生产页面不直接拼接服务端堆栈或内部 URL。
 */
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; token?: string } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError("NETWORK_UNAVAILABLE", "网络暂时不可用", 0);
  }

  const raw = await response.text();
  let json: (T & { code?: string; message?: string }) | undefined;
  if (raw.trim()) {
    try {
      json = JSON.parse(raw) as T & { code?: string; message?: string };
    } catch {
      json = undefined;
    }
  }

  if (!response.ok) {
    throw new ApiError(
      json?.code ?? (response.status === 404 ? "NOT_FOUND" : "REQUEST_FAILED"),
      json?.message ?? "请求暂时无法完成",
      response.status,
    );
  }
  if (!json) {
    throw new ApiError("INVALID_RESPONSE", "服务返回了无法识别的响应", response.status);
  }
  return json;
}

export function yuan(fen: number): string {
  if (!Number.isFinite(fen) || fen < 0) return "—";
  return `¥${(fen / 100).toFixed(2).replace(/\.00$/, "")}`;
}
