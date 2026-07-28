/**
 * PostgreSQL 持久化实现（建表脚本见 infrastructure/migrations/001-longhub-cloud.sql）。
 * 事件 event_id 由 BIGSERIAL 保证单调递增；实时订阅为进程内广播，
 * 多实例部署时需换 Redis 发布订阅。
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
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

interface TaskRow {
  task_id: string;
  kind: string;
  status: CloudTaskStatus;
  input: unknown;
  output: unknown;
  error: { code: string; message: string; retryable: boolean } | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  event_id: string;
  task_id: string;
  type: string;
  ts: string;
  payload: Record<string, unknown> | null;
}

interface DeviceRow {
  device_id: string;
  tenant_id: string;
  status: "active" | "revoked";
  platform: string;
  app_version: string;
  device_fingerprint: string;
  display_name: string | null;
  device_token: string;
  user_id: string | null;
  created_at: string;
}

interface UserRow {
  user_id: string;
  email: string;
  password_hash: string;
  status: "active" | "disabled";
  balance_fen: string | number;
  created_at: string;
}

interface SessionRow {
  token: string;
  subject_type: "user" | "admin";
  subject_id: string;
  expires_at: string;
  created_at: string;
}

interface AdminRow {
  admin_id: string;
  username: string;
  password_hash: string;
  role: AdminRole;
  status: "active" | "disabled";
  created_at: string;
}

interface AuditRow {
  audit_id: string;
  actor: string;
  action: string;
  detail: unknown;
  created_at: string;
}

interface ProductRow {
  product_id: string;
  pack_id: string;
  name: string;
  description: string;
  price_monthly_fen: string | number;
  price_yearly_fen: string | number;
  status: "listed" | "unlisted";
  created_at: string;
}

interface OrderRow {
  order_id: string;
  user_id: string;
  type: "plan" | "recharge";
  product_id: string | null;
  pack_id: string | null;
  period: "monthly" | "yearly" | null;
  amount_fen: string | number;
  status: "pending" | "paid" | "cancelled" | "refunded";
  pay_method: "balance" | "mock" | null;
  created_at: string;
  paid_at: string | null;
}

interface TxnRow {
  txn_id: string;
  user_id: string;
  type: "recharge" | "purchase" | "refund" | "adjust";
  amount_fen: string | number;
  balance_after_fen: string | number;
  order_id: string | null;
  remark: string | null;
  created_at: string;
}

interface EntitlementRow {
  entitlement_id: string;
  tenant_id: string;
  device_id: string;
  pack_id: string;
  scope: "tenant" | "user" | "device";
  status: "active" | "suspended" | "revoked";
  expires_at: string;
  created_at: string;
}

interface ReleaseRow {
  pack_id: string;
  version: string;
  status: "active" | "revoked";
  pack: PackFile;
  digest: string;
  signature_key_id: string;
  min_desktop_version: string;
  created_at: string;
}

function toRelease(row: ReleaseRow): PackReleaseRecord {
  return {
    pack_id: row.pack_id,
    version: row.version,
    status: row.status,
    pack: row.pack,
    digest: row.digest,
    signature_key_id: row.signature_key_id,
    min_desktop_version: row.min_desktop_version,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function toTask(row: TaskRow): CloudTask {
  return {
    task_id: row.task_id,
    kind: row.kind,
    status: row.status,
    input: row.input,
    output: row.output ?? undefined,
    error: row.error ?? undefined,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

function toEvent(row: EventRow): CloudTaskEvent {
  return {
    event_id: String(row.event_id),
    task_id: row.task_id,
    type: row.type,
    ts: new Date(row.ts).toISOString(),
    ...(row.payload ?? {}),
  };
}

function toDevice(row: DeviceRow): DeviceRecord {
  return {
    device_id: row.device_id,
    tenant_id: row.tenant_id,
    status: row.status,
    platform: row.platform,
    app_version: row.app_version,
    device_fingerprint: row.device_fingerprint,
    display_name: row.display_name ?? undefined,
    device_token: row.device_token,
    user_id: row.user_id ?? undefined,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function toUser(row: UserRow): UserRecord {
  return {
    user_id: row.user_id,
    email: row.email,
    password_hash: row.password_hash,
    status: row.status,
    balance_fen: Number(row.balance_fen),
    created_at: new Date(row.created_at).toISOString(),
  };
}

function toSession(row: SessionRow): SessionRecord {
  return {
    token: row.token,
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    expires_at: new Date(row.expires_at).toISOString(),
    created_at: new Date(row.created_at).toISOString(),
  };
}

function toAdmin(row: AdminRow): AdminRecord {
  return {
    admin_id: row.admin_id,
    username: row.username,
    password_hash: row.password_hash,
    role: row.role,
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function toAudit(row: AuditRow): AuditLogRecord {
  return {
    audit_id: row.audit_id,
    actor: row.actor,
    action: row.action,
    detail: row.detail ?? undefined,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function toProduct(row: ProductRow): ProductRecord {
  return {
    product_id: row.product_id,
    pack_id: row.pack_id,
    name: row.name,
    description: row.description,
    price_monthly_fen: Number(row.price_monthly_fen),
    price_yearly_fen: Number(row.price_yearly_fen),
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function toOrder(row: OrderRow): OrderRecord {
  return {
    order_id: row.order_id,
    user_id: row.user_id,
    type: row.type,
    product_id: row.product_id ?? undefined,
    pack_id: row.pack_id ?? undefined,
    period: row.period ?? undefined,
    amount_fen: Number(row.amount_fen),
    status: row.status,
    pay_method: row.pay_method ?? undefined,
    created_at: new Date(row.created_at).toISOString(),
    paid_at: row.paid_at ? new Date(row.paid_at).toISOString() : undefined,
  };
}

function toTxn(row: TxnRow): WalletTransactionRecord {
  return {
    txn_id: row.txn_id,
    user_id: row.user_id,
    type: row.type,
    amount_fen: Number(row.amount_fen),
    balance_after_fen: Number(row.balance_after_fen),
    order_id: row.order_id ?? undefined,
    remark: row.remark ?? undefined,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function toEntitlement(row: EntitlementRow): EntitlementRecord {
  return {
    entitlement_id: row.entitlement_id,
    tenant_id: row.tenant_id,
    device_id: row.device_id,
    pack_id: row.pack_id,
    scope: row.scope,
    status: row.status,
    expires_at: new Date(row.expires_at).toISOString(),
    created_at: new Date(row.created_at).toISOString(),
  };
}

export class PgStore implements CloudStore {
  private readonly pool: pg.Pool;
  private readonly listeners = new Map<string, Set<EventListener>>();

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  /** 建表（幂等）；正式环境由迁移流水线执行 */
  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS cloud_task (
        task_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        input JSONB,
        output JSONB,
        error JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS cloud_task_event (
        event_id BIGSERIAL PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES cloud_task(task_id),
        type TEXT NOT NULL,
        ts TIMESTAMPTZ NOT NULL DEFAULT now(),
        payload JSONB
      );
      CREATE INDEX IF NOT EXISTS idx_cloud_task_event_task ON cloud_task_event(task_id, event_id);
      CREATE TABLE IF NOT EXISTS device (
        device_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        platform TEXT NOT NULL,
        app_version TEXT NOT NULL,
        device_fingerprint TEXT NOT NULL,
        display_name TEXT,
        device_token TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_device_active_fingerprint
        ON device(tenant_id, device_fingerprint) WHERE status = 'active';
      CREATE TABLE IF NOT EXISTS entitlement (
        entitlement_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        device_id TEXT NOT NULL REFERENCES device(device_id),
        pack_id TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'device',
        status TEXT NOT NULL DEFAULT 'active',
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_entitlement_device ON entitlement(device_id);
      CREATE TABLE IF NOT EXISTS pack_release (
        pack_id TEXT NOT NULL,
        version TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        pack JSONB NOT NULL,
        digest TEXT NOT NULL,
        signature_key_id TEXT NOT NULL,
        min_desktop_version TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (pack_id, version)
      );
      ALTER TABLE device ADD COLUMN IF NOT EXISTS user_id TEXT;
      CREATE TABLE IF NOT EXISTS account_user (
        user_id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        balance_fen BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS auth_session (
        token TEXT PRIMARY KEY,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS admin_account (
        admin_id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        audit_id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        detail JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS product (
        product_id TEXT PRIMARY KEY,
        pack_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        price_monthly_fen BIGINT NOT NULL,
        price_yearly_fen BIGINT NOT NULL,
        status TEXT NOT NULL DEFAULT 'listed',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS billing_order (
        order_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES account_user(user_id),
        type TEXT NOT NULL,
        product_id TEXT,
        pack_id TEXT,
        period TEXT,
        amount_fen BIGINT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        pay_method TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        paid_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_billing_order_user ON billing_order(user_id);
      CREATE TABLE IF NOT EXISTS wallet_txn (
        txn_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES account_user(user_id),
        type TEXT NOT NULL,
        amount_fen BIGINT NOT NULL,
        balance_after_fen BIGINT NOT NULL,
        order_id TEXT,
        remark TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_wallet_txn_user ON wallet_txn(user_id);
    `);
  }

  async createTask(idempotencyKey: string, kind: string, input: unknown): Promise<{ task: CloudTask; existed: boolean }> {
    const taskId = `ct-${randomUUID()}`;
    const inserted = await this.pool.query<TaskRow>(
      `INSERT INTO cloud_task (task_id, idempotency_key, kind, status, input)
       VALUES ($1, $2, $3, 'pending', $4)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [taskId, idempotencyKey, kind, JSON.stringify(input)],
    );
    if (inserted.rowCount === 0) {
      const existing = await this.pool.query<TaskRow>(
        `SELECT * FROM cloud_task WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      return { task: toTask(existing.rows[0]!), existed: true };
    }
    await this.appendEvent(taskId, "task.accepted");
    return { task: toTask(inserted.rows[0]!), existed: false };
  }

  async getTask(taskId: string): Promise<CloudTask | undefined> {
    const res = await this.pool.query<TaskRow>(`SELECT * FROM cloud_task WHERE task_id = $1`, [taskId]);
    return res.rows[0] ? toTask(res.rows[0]) : undefined;
  }

  async transition(taskId: string, status: CloudTaskStatus, patch?: Partial<CloudTask>): Promise<CloudTask> {
    const res = await this.pool.query<TaskRow>(
      `UPDATE cloud_task
       SET status = $2,
           output = COALESCE($3, output),
           error = COALESCE($4, error),
           updated_at = now()
       WHERE task_id = $1
       RETURNING *`,
      [
        taskId,
        status,
        patch?.output !== undefined ? JSON.stringify(patch.output) : null,
        patch?.error !== undefined ? JSON.stringify(patch.error) : null,
      ],
    );
    if (res.rowCount === 0) throw new Error(`Unknown task: ${taskId}`);
    const task = toTask(res.rows[0]!);
    await this.appendEvent(taskId, TASK_EVENT_TYPE[status], task.error ? { error: task.error } : undefined);
    return task;
  }

  async eventsAfter(taskId: string, afterEventId?: string): Promise<CloudTaskEvent[]> {
    const res = await this.pool.query<EventRow>(
      `SELECT * FROM cloud_task_event
       WHERE task_id = $1 AND event_id > $2
       ORDER BY event_id`,
      [taskId, afterEventId === undefined ? 0 : Number(afterEventId)],
    );
    return res.rows.map(toEvent);
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
    const existing = await this.pool.query<DeviceRow>(
      `SELECT * FROM device WHERE tenant_id = $1 AND device_fingerprint = $2 AND status = 'active'`,
      [params.tenant_id, params.device_fingerprint],
    );
    if (existing.rows[0]) return { device: toDevice(existing.rows[0]), existed: true };
    const res = await this.pool.query<DeviceRow>(
      `INSERT INTO device (device_id, tenant_id, platform, app_version, device_fingerprint, display_name, device_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        `dev-${randomUUID()}`,
        params.tenant_id,
        params.platform,
        params.app_version,
        params.device_fingerprint,
        params.display_name ?? null,
        `dt-${randomUUID()}${randomUUID()}`,
      ],
    );
    return { device: toDevice(res.rows[0]!), existed: false };
  }

  async getDevice(deviceId: string): Promise<DeviceRecord | undefined> {
    const res = await this.pool.query<DeviceRow>(`SELECT * FROM device WHERE device_id = $1`, [deviceId]);
    return res.rows[0] ? toDevice(res.rows[0]) : undefined;
  }

  async findDeviceByToken(token: string): Promise<DeviceRecord | undefined> {
    const res = await this.pool.query<DeviceRow>(`SELECT * FROM device WHERE device_token = $1`, [token]);
    return res.rows[0] ? toDevice(res.rows[0]) : undefined;
  }

  async listDevices(userId?: string): Promise<DeviceRecord[]> {
    const res = userId
      ? await this.pool.query<DeviceRow>(`SELECT * FROM device WHERE user_id = $1 ORDER BY created_at`, [userId])
      : await this.pool.query<DeviceRow>(`SELECT * FROM device ORDER BY created_at`);
    return res.rows.map(toDevice);
  }

  async bindDevice(deviceId: string, userId: string): Promise<DeviceRecord | undefined> {
    const res = await this.pool.query<DeviceRow>(
      `UPDATE device SET user_id = $2 WHERE device_id = $1 RETURNING *`,
      [deviceId, userId],
    );
    return res.rows[0] ? toDevice(res.rows[0]) : undefined;
  }

  async createUser(params: { email: string; password_hash: string }): Promise<{ user: UserRecord; existed: boolean }> {
    const inserted = await this.pool.query<UserRow>(
      `INSERT INTO account_user (user_id, email, password_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING
       RETURNING *`,
      [`usr-${randomUUID()}`, params.email, params.password_hash],
    );
    if (inserted.rowCount === 0) {
      const existing = await this.pool.query<UserRow>(`SELECT * FROM account_user WHERE email = $1`, [params.email]);
      return { user: toUser(existing.rows[0]!), existed: true };
    }
    return { user: toUser(inserted.rows[0]!), existed: false };
  }

  async getUser(userId: string): Promise<UserRecord | undefined> {
    const res = await this.pool.query<UserRow>(`SELECT * FROM account_user WHERE user_id = $1`, [userId]);
    return res.rows[0] ? toUser(res.rows[0]) : undefined;
  }

  async getUserByEmail(email: string): Promise<UserRecord | undefined> {
    const res = await this.pool.query<UserRow>(`SELECT * FROM account_user WHERE email = $1`, [email]);
    return res.rows[0] ? toUser(res.rows[0]) : undefined;
  }

  async listUsers(): Promise<UserRecord[]> {
    const res = await this.pool.query<UserRow>(`SELECT * FROM account_user ORDER BY created_at`);
    return res.rows.map(toUser);
  }

  async setUserStatus(userId: string, status: "active" | "disabled"): Promise<UserRecord | undefined> {
    const res = await this.pool.query<UserRow>(
      `UPDATE account_user SET status = $2 WHERE user_id = $1 RETURNING *`,
      [userId, status],
    );
    return res.rows[0] ? toUser(res.rows[0]) : undefined;
  }

  async createSession(params: {
    subject_type: "user" | "admin";
    subject_id: string;
    token: string;
    expires_at: string;
  }): Promise<SessionRecord> {
    const res = await this.pool.query<SessionRow>(
      `INSERT INTO auth_session (token, subject_type, subject_id, expires_at)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [params.token, params.subject_type, params.subject_id, params.expires_at],
    );
    return toSession(res.rows[0]!);
  }

  async getSession(token: string): Promise<SessionRecord | undefined> {
    const res = await this.pool.query<SessionRow>(
      `SELECT * FROM auth_session WHERE token = $1 AND expires_at > now()`,
      [token],
    );
    return res.rows[0] ? toSession(res.rows[0]) : undefined;
  }

  async deleteSession(token: string): Promise<void> {
    await this.pool.query(`DELETE FROM auth_session WHERE token = $1`, [token]);
  }

  async createAdmin(params: {
    username: string;
    password_hash: string;
    role: AdminRole;
  }): Promise<{ admin: AdminRecord; existed: boolean }> {
    const inserted = await this.pool.query<AdminRow>(
      `INSERT INTO admin_account (admin_id, username, password_hash, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (username) DO NOTHING
       RETURNING *`,
      [`adm-${randomUUID()}`, params.username, params.password_hash, params.role],
    );
    if (inserted.rowCount === 0) {
      const existing = await this.pool.query<AdminRow>(`SELECT * FROM admin_account WHERE username = $1`, [
        params.username,
      ]);
      return { admin: toAdmin(existing.rows[0]!), existed: true };
    }
    return { admin: toAdmin(inserted.rows[0]!), existed: false };
  }

  async getAdmin(adminId: string): Promise<AdminRecord | undefined> {
    const res = await this.pool.query<AdminRow>(`SELECT * FROM admin_account WHERE admin_id = $1`, [adminId]);
    return res.rows[0] ? toAdmin(res.rows[0]) : undefined;
  }

  async getAdminByUsername(username: string): Promise<AdminRecord | undefined> {
    const res = await this.pool.query<AdminRow>(`SELECT * FROM admin_account WHERE username = $1`, [username]);
    return res.rows[0] ? toAdmin(res.rows[0]) : undefined;
  }

  async appendAudit(actor: string, action: string, detail?: unknown): Promise<AuditLogRecord> {
    const res = await this.pool.query<AuditRow>(
      `INSERT INTO audit_log (audit_id, actor, action, detail) VALUES ($1, $2, $3, $4) RETURNING *`,
      [`aud-${randomUUID()}`, actor, action, detail === undefined ? null : JSON.stringify(detail)],
    );
    return toAudit(res.rows[0]!);
  }

  async listAudits(limit = 200): Promise<AuditLogRecord[]> {
    const res = await this.pool.query<AuditRow>(`SELECT * FROM audit_log ORDER BY created_at DESC LIMIT $1`, [limit]);
    return res.rows.map(toAudit);
  }

  async createProduct(params: {
    pack_id: string;
    name: string;
    description: string;
    price_monthly_fen: number;
    price_yearly_fen: number;
    status?: "listed" | "unlisted";
  }): Promise<ProductRecord> {
    const res = await this.pool.query<ProductRow>(
      `INSERT INTO product (product_id, pack_id, name, description, price_monthly_fen, price_yearly_fen, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        `prd-${randomUUID()}`,
        params.pack_id,
        params.name,
        params.description,
        params.price_monthly_fen,
        params.price_yearly_fen,
        params.status ?? "listed",
      ],
    );
    return toProduct(res.rows[0]!);
  }

  async updateProduct(
    productId: string,
    patch: Partial<Pick<ProductRecord, "name" | "description" | "price_monthly_fen" | "price_yearly_fen" | "status">>,
  ): Promise<ProductRecord | undefined> {
    const res = await this.pool.query<ProductRow>(
      `UPDATE product SET
         name = COALESCE($2, name),
         description = COALESCE($3, description),
         price_monthly_fen = COALESCE($4, price_monthly_fen),
         price_yearly_fen = COALESCE($5, price_yearly_fen),
         status = COALESCE($6, status)
       WHERE product_id = $1 RETURNING *`,
      [
        productId,
        patch.name ?? null,
        patch.description ?? null,
        patch.price_monthly_fen ?? null,
        patch.price_yearly_fen ?? null,
        patch.status ?? null,
      ],
    );
    return res.rows[0] ? toProduct(res.rows[0]) : undefined;
  }

  async getProduct(productId: string): Promise<ProductRecord | undefined> {
    const res = await this.pool.query<ProductRow>(`SELECT * FROM product WHERE product_id = $1`, [productId]);
    return res.rows[0] ? toProduct(res.rows[0]) : undefined;
  }

  async listProducts(): Promise<ProductRecord[]> {
    const res = await this.pool.query<ProductRow>(`SELECT * FROM product ORDER BY created_at`);
    return res.rows.map(toProduct);
  }

  async createOrder(params: {
    user_id: string;
    type: "plan" | "recharge";
    product_id?: string;
    pack_id?: string;
    period?: "monthly" | "yearly";
    amount_fen: number;
  }): Promise<OrderRecord> {
    const res = await this.pool.query<OrderRow>(
      `INSERT INTO billing_order (order_id, user_id, type, product_id, pack_id, period, amount_fen)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        `ord-${randomUUID()}`,
        params.user_id,
        params.type,
        params.product_id ?? null,
        params.pack_id ?? null,
        params.period ?? null,
        params.amount_fen,
      ],
    );
    return toOrder(res.rows[0]!);
  }

  async getOrder(orderId: string): Promise<OrderRecord | undefined> {
    const res = await this.pool.query<OrderRow>(`SELECT * FROM billing_order WHERE order_id = $1`, [orderId]);
    return res.rows[0] ? toOrder(res.rows[0]) : undefined;
  }

  async updateOrder(
    orderId: string,
    patch: Partial<Pick<OrderRecord, "status" | "pay_method" | "paid_at">>,
  ): Promise<OrderRecord | undefined> {
    const res = await this.pool.query<OrderRow>(
      `UPDATE billing_order SET
         status = COALESCE($2, status),
         pay_method = COALESCE($3, pay_method),
         paid_at = COALESCE($4, paid_at)
       WHERE order_id = $1 RETURNING *`,
      [orderId, patch.status ?? null, patch.pay_method ?? null, patch.paid_at ?? null],
    );
    return res.rows[0] ? toOrder(res.rows[0]) : undefined;
  }

  async listOrders(userId?: string): Promise<OrderRecord[]> {
    const res = userId
      ? await this.pool.query<OrderRow>(`SELECT * FROM billing_order WHERE user_id = $1 ORDER BY created_at DESC`, [
          userId,
        ])
      : await this.pool.query<OrderRow>(`SELECT * FROM billing_order ORDER BY created_at DESC`);
    return res.rows.map(toOrder);
  }

  async addWalletTransaction(params: {
    user_id: string;
    type: "recharge" | "purchase" | "refund" | "adjust";
    amount_fen: number;
    order_id?: string;
    remark?: string;
  }): Promise<WalletTransactionRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query<UserRow>(
        `UPDATE account_user SET balance_fen = balance_fen + $2
         WHERE user_id = $1 AND balance_fen + $2 >= 0
         RETURNING *`,
        [params.user_id, params.amount_fen],
      );
      if (updated.rowCount === 0) {
        await client.query("ROLLBACK");
        const exists = await this.pool.query(`SELECT 1 FROM account_user WHERE user_id = $1`, [params.user_id]);
        throw new Error(exists.rowCount === 0 ? `Unknown user: ${params.user_id}` : "INSUFFICIENT_BALANCE");
      }
      const txn = await client.query<TxnRow>(
        `INSERT INTO wallet_txn (txn_id, user_id, type, amount_fen, balance_after_fen, order_id, remark)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [
          `txn-${randomUUID()}`,
          params.user_id,
          params.type,
          params.amount_fen,
          Number(updated.rows[0]!.balance_fen),
          params.order_id ?? null,
          params.remark ?? null,
        ],
      );
      await client.query("COMMIT");
      return toTxn(txn.rows[0]!);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async listTransactions(userId?: string): Promise<WalletTransactionRecord[]> {
    const res = userId
      ? await this.pool.query<TxnRow>(`SELECT * FROM wallet_txn WHERE user_id = $1 ORDER BY created_at DESC`, [userId])
      : await this.pool.query<TxnRow>(`SELECT * FROM wallet_txn ORDER BY created_at DESC`);
    return res.rows.map(toTxn);
  }

  async listAllEntitlements(): Promise<EntitlementRecord[]> {
    const res = await this.pool.query<EntitlementRow>(`SELECT * FROM entitlement ORDER BY created_at`);
    return res.rows.map(toEntitlement);
  }

  async grantEntitlement(params: {
    tenant_id: string;
    device_id: string;
    pack_id: string;
    scope?: "tenant" | "user" | "device";
    expires_at?: string;
  }): Promise<EntitlementRecord> {
    const res = await this.pool.query<EntitlementRow>(
      `INSERT INTO entitlement (entitlement_id, tenant_id, device_id, pack_id, scope, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        `ent-${randomUUID()}`,
        params.tenant_id,
        params.device_id,
        params.pack_id,
        params.scope ?? "device",
        params.expires_at ?? FAR_FUTURE,
      ],
    );
    return toEntitlement(res.rows[0]!);
  }

  async revokeEntitlement(entitlementId: string): Promise<EntitlementRecord | undefined> {
    const res = await this.pool.query<EntitlementRow>(
      `UPDATE entitlement SET status = 'revoked' WHERE entitlement_id = $1 RETURNING *`,
      [entitlementId],
    );
    return res.rows[0] ? toEntitlement(res.rows[0]) : undefined;
  }

  async listEntitlements(deviceId: string): Promise<EntitlementRecord[]> {
    const res = await this.pool.query<EntitlementRow>(
      `SELECT * FROM entitlement WHERE device_id = $1 ORDER BY created_at`,
      [deviceId],
    );
    return res.rows.map(toEntitlement);
  }

  async publishRelease(params: {
    pack: PackFile;
    digest: string;
    signature_key_id: string;
  }): Promise<{ release: PackReleaseRecord; existed: boolean }> {
    const { id, version, minDesktopVersion } = params.pack.manifest.pack;
    const inserted = await this.pool.query<ReleaseRow>(
      `INSERT INTO pack_release (pack_id, version, pack, digest, signature_key_id, min_desktop_version)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (pack_id, version) DO NOTHING
       RETURNING *`,
      [id, version, JSON.stringify(params.pack), params.digest, params.signature_key_id, minDesktopVersion],
    );
    if (inserted.rowCount === 0) {
      const existing = await this.pool.query<ReleaseRow>(
        `SELECT * FROM pack_release WHERE pack_id = $1 AND version = $2`,
        [id, version],
      );
      return { release: toRelease(existing.rows[0]!), existed: true };
    }
    return { release: toRelease(inserted.rows[0]!), existed: false };
  }

  async getRelease(packId: string, version: string): Promise<PackReleaseRecord | undefined> {
    const res = await this.pool.query<ReleaseRow>(
      `SELECT * FROM pack_release WHERE pack_id = $1 AND version = $2`,
      [packId, version],
    );
    return res.rows[0] ? toRelease(res.rows[0]) : undefined;
  }

  async listReleases(packId?: string): Promise<PackReleaseRecord[]> {
    const res = packId
      ? await this.pool.query<ReleaseRow>(`SELECT * FROM pack_release WHERE pack_id = $1 ORDER BY created_at`, [packId])
      : await this.pool.query<ReleaseRow>(`SELECT * FROM pack_release ORDER BY created_at`);
    return res.rows.map(toRelease);
  }

  async revokeRelease(packId: string, version: string): Promise<PackReleaseRecord | undefined> {
    const res = await this.pool.query<ReleaseRow>(
      `UPDATE pack_release SET status = 'revoked' WHERE pack_id = $1 AND version = $2 RETURNING *`,
      [packId, version],
    );
    return res.rows[0] ? toRelease(res.rows[0]) : undefined;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async appendEvent(taskId: string, type: string, payload?: Record<string, unknown>): Promise<void> {
    const res = await this.pool.query<EventRow>(
      `INSERT INTO cloud_task_event (task_id, type, payload) VALUES ($1, $2, $3) RETURNING *`,
      [taskId, type, payload ? JSON.stringify(payload) : null],
    );
    const event = toEvent(res.rows[0]!);
    this.listeners.get(taskId)?.forEach((l) => l(event));
  }
}
