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
