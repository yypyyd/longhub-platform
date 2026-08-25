import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { GatewayRpcTransport } from "./openclaw-gateway-client.js";

const ID = /^[A-Za-z0-9._:@/-]{1,512}$/;

export interface ManagedSession {
  readonly key: string;
  readonly agentId: string;
  readonly label?: string;
  readonly archived: boolean;
  readonly pinned?: boolean;
  readonly updatedAt?: string;
  readonly incomplete?: boolean;
}

export interface SessionExport {
  readonly schemaVersion: "longhub/session-export/v1";
  readonly exportedAt: string;
  readonly session: ManagedSession;
  readonly messages: readonly unknown[];
  readonly incomplete: boolean;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 格式无效`);
  return value as Record<string, unknown>;
}

function session(value: unknown): ManagedSession {
  const raw = record(value, "会话");
  const key = raw.key ?? raw.sessionKey;
  const agentId = raw.agentId ?? raw.agent_id;
  if (typeof key !== "string" || !ID.test(key) || typeof agentId !== "string" || !ID.test(agentId)) {
    throw new Error("会话身份无效");
  }
  return {
    key,
    agentId,
    label: typeof raw.label === "string" ? raw.label : undefined,
    archived: raw.archived === true,
    pinned: typeof raw.pinned === "boolean" ? raw.pinned : undefined,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
    incomplete: raw.truncated === true || raw.incomplete === true,
  };
}

/** 只通过锁定 OpenClaw 公开 RPC 管理会话，不接触其 SQLite/transcript 文件。 */
export class SessionManagementService {
  constructor(private readonly transport: GatewayRpcTransport) {}

  async list(agentId: string, options: { search?: string; archived?: boolean; limit?: number; offset?: number } = {}) {
    this.assertId(agentId, "Agent ID");
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 ||
      (options.search !== undefined && (options.search.length < 1 || options.search.length > 200))) {
      throw new Error("会话查询边界无效");
    }
    const raw = record(await this.transport.call("sessions.list", {
      agentId, limit, offset,
      ...(options.search ? { search: options.search } : {}),
      ...(options.archived === undefined ? {} : { archived: options.archived }),
    }), "sessions.list 响应");
    const values = raw.sessions ?? raw.items;
    if (!Array.isArray(values)) throw new Error("sessions.list 缺少会话列表");
    const sessions = values.map(session);
    if (sessions.some((item) => item.agentId !== agentId)) throw new Error("Gateway 返回跨 Agent 会话");
    return sessions;
  }

  async rename(agentId: string, key: string, label: string): Promise<void> {
    const current = await this.describeOwned(agentId, key);
    const normalized = label.trim();
    if (!normalized || normalized.length > 120) throw new Error("会话名称无效");
    await this.transport.call("sessions.patch", { key: current.key, label: normalized });
  }

  async setArchived(agentId: string, key: string, archived: boolean): Promise<void> {
    const current = await this.describeOwned(agentId, key);
    await this.transport.call("sessions.patch", { key: current.key, archived });
  }

  async setPinned(agentId: string, key: string, pinned: boolean): Promise<void> {
    const current = await this.describeOwned(agentId, key);
    await this.transport.call("sessions.patch", { key: current.key, pinned });
  }

  async export(agentId: string, key: string, maxBytes = 8 * 1024 * 1024): Promise<SessionExport> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1_024 || maxBytes > 32 * 1024 * 1024) {
      throw new Error("会话导出大小上限无效");
    }
    const current = await this.describeOwned(agentId, key);
    const history = record(await this.transport.call("chat.history", {
      sessionKey: current.key,
      limit: 1_000,
      offset: 0,
      maxChars: Math.min(maxBytes, 4 * 1024 * 1024),
    }), "chat.history 响应");
    const messages = history.messages;
    if (!Array.isArray(messages)) throw new Error("chat.history 缺少消息列表");
    const result: SessionExport = {
      schemaVersion: "longhub/session-export/v1",
      exportedAt: new Date().toISOString(),
      session: current,
      messages: structuredClone(messages),
      incomplete: current.incomplete === true || history.truncated === true || history.hasMore === true,
    };
    if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw new Error("会话导出超过安全上限");
    return result;
  }

  async sendMessage(agentId: string, key: string, message: string): Promise<void> {
    const current = await this.describeOwned(agentId, key);
    const normalized = message.trim();
    if (!normalized || Buffer.byteLength(normalized) > 2 * 1024 * 1024) throw new Error("会话消息大小无效");
    await this.transport.call("chat.send", {
      sessionKey: current.key,
      message: normalized,
      idempotencyKey: `longhub-attachment-${randomUUID()}`,
    });
  }

  async describeOwned(agentId: string, key: string): Promise<ManagedSession> {
    this.assertId(agentId, "Agent ID");
    this.assertId(key, "会话 key");
    const raw = record(await this.transport.call("sessions.describe", { key }), "sessions.describe 响应");
    const value = session(raw.session ?? raw);
    if (value.agentId !== agentId) throw new Error("会话不属于目标 Agent");
    return value;
  }

  async deleteArchived(agentId: string, key: string): Promise<void> {
    const current = await this.describeOwned(agentId, key);
    if (!current.archived) throw new Error("永久删除只允许已归档会话");
    await this.transport.call("sessions.delete", { key, archivedOnly: true });
  }

  private assertId(value: string, label: string): void {
    if (!ID.test(value)) throw new Error(`${label} 无效`);
  }
}

interface TrashRecord {
  readonly key: string;
  readonly agentId: string;
  readonly trashedAt: string;
  readonly deleteAfter: string;
}

interface TrashState {
  readonly schemaVersion: "longhub/session-trash/v1";
  readonly records: readonly TrashRecord[];
}

/** OpenClaw 没有回收站 RPC，因此用龙枢状态机先归档，保留期后才允许公开 delete RPC。 */
export class RecoverableSessionTrash {
  private records: TrashRecord[];
  private readonly confirmations = new Map<string, { agentId: string; key: string; expiresAt: number }>();

  constructor(
    private readonly stateFile: string,
    private readonly sessions: SessionManagementService,
    private readonly retentionMs = 30 * 24 * 60 * 60 * 1_000,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 60_000) throw new Error("会话保留期无效");
    this.records = this.load();
  }

  list(agentId: string): readonly TrashRecord[] {
    return this.records.filter((record) => record.agentId === agentId).map((record) => ({ ...record }));
  }

  async trash(agentId: string, key: string): Promise<void> {
    await this.sessions.setArchived(agentId, key, true);
    const now = this.now();
    this.records = this.records.filter((record) => !(record.agentId === agentId && record.key === key));
    this.records.push({ key, agentId, trashedAt: new Date(now).toISOString(), deleteAfter: new Date(now + this.retentionMs).toISOString() });
    this.persist();
  }

  async restore(agentId: string, key: string): Promise<void> {
    if (!this.find(agentId, key)) throw new Error("会话不在回收站");
    await this.sessions.setArchived(agentId, key, false);
    this.records = this.records.filter((record) => !(record.agentId === agentId && record.key === key));
    this.persist();
  }

  requestPermanentDelete(agentId: string, key: string): string {
    const item = this.find(agentId, key);
    if (!item) throw new Error("会话不在回收站");
    if (Date.parse(item.deleteAfter) > this.now()) throw new Error("会话仍在可恢复保留期");
    const nonce = `${randomUUID()}.${randomBytes(16).toString("hex")}`;
    this.confirmations.set(nonce, { agentId, key, expiresAt: this.now() + 5 * 60_000 });
    return nonce;
  }

  async permanentlyDelete(agentId: string, key: string, confirmation: string): Promise<void> {
    const pending = this.confirmations.get(confirmation);
    this.confirmations.delete(confirmation);
    if (!pending || pending.agentId !== agentId || pending.key !== key || pending.expiresAt < this.now()) {
      throw new Error("永久删除确认无效或已使用");
    }
    if (!this.find(agentId, key)) throw new Error("会话不在回收站");
    await this.sessions.deleteArchived(agentId, key);
    this.records = this.records.filter((record) => !(record.agentId === agentId && record.key === key));
    this.persist();
  }

  private find(agentId: string, key: string): TrashRecord | undefined {
    return this.records.find((record) => record.agentId === agentId && record.key === key);
  }

  private load(): TrashRecord[] {
    if (!existsSync(this.stateFile)) return [];
    const raw = JSON.parse(readFileSync(this.stateFile, "utf8")) as TrashState;
    if (raw.schemaVersion !== "longhub/session-trash/v1" || !Array.isArray(raw.records)) throw new Error("会话回收站状态损坏");
    for (const item of raw.records) {
      if (!ID.test(item.key) || !ID.test(item.agentId) || !Number.isFinite(Date.parse(item.trashedAt)) ||
        !Number.isFinite(Date.parse(item.deleteAfter))) throw new Error("会话回收站记录损坏");
    }
    return raw.records.map((item) => ({ ...item }));
  }

  private persist(): void {
    mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.stateFile}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ schemaVersion: "longhub/session-trash/v1", records: this.records }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.stateFile);
  }
}
