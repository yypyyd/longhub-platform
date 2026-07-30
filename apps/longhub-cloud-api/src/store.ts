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
  /** 首次核销成功后绑定的授权码；设备注册本身不代表获得产品使用权 */
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

export interface ActivationCodeRecord {
  activation_code_id: string;
  tenant_id: string;
  /** 只保存规范化授权码的 SHA-256；明文仅在创建响应中返回一次 */
  code_hash: string;
  code_hint: string;
  label?: string;
  status: "active" | "revoked";
  max_uses: number;
  use_count: number;
  pack_ids: string[];
  expires_at: string;
  created_at: string;
}

export type ActivationRedemptionResult =
  | { ok: true; code: ActivationCodeRecord; device: DeviceRecord; alreadyActivated: boolean }
  | { ok: false; reason: "DEVICE_NOT_FOUND" | "CODE_UNAVAILABLE" };

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
  source_activation_code_id?: string;
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

/** 服务端模型网关配置。上游 API Key 只以密文形式持久化。 */
export interface ModelGatewayConfigRecord {
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
  encrypted_api_key?: string;
  fallback_config_id?: string;
  request_timeout_ms: number;
  max_retries: number;
  circuit_breaker_threshold: number;
  circuit_breaker_cooldown_ms: number;
  min_desktop_version: string;
  max_desktop_version?: string;
  assistant_name: string;
  assistant_avatar_path: string;
  welcome_message: string;
  quick_tasks: string[];
  features: {
    agent_catalog: boolean;
    file_upload: boolean;
    tool_execution: boolean;
  };
  device_requests_per_minute: number;
  device_daily_tokens: number;
  tenant_monthly_tokens: number;
  max_device_concurrency: number;
  input_cost_microunits_per_million: number;
  output_cost_microunits_per_million: number;
  cache_cost_microunits_per_million: number;
  updated_at: string;
}

export interface ModelUsageAggregateRecord {
  period_start: string;
  period: "day" | "month";
  tenant_id: string;
  device_id: string;
  config_id: string;
  request_count: number;
  success_count: number;
  error_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
  estimated_tokens: number;
  cost_microunits: number;
}

export interface KnowledgeDocumentRecord {
  document_id: string;
  tenant_id: string;
  title: string;
  source_label: string;
  content: string;
  created_at: string;
}

export interface PackReviewRecord {
  review_id: string;
  publisher: string;
  pack: PackFile;
  status: "submitted" | "rejected" | "approved" | "published";
  findings: string[];
  created_at: string;
  updated_at: string;
}

/**
 * 匿名客户端遥测的小时级聚合行。这里没有设备、用户、租户或会话字段，调用方也
 * 不能传任意维度；value 只来自共享遥测契约中的固定枚举。
 */
export interface ClientTelemetryAggregateRecord {
  bucket_start: string;
  event_type: "client_started" | "gateway_state" | "client_update_result" | "product_error" | "previous_exit";
  desktop_version: string;
  openclaw_version: string;
  platform: "win32";
  architecture: "x64" | "arm64";
  value: string;
  agent_count_bucket: string;
  count: number;
}

export interface ModelRequestAggregateRecord {
  bucket_start: string;
  api_type: "openai-completions" | "openai-responses";
  outcome: "success" | "upstream_rejected" | "network_error" | "timeout";
  latency_bucket: "lt_1s" | "1_to_3s" | "3_to_10s" | "10_to_30s" | "gte_30s";
  count: number;
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
  updateDeviceOperations(deviceId: string, patch: Partial<Pick<DeviceRecord, "status" | "last_seen_at" | "last_model_success_at" | "last_error_code" | "credential_rotated_at" | "min_required_version" | "rollout_group" | "device_token">>): Promise<DeviceRecord | undefined>;

  // Activation：授权码只保存摘要，核销必须原子消耗次数并绑定设备
  createActivationCode(params: {
    tenant_id: string;
    code_hash: string;
    code_hint: string;
    label?: string;
    max_uses: number;
    pack_ids: string[];
    expires_at: string;
  }): Promise<ActivationCodeRecord>;
  getActivationCode(activationCodeId: string): Promise<ActivationCodeRecord | undefined>;
  listActivationCodes(): Promise<ActivationCodeRecord[]>;
  revokeActivationCode(activationCodeId: string): Promise<ActivationCodeRecord | undefined>;
  redeemActivationCode(params: {
    device_id: string;
    code_hash: string;
    now: string;
  }): Promise<ActivationRedemptionResult>;

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

  // Model Gateway：global/tenant/plan/device 分层策略；设备优先级最高
  getModelGatewayConfig(configId?: string): Promise<ModelGatewayConfigRecord | undefined>;
  listModelGatewayConfigs(): Promise<ModelGatewayConfigRecord[]>;
  setModelGatewayConfig(config: ModelGatewayConfigRecord): Promise<ModelGatewayConfigRecord>;

  // Telemetry：仅保存严格枚举的小时级匿名聚合，不保存逐设备原始事件
  incrementClientTelemetry(records: readonly ClientTelemetryAggregateRecord[]): Promise<void>;
  listClientTelemetry(): Promise<ClientTelemetryAggregateRecord[]>;
  incrementModelRequestMetrics(records: readonly ModelRequestAggregateRecord[]): Promise<void>;
  listModelRequestMetrics(): Promise<ModelRequestAggregateRecord[]>;
  incrementModelUsage(records: readonly ModelUsageAggregateRecord[]): Promise<void>;
  listModelUsage(): Promise<ModelUsageAggregateRecord[]>;
  createKnowledgeDocument(params: Omit<KnowledgeDocumentRecord, "document_id" | "created_at">): Promise<KnowledgeDocumentRecord>;
  listKnowledgeDocuments(tenantId: string): Promise<KnowledgeDocumentRecord[]>;
  deleteKnowledgeDocument(documentId: string): Promise<KnowledgeDocumentRecord | undefined>;
  createPackReview(params: { publisher: string; pack: PackFile; findings: string[] }): Promise<PackReviewRecord>;
  getPackReview(reviewId: string): Promise<PackReviewRecord | undefined>;
  listPackReviews(): Promise<PackReviewRecord[]>;
  updatePackReview(reviewId: string, patch: Pick<PackReviewRecord, "status" | "findings">): Promise<PackReviewRecord | undefined>;

  close(): Promise<void>;
}
