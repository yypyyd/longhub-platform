import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const ID = /^[A-Za-z0-9._:-]{1,160}$/;

export interface PersonalProfileEntry {
  readonly entryId: string;
  readonly agentId: string;
  readonly title: string;
  readonly content: string;
  readonly createdAt: string;
  readonly deletedAt?: string;
}

interface PersonalProfileState {
  readonly schemaVersion: "longhub/local-personal-profile/v1";
  readonly ownerHash: string;
  readonly entries: readonly PersonalProfileEntry[];
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

/** 只接受 app userData 下的状态文件；该类型没有网络依赖，内容不会进入 Cloud 请求。 */
export class LocalPersonalProfileStore {
  private readonly ownerHash: string;
  private entries: PersonalProfileEntry[];

  constructor(private readonly stateFile: string, owner: string, private readonly now: () => number = Date.now) {
    if (owner.length < 8) throw new Error("本地资料库 owner 无效");
    this.ownerHash = createHash("sha256").update(owner).digest("hex");
    this.entries = this.load();
  }

  list(agentId: string, includeDeleted = false): readonly PersonalProfileEntry[] {
    this.assertAgent(agentId);
    return this.entries.filter((entry) => entry.agentId === agentId && (includeDeleted || !entry.deletedAt))
      .map((entry) => ({ ...entry }));
  }

  add(agentId: string, title: string, content: string): PersonalProfileEntry {
    this.assertAgent(agentId);
    const normalizedTitle = title.trim();
    const normalizedContent = content.trim();
    if (!normalizedTitle || normalizedTitle.length > 120 || !normalizedContent || Buffer.byteLength(normalizedContent) > 2 * 1024 * 1024) {
      throw new Error("本地资料标题或内容无效");
    }
    const entry: PersonalProfileEntry = {
      entryId: randomUUID(), agentId, title: normalizedTitle, content: normalizedContent,
      createdAt: new Date(this.now()).toISOString(),
    };
    this.entries.push(entry);
    this.persist();
    return { ...entry };
  }

  trash(agentId: string, entryId: string): void {
    const entry = this.find(agentId, entryId);
    if (entry.deletedAt) return;
    this.entries = this.entries.map((item) => item === entry ? { ...item, deletedAt: new Date(this.now()).toISOString() } : item);
    this.persist();
  }

  restore(agentId: string, entryId: string): void {
    const entry = this.find(agentId, entryId);
    if (!entry.deletedAt) return;
    this.entries = this.entries.map((item) => item === entry
      ? { entryId: item.entryId, agentId: item.agentId, title: item.title, content: item.content, createdAt: item.createdAt }
      : item);
    this.persist();
  }

  permanentlyDelete(agentId: string, entryId: string): void {
    const entry = this.find(agentId, entryId);
    if (!entry.deletedAt) throw new Error("永久删除前必须进入回收状态");
    this.entries = this.entries.filter((item) => item !== entry);
    this.persist();
  }

  private find(agentId: string, entryId: string): PersonalProfileEntry {
    this.assertAgent(agentId);
    if (!ID.test(entryId)) throw new Error("本地资料 ID 无效");
    const entry = this.entries.find((item) => item.agentId === agentId && item.entryId === entryId);
    if (!entry) throw new Error("本地资料不存在或不属于目标 Agent");
    return entry;
  }

  private assertAgent(agentId: string): void {
    if (!ID.test(agentId)) throw new Error("本地资料 Agent 无效");
  }

  private load(): PersonalProfileEntry[] {
    if (!existsSync(this.stateFile)) return [];
    const stat = lstatSync(this.stateFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error("本地资料库状态无效");
    const state = JSON.parse(readFileSync(this.stateFile, "utf8")) as PersonalProfileState;
    if (!exactKeys(state, ["schemaVersion", "ownerHash", "entries"]) ||
      state.schemaVersion !== "longhub/local-personal-profile/v1" || state.ownerHash !== this.ownerHash || !Array.isArray(state.entries)) {
      throw new Error("本地资料库 owner 或格式无效");
    }
    for (const entry of state.entries) {
      const keys = entry.deletedAt === undefined
        ? ["entryId", "agentId", "title", "content", "createdAt"]
        : ["entryId", "agentId", "title", "content", "createdAt", "deletedAt"];
      if (!exactKeys(entry, keys) || !ID.test(entry.entryId) || !ID.test(entry.agentId) ||
        !entry.title || entry.title.length > 120 || Buffer.byteLength(entry.content) > 2 * 1024 * 1024 ||
        !Number.isFinite(Date.parse(entry.createdAt)) || (entry.deletedAt && !Number.isFinite(Date.parse(entry.deletedAt)))) {
        throw new Error("本地资料库记录无效");
      }
    }
    return state.entries.map((entry) => ({ ...entry }));
  }

  private persist(): void {
    mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.stateFile}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({
      schemaVersion: "longhub/local-personal-profile/v1", ownerHash: this.ownerHash, entries: this.entries,
    }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.stateFile);
  }
}
