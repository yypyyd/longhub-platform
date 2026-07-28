/** 内存存储实现：用于测试与本地原型；生产部署使用 PgStore。 */
import { randomUUID } from "node:crypto";
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

export class MemoryStore implements CloudStore {
  private readonly tasks = new Map<string, CloudTask>();
  private readonly eventsByTask = new Map<string, CloudTaskEvent[]>();
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly idempotency = new Map<string, string>();
  private readonly devices = new Map<string, DeviceRecord>();
  private readonly entitlements = new Map<string, EntitlementRecord>();
  private readonly releases = new Map<string, PackReleaseRecord>();
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
