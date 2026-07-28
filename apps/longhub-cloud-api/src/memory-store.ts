/** 内存存储实现：用于测试与本地原型；生产部署使用 PgStore。 */
import { randomUUID } from "node:crypto";
import type { PackFile } from "@longhub/pack-schema";
import {
  TASK_EVENT_TYPE,
  type AdminRecord,
  type AdminRole,
  type AuditLogRecord,
  type CloudStore,
  type CloudTask,
  type CloudTaskEvent,
  type CloudTaskStatus,
  type DeviceRecord,
  type EntitlementRecord,
  type EventListener,
  type OrderRecord,
  type PackReleaseRecord,
  type ProductRecord,
  type SessionRecord,
  type UserRecord,
  type WalletTransactionRecord,
} from "./store.js";

const FAR_FUTURE = "2099-12-31T00:00:00.000Z";

export class MemoryStore implements CloudStore {
  private readonly tasks = new Map<string, CloudTask>();
  private readonly eventsByTask = new Map<string, CloudTaskEvent[]>();
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly idempotency = new Map<string, string>();
  private readonly devices = new Map<string, DeviceRecord>();
  private readonly entitlements = new Map<string, EntitlementRecord>();
  private readonly releases = new Map<string, PackReleaseRecord>();
  private readonly users = new Map<string, UserRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly admins = new Map<string, AdminRecord>();
  private readonly audits: AuditLogRecord[] = [];
  private readonly products = new Map<string, ProductRecord>();
  private readonly orders = new Map<string, OrderRecord>();
  private readonly transactions: WalletTransactionRecord[] = [];
  private taskSeq = 0;
  private eventSeq = 0;

  async createTask(idempotencyKey: string, kind: string, input: unknown): Promise<{ task: CloudTask; existed: boolean }> {
    const existingId = this.idempotency.get(idempotencyKey);
    if (existingId !== undefined) {
      return { task: this.mustGet(existingId), existed: true };
    }
    const now = new Date().toISOString();
    const task: CloudTask = {
      task_id: `ct-${++this.taskSeq}`,
      kind,
      status: "pending",
      input,
      created_at: now,
      updated_at: now,
    };
    this.tasks.set(task.task_id, task);
    this.eventsByTask.set(task.task_id, []);
    this.idempotency.set(idempotencyKey, task.task_id);
    this.emit(task.task_id, "task.accepted");
    return { task, existed: false };
  }

  async getTask(taskId: string): Promise<CloudTask | undefined> {
    return this.tasks.get(taskId);
  }

  async transition(taskId: string, status: CloudTaskStatus, patch?: Partial<CloudTask>): Promise<CloudTask> {
    const task = this.mustGet(taskId);
    Object.assign(task, patch);
    task.status = status;
    task.updated_at = new Date().toISOString();
    this.emit(taskId, TASK_EVENT_TYPE[status], task.error ? { error: task.error } : undefined);
    return task;
  }

  async eventsAfter(taskId: string, afterEventId?: string): Promise<CloudTaskEvent[]> {
    const events = this.eventsByTask.get(taskId) ?? [];
    if (afterEventId === undefined) return [...events];
    const after = Number(afterEventId);
    return events.filter((e) => Number(e.event_id) > after);
  }

  subscribe(taskId: string, listener: EventListener): () => void {
    let set = this.listeners.get(taskId);
    if (!set) {
      set = new Set();
      this.listeners.set(taskId, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  async registerDevice(params: {
    tenant_id: string;
    platform: string;
    app_version: string;
    device_fingerprint: string;
    display_name?: string;
  }): Promise<{ device: DeviceRecord; existed: boolean }> {
    for (const device of this.devices.values()) {
      if (
        device.tenant_id === params.tenant_id &&
        device.device_fingerprint === params.device_fingerprint &&
        device.status === "active"
      ) {
        return { device, existed: true };
      }
    }
    const device: DeviceRecord = {
      device_id: `dev-${randomUUID()}`,
      tenant_id: params.tenant_id,
      status: "active",
      platform: params.platform,
      app_version: params.app_version,
      device_fingerprint: params.device_fingerprint,
      display_name: params.display_name,
      device_token: `dt-${randomUUID()}${randomUUID()}`,
      created_at: new Date().toISOString(),
    };
    this.devices.set(device.device_id, device);
    return { device, existed: false };
  }

  async getDevice(deviceId: string): Promise<DeviceRecord | undefined> {
    return this.devices.get(deviceId);
  }

  async findDeviceByToken(token: string): Promise<DeviceRecord | undefined> {
    for (const device of this.devices.values()) {
      if (device.device_token === token) return device;
    }
    return undefined;
  }

  async listDevices(userId?: string): Promise<DeviceRecord[]> {
    return [...this.devices.values()].filter((d) => userId === undefined || d.user_id === userId);
  }

  async bindDevice(deviceId: string, userId: string): Promise<DeviceRecord | undefined> {
    const device = this.devices.get(deviceId);
    if (!device) return undefined;
    device.user_id = userId;
    return device;
  }

  async createUser(params: { email: string; password_hash: string }): Promise<{ user: UserRecord; existed: boolean }> {
    for (const user of this.users.values()) {
      if (user.email === params.email) return { user, existed: true };
    }
    const user: UserRecord = {
      user_id: `usr-${randomUUID()}`,
      email: params.email,
      password_hash: params.password_hash,
      status: "active",
      balance_fen: 0,
      created_at: new Date().toISOString(),
    };
    this.users.set(user.user_id, user);
    return { user, existed: false };
  }

  async getUser(userId: string): Promise<UserRecord | undefined> {
    return this.users.get(userId);
  }

  async getUserByEmail(email: string): Promise<UserRecord | undefined> {
    for (const user of this.users.values()) {
      if (user.email === email) return user;
    }
    return undefined;
  }

  async listUsers(): Promise<UserRecord[]> {
    return [...this.users.values()];
  }

  async setUserStatus(userId: string, status: "active" | "disabled"): Promise<UserRecord | undefined> {
    const user = this.users.get(userId);
    if (!user) return undefined;
    user.status = status;
    return user;
  }

  async createSession(params: {
    subject_type: "user" | "admin";
    subject_id: string;
    token: string;
    expires_at: string;
  }): Promise<SessionRecord> {
    const session: SessionRecord = { ...params, created_at: new Date().toISOString() };
    this.sessions.set(session.token, session);
    return session;
  }

  async getSession(token: string): Promise<SessionRecord | undefined> {
    const session = this.sessions.get(token);
    if (!session) return undefined;
    if (session.expires_at <= new Date().toISOString()) {
      this.sessions.delete(token);
      return undefined;
    }
    return session;
  }

  async deleteSession(token: string): Promise<void> {
    this.sessions.delete(token);
  }

  async createAdmin(params: {
    username: string;
    password_hash: string;
    role: AdminRole;
  }): Promise<{ admin: AdminRecord; existed: boolean }> {
    for (const admin of this.admins.values()) {
      if (admin.username === params.username) return { admin, existed: true };
    }
    const admin: AdminRecord = {
      admin_id: `adm-${randomUUID()}`,
      username: params.username,
      password_hash: params.password_hash,
      role: params.role,
      status: "active",
      created_at: new Date().toISOString(),
    };
    this.admins.set(admin.admin_id, admin);
    return { admin, existed: false };
  }

  async getAdmin(adminId: string): Promise<AdminRecord | undefined> {
    return this.admins.get(adminId);
  }

  async getAdminByUsername(username: string): Promise<AdminRecord | undefined> {
    for (const admin of this.admins.values()) {
      if (admin.username === username) return admin;
    }
    return undefined;
  }

  async appendAudit(actor: string, action: string, detail?: unknown): Promise<AuditLogRecord> {
    const record: AuditLogRecord = {
      audit_id: `aud-${randomUUID()}`,
      actor,
      action,
      detail,
      created_at: new Date().toISOString(),
    };
    this.audits.push(record);
    return record;
  }

  async listAudits(limit = 200): Promise<AuditLogRecord[]> {
    return this.audits.slice(-limit).reverse();
  }

  async createProduct(params: {
    pack_id: string;
    name: string;
    description: string;
    price_monthly_fen: number;
    price_yearly_fen: number;
    status?: "listed" | "unlisted";
  }): Promise<ProductRecord> {
    const product: ProductRecord = {
      product_id: `prd-${randomUUID()}`,
      pack_id: params.pack_id,
      name: params.name,
      description: params.description,
      price_monthly_fen: params.price_monthly_fen,
      price_yearly_fen: params.price_yearly_fen,
      status: params.status ?? "listed",
      created_at: new Date().toISOString(),
    };
    this.products.set(product.product_id, product);
    return product;
  }

  async updateProduct(
    productId: string,
    patch: Partial<Pick<ProductRecord, "name" | "description" | "price_monthly_fen" | "price_yearly_fen" | "status">>,
  ): Promise<ProductRecord | undefined> {
    const product = this.products.get(productId);
    if (!product) return undefined;
    Object.assign(product, patch);
    return product;
  }

  async getProduct(productId: string): Promise<ProductRecord | undefined> {
    return this.products.get(productId);
  }

  async listProducts(): Promise<ProductRecord[]> {
    return [...this.products.values()];
  }

  async createOrder(params: {
    user_id: string;
    type: "plan" | "recharge";
    product_id?: string;
    pack_id?: string;
    period?: "monthly" | "yearly";
    amount_fen: number;
  }): Promise<OrderRecord> {
    const order: OrderRecord = {
      order_id: `ord-${randomUUID()}`,
      user_id: params.user_id,
      type: params.type,
      product_id: params.product_id,
      pack_id: params.pack_id,
      period: params.period,
      amount_fen: params.amount_fen,
      status: "pending",
      created_at: new Date().toISOString(),
    };
    this.orders.set(order.order_id, order);
    return order;
  }

  async getOrder(orderId: string): Promise<OrderRecord | undefined> {
    return this.orders.get(orderId);
  }

  async updateOrder(
    orderId: string,
    patch: Partial<Pick<OrderRecord, "status" | "pay_method" | "paid_at">>,
  ): Promise<OrderRecord | undefined> {
    const order = this.orders.get(orderId);
    if (!order) return undefined;
    Object.assign(order, patch);
    return order;
  }

  async listOrders(userId?: string): Promise<OrderRecord[]> {
    return [...this.orders.values()].filter((o) => userId === undefined || o.user_id === userId);
  }

  async addWalletTransaction(params: {
    user_id: string;
    type: "recharge" | "purchase" | "refund" | "adjust";
    amount_fen: number;
    order_id?: string;
    remark?: string;
  }): Promise<WalletTransactionRecord> {
    const user = this.users.get(params.user_id);
    if (!user) throw new Error(`Unknown user: ${params.user_id}`);
    const next = user.balance_fen + params.amount_fen;
    if (next < 0) throw new Error("INSUFFICIENT_BALANCE");
    user.balance_fen = next;
    const txn: WalletTransactionRecord = {
      txn_id: `txn-${randomUUID()}`,
      user_id: params.user_id,
      type: params.type,
      amount_fen: params.amount_fen,
      balance_after_fen: next,
      order_id: params.order_id,
      remark: params.remark,
      created_at: new Date().toISOString(),
    };
    this.transactions.push(txn);
    return txn;
  }

  async listTransactions(userId?: string): Promise<WalletTransactionRecord[]> {
    return this.transactions.filter((t) => userId === undefined || t.user_id === userId).slice().reverse();
  }

  async listAllEntitlements(): Promise<EntitlementRecord[]> {
    return [...this.entitlements.values()];
  }

  async grantEntitlement(params: {
    tenant_id: string;
    device_id: string;
    pack_id: string;
    scope?: "tenant" | "user" | "device";
    expires_at?: string;
  }): Promise<EntitlementRecord> {
    const record: EntitlementRecord = {
      entitlement_id: `ent-${randomUUID()}`,
      tenant_id: params.tenant_id,
      device_id: params.device_id,
      pack_id: params.pack_id,
      scope: params.scope ?? "device",
      status: "active",
      expires_at: params.expires_at ?? FAR_FUTURE,
      created_at: new Date().toISOString(),
    };
    this.entitlements.set(record.entitlement_id, record);
    return record;
  }

  async revokeEntitlement(entitlementId: string): Promise<EntitlementRecord | undefined> {
    const record = this.entitlements.get(entitlementId);
    if (!record) return undefined;
    record.status = "revoked";
    return record;
  }

  async listEntitlements(deviceId: string): Promise<EntitlementRecord[]> {
    return [...this.entitlements.values()].filter((e) => e.device_id === deviceId);
  }

  async publishRelease(params: {
    pack: PackFile;
    digest: string;
    signature_key_id: string;
  }): Promise<{ release: PackReleaseRecord; existed: boolean }> {
    const { id, version, minDesktopVersion } = params.pack.manifest.pack;
    const key = `${id}@${version}`;
    const existing = this.releases.get(key);
    if (existing) return { release: existing, existed: true };
    const release: PackReleaseRecord = {
      pack_id: id,
      version,
      status: "active",
      pack: params.pack,
      digest: params.digest,
      signature_key_id: params.signature_key_id,
      min_desktop_version: minDesktopVersion,
      created_at: new Date().toISOString(),
    };
    this.releases.set(key, release);
    return { release, existed: false };
  }

  async getRelease(packId: string, version: string): Promise<PackReleaseRecord | undefined> {
    return this.releases.get(`${packId}@${version}`);
  }

  async listReleases(packId?: string): Promise<PackReleaseRecord[]> {
    return [...this.releases.values()].filter((r) => packId === undefined || r.pack_id === packId);
  }

  async revokeRelease(packId: string, version: string): Promise<PackReleaseRecord | undefined> {
    const release = this.releases.get(`${packId}@${version}`);
    if (!release) return undefined;
    release.status = "revoked";
    return release;
  }

  async close(): Promise<void> {
    // 内存实现无需释放资源
  }

  private emit(taskId: string, type: string, extra?: Record<string, unknown>): void {
    const event: CloudTaskEvent = {
      event_id: String(++this.eventSeq),
      task_id: taskId,
      type,
      ts: new Date().toISOString(),
      ...extra,
    };
    this.eventsByTask.get(taskId)?.push(event);
    this.listeners.get(taskId)?.forEach((l) => l(event));
  }

  private mustGet(taskId: string): CloudTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    return task;
  }
}
