/**
 * 控制面存储端口：任务、设备（Identity）、授权（Entitlement）、套装发布（Release/Artifact）。
 * MemoryStore 用于测试与原型，PgStore 为 PostgreSQL 持久化实现。
 */

import type { PackFile } from "@longhub/pack-schema";

export type CloudTaskStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";

export interface CloudTask {
  task_id: string;
  kind: string;
  status: CloudTaskStatus;
  input: unknown;
  output?: unknown;
  error?: { code: string; message: string; retryable: boolean };
  created_at: string;
  updated_at: string;
}

export interface CloudTaskEvent {
  event_id: string;
  task_id: string;
  type: string;
  ts: string;
  [key: string]: unknown;
}

export type EventListener = (event: CloudTaskEvent) => void;

export interface DeviceRecord {
  device_id: string;
  tenant_id: string;
  status: "active" | "revoked";
  platform: string;
  app_version: string;
  device_fingerprint: string;
  display_name?: string;
  /** 设备凭据，仅注册时下发；正式版换 Windows Credential Manager 保存的刷新凭据 */
  device_token: string;
  /** 绑定的用户账号；未绑定为 undefined */
  user_id?: string;
  created_at: string;
}

// ===== 账号 / 管理员 / 计费（P0 商业化） =====

export interface UserRecord {
  user_id: string;
  email: string;
  password_hash: string;
  status: "active" | "disabled";
  /** 钱包余额，单位分 */
  balance_fen: number;
  created_at: string;
}

export interface SessionRecord {
  token: string;
  subject_type: "user" | "admin";
  subject_id: string;
  expires_at: string;
  created_at: string;
}

export type AdminRole = "super" | "ops" | "support";

export interface AdminRecord {
  admin_id: string;
  username: string;
  password_hash: string;
  role: AdminRole;
  status: "active" | "disabled";
  created_at: string;
}

export interface AuditLogRecord {
  audit_id: string;
  actor: string;
  action: string;
  detail?: unknown;
  created_at: string;
}

export interface ProductRecord {
  product_id: string;
  pack_id: string;
  name: string;
  description: string;
  price_monthly_fen: number;
  price_yearly_fen: number;
  status: "listed" | "unlisted";
  created_at: string;
}

export type OrderStatus = "pending" | "paid" | "cancelled" | "refunded";

export interface OrderRecord {
  order_id: string;
  user_id: string;
  type: "plan" | "recharge";
  product_id?: string;
  pack_id?: string;
  period?: "monthly" | "yearly";
  amount_fen: number;
  status: OrderStatus;
  pay_method?: "balance" | "mock";
  created_at: string;
  paid_at?: string;
}

export interface WalletTransactionRecord {
  txn_id: string;
  user_id: string;
  type: "recharge" | "purchase" | "refund" | "adjust";
  /** 变动金额（分），正为入账、负为出账 */
  amount_fen: number;
  balance_after_fen: number;
  order_id?: string;
  remark?: string;
  created_at: string;
}

export interface EntitlementRecord {
  entitlement_id: string;
  tenant_id: string;
  device_id: string;
  pack_id: string;
  scope: "tenant" | "user" | "device";
  status: "active" | "suspended" | "revoked";
  expires_at: string;
  created_at: string;
}

/** 已签名的套装发布记录（Release + Artifact 合一，MVP 用 JSON 制品） */
export interface PackReleaseRecord {
  pack_id: string;
  version: string;
  status: "active" | "revoked";
  pack: PackFile;
  digest: string;
  signature_key_id: string;
  min_desktop_version: string;
  created_at: string;
}

export const TASK_EVENT_TYPE: Record<CloudTaskStatus, string> = {
  pending: "task.accepted",
  running: "task.started",
  succeeded: "task.succeeded",
  failed: "task.failed",
  cancelled: "task.cancelled",
  timed_out: "task.timed_out",
};

export interface CloudStore {
  // 任务模块
  createTask(idempotencyKey: string, kind: string, input: unknown): Promise<{ task: CloudTask; existed: boolean }>;
  getTask(taskId: string): Promise<CloudTask | undefined>;
  transition(taskId: string, status: CloudTaskStatus, patch?: Partial<CloudTask>): Promise<CloudTask>;
  /** 返回 afterEventId 之后的历史事件（用于 SSE Last-Event-ID 重放） */
  eventsAfter(taskId: string, afterEventId?: string): Promise<CloudTaskEvent[]>;
  /** 实时事件订阅（单实例进程内；多实例部署换 Redis 发布订阅） */
  subscribe(taskId: string, listener: EventListener): () => void;

  // Identity：设备注册与凭据
  registerDevice(params: {
    tenant_id: string;
    platform: string;
    app_version: string;
    device_fingerprint: string;
    display_name?: string;
  }): Promise<{ device: DeviceRecord; existed: boolean }>;
  getDevice(deviceId: string): Promise<DeviceRecord | undefined>;
  findDeviceByToken(token: string): Promise<DeviceRecord | undefined>;
  listDevices(userId?: string): Promise<DeviceRecord[]>;
  bindDevice(deviceId: string, userId: string): Promise<DeviceRecord | undefined>;

  // Account：用户账号与会话
  createUser(params: { email: string; password_hash: string }): Promise<{ user: UserRecord; existed: boolean }>;
  getUser(userId: string): Promise<UserRecord | undefined>;
  getUserByEmail(email: string): Promise<UserRecord | undefined>;
  listUsers(): Promise<UserRecord[]>;
  setUserStatus(userId: string, status: "active" | "disabled"): Promise<UserRecord | undefined>;
  createSession(params: { subject_type: "user" | "admin"; subject_id: string; token: string; expires_at: string }): Promise<SessionRecord>;
  getSession(token: string): Promise<SessionRecord | undefined>;
  deleteSession(token: string): Promise<void>;

  // Admin：管理员账号与审计
  createAdmin(params: { username: string; password_hash: string; role: AdminRole }): Promise<{ admin: AdminRecord; existed: boolean }>;
  getAdmin(adminId: string): Promise<AdminRecord | undefined>;
  getAdminByUsername(username: string): Promise<AdminRecord | undefined>;
  appendAudit(actor: string, action: string, detail?: unknown): Promise<AuditLogRecord>;
  listAudits(limit?: number): Promise<AuditLogRecord[]>;

  // Catalog：商品（套装定价）
  createProduct(params: {
    pack_id: string;
    name: string;
    description: string;
    price_monthly_fen: number;
    price_yearly_fen: number;
    status?: "listed" | "unlisted";
  }): Promise<ProductRecord>;
  updateProduct(
    productId: string,
    patch: Partial<Pick<ProductRecord, "name" | "description" | "price_monthly_fen" | "price_yearly_fen" | "status">>,
  ): Promise<ProductRecord | undefined>;
  getProduct(productId: string): Promise<ProductRecord | undefined>;
  listProducts(): Promise<ProductRecord[]>;

  // Billing：订单与钱包
  createOrder(params: {
    user_id: string;
    type: "plan" | "recharge";
    product_id?: string;
    pack_id?: string;
    period?: "monthly" | "yearly";
    amount_fen: number;
  }): Promise<OrderRecord>;
  getOrder(orderId: string): Promise<OrderRecord | undefined>;
  updateOrder(orderId: string, patch: Partial<Pick<OrderRecord, "status" | "pay_method" | "paid_at">>): Promise<OrderRecord | undefined>;
  listOrders(userId?: string): Promise<OrderRecord[]>;
  /** 记账并原子更新余额；余额不足时抛错 */
  addWalletTransaction(params: {
    user_id: string;
    type: "recharge" | "purchase" | "refund" | "adjust";
    amount_fen: number;
    order_id?: string;
    remark?: string;
  }): Promise<WalletTransactionRecord>;
  listTransactions(userId?: string): Promise<WalletTransactionRecord[]>;
  listAllEntitlements(): Promise<EntitlementRecord[]>;

  // Entitlement：授权与撤销
  grantEntitlement(params: {
    tenant_id: string;
    device_id: string;
    pack_id: string;
    scope?: "tenant" | "user" | "device";
    expires_at?: string;
  }): Promise<EntitlementRecord>;
  revokeEntitlement(entitlementId: string): Promise<EntitlementRecord | undefined>;
  listEntitlements(deviceId: string): Promise<EntitlementRecord[]>;

  // Release/Artifact：套装发布、下载与吊销
  publishRelease(params: {
    pack: PackFile;
    digest: string;
    signature_key_id: string;
  }): Promise<{ release: PackReleaseRecord; existed: boolean }>;
  getRelease(packId: string, version: string): Promise<PackReleaseRecord | undefined>;
  listReleases(packId?: string): Promise<PackReleaseRecord[]>;
  revokeRelease(packId: string, version: string): Promise<PackReleaseRecord | undefined>;

  close(): Promise<void>;
}
