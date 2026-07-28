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
  type CloudStore,
  type CloudTask,
  type CloudTaskEvent,
  type CloudTaskStatus,
  type DeviceRecord,
  type EntitlementRecord,
  type EventListener,
  type PackReleaseRecord,
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
