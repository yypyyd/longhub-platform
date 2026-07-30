import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { validatePackContent, type PackManifest } from "@longhub/pack-schema";

const REGISTRY_SCHEMA_VERSION = "longhub/agent-registry/v1";
const OPENCLAW_AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface AgentRegistryEntry {
  profileId: string;
  agentId: string;
  packId: string;
  profileVersion: string;
  packVersion: string;
  enabled: boolean;
}

interface AgentRegistryState {
  schemaVersion: typeof REGISTRY_SCHEMA_VERSION;
  revision: number;
  entries: AgentRegistryEntry[];
}

export interface AgentRegistrySnapshot {
  revision: number;
  entries: readonly AgentRegistryEntry[];
}

export interface RegisterAgentProfileInput {
  manifest: PackManifest;
  files: Record<string, string>;
  enabled?: boolean;
}

export class AgentRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRegistryError";
  }
}

/** Profile ID 到 OpenClaw agentId 的稳定、不可逆显示映射。 */
export function agentIdForProfile(profileId: string): string {
  const normalized = profileId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized || profileId === "main") throw new AgentRegistryError("Profile ID 不能映射为 main");
  const suffix = createHash("sha256").update(profileId, "utf8").digest("hex").slice(0, 12);
  return `${normalized.slice(0, 51)}-${suffix}`;
}

function isRegistryEntry(value: unknown): value is AgentRegistryEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const exactKeys = ["agentId", "enabled", "packId", "packVersion", "profileId", "profileVersion"];
  if (Object.keys(entry).sort().join("|") !== exactKeys.join("|")) return false;
  return (
    typeof entry.profileId === "string" &&
    typeof entry.agentId === "string" &&
    OPENCLAW_AGENT_ID.test(entry.agentId) &&
    entry.agentId !== "main" &&
    entry.agentId === agentIdForProfile(entry.profileId) &&
    typeof entry.packId === "string" &&
    typeof entry.profileVersion === "string" &&
    typeof entry.packVersion === "string" &&
    typeof entry.enabled === "boolean"
  );
}

function parseRegistryState(input: unknown): AgentRegistryState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AgentRegistryError("Agent Registry 不是对象");
  }
  const state = input as Record<string, unknown>;
  if (Object.keys(state).sort().join("|") !== "entries|revision|schemaVersion") {
    throw new AgentRegistryError("Agent Registry 包含未知字段");
  }
  if (
    state.schemaVersion !== REGISTRY_SCHEMA_VERSION ||
    !Number.isSafeInteger(state.revision) ||
    (state.revision as number) < 0 ||
    !Array.isArray(state.entries) ||
    !state.entries.every(isRegistryEntry)
  ) {
    throw new AgentRegistryError("Agent Registry 格式或版本无效");
  }
  const entries = state.entries as AgentRegistryEntry[];
  if (new Set(entries.map((entry) => entry.profileId)).size !== entries.length) {
    throw new AgentRegistryError("Agent Registry 存在重复 Profile ID");
  }
  if (new Set(entries.map((entry) => entry.agentId)).size !== entries.length) {
    throw new AgentRegistryError("Agent Registry 存在重复 agentId");
  }
  return { schemaVersion: REGISTRY_SCHEMA_VERSION, revision: state.revision as number, entries };
}

export class AgentRegistry {
  private state: AgentRegistryState;

  constructor(private readonly filePath: string) {
    this.state = this.load();
  }

  list(): readonly AgentRegistryEntry[] {
    return this.state.entries.map((entry) => ({ ...entry }));
  }

  enabled(): readonly AgentRegistryEntry[] {
    return this.list().filter((entry) => entry.enabled);
  }

  findByProfile(profileId: string): AgentRegistryEntry | undefined {
    const entry = this.state.entries.find((candidate) => candidate.profileId === profileId);
    return entry ? { ...entry } : undefined;
  }

  /** 生命周期事务使用的内存快照；restore 会以新 revision 原子提交，不回拨单调版本号。 */
  snapshot(): AgentRegistrySnapshot {
    return {
      revision: this.state.revision,
      entries: this.list(),
    };
  }

  restore(snapshot: AgentRegistrySnapshot): void {
    if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
      throw new AgentRegistryError("Agent Registry 快照 revision 无效");
    }
    const entries = snapshot.entries.map((entry) => ({ ...entry }));
    if (!entries.every(isRegistryEntry)) throw new AgentRegistryError("Agent Registry 快照条目无效");
    if (new Set(entries.map((entry) => entry.profileId)).size !== entries.length) {
      throw new AgentRegistryError("Agent Registry 快照存在重复 Profile ID");
    }
    if (new Set(entries.map((entry) => entry.agentId)).size !== entries.length) {
      throw new AgentRegistryError("Agent Registry 快照存在重复 agentId");
    }
    this.commit(entries);
  }

  register(input: RegisterAgentProfileInput): AgentRegistryEntry {
    const validated = validatePackContent(input.manifest, input.files);
    if (!validated.ok) {
      throw new AgentRegistryError(
        `Pack 内容无效: ${validated.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
      );
    }
    const { manifest, profile } = validated;
    if (profile.id === "main" || manifest.agentTemplate.id === "main") {
      throw new AgentRegistryError("main 是龙枢保留智能体，Pack 不得覆盖");
    }
    if (profile.id !== manifest.agentTemplate.id || profile.version !== manifest.agentTemplate.version) {
      throw new AgentRegistryError("Profile 与 Manifest 身份不一致");
    }
    const existing = this.state.entries.find((entry) => entry.profileId === profile.id);
    if (existing && existing.packId !== manifest.pack.id) {
      throw new AgentRegistryError(`Profile ${profile.id} 已归属于 Pack ${existing.packId}`);
    }
    const next: AgentRegistryEntry = {
      profileId: profile.id,
      agentId: existing?.agentId ?? agentIdForProfile(profile.id),
      packId: manifest.pack.id,
      profileVersion: profile.version,
      packVersion: manifest.pack.version,
      enabled: input.enabled ?? existing?.enabled ?? true,
    };
    if (
      existing &&
      existing.agentId === next.agentId &&
      existing.packId === next.packId &&
      existing.packVersion === next.packVersion &&
      existing.profileId === next.profileId &&
      existing.profileVersion === next.profileVersion &&
      existing.enabled === next.enabled
    ) {
      return { ...existing };
    }
    const entries = existing
      ? this.state.entries.map((entry) => (entry.profileId === profile.id ? next : entry))
      : [...this.state.entries, next];
    this.commit(entries);
    return { ...next };
  }

  setEnabled(profileId: string, enabled: boolean): AgentRegistryEntry {
    const existing = this.state.entries.find((entry) => entry.profileId === profileId);
    if (!existing) throw new AgentRegistryError(`未注册的 Profile: ${profileId}`);
    if (existing.enabled === enabled) return { ...existing };
    const next = { ...existing, enabled };
    this.commit(this.state.entries.map((entry) => (entry.profileId === profileId ? next : entry)));
    return { ...next };
  }

  setPackEnabled(packId: string, enabled: boolean): readonly AgentRegistryEntry[] {
    const owned = this.state.entries.filter((entry) => entry.packId === packId);
    if (owned.length === 0) throw new AgentRegistryError(`未注册的 Pack: ${packId}`);
    if (owned.every((entry) => entry.enabled === enabled)) return owned.map((entry) => ({ ...entry }));
    const profileIds = new Set(owned.map((entry) => entry.profileId));
    this.commit(
      this.state.entries.map((entry) =>
        profileIds.has(entry.profileId) ? { ...entry, enabled } : entry,
      ),
    );
    return this.state.entries
      .filter((entry) => entry.packId === packId)
      .map((entry) => ({ ...entry }));
  }

  private load(): AgentRegistryState {
    if (!existsSync(this.filePath)) {
      return { schemaVersion: REGISTRY_SCHEMA_VERSION, revision: 0, entries: [] };
    }
    try {
      return parseRegistryState(JSON.parse(readFileSync(this.filePath, "utf8")) as unknown);
    } catch (error) {
      if (error instanceof AgentRegistryError) throw error;
      throw new AgentRegistryError(`Agent Registry 读取失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private commit(entries: AgentRegistryEntry[]): void {
    const next: AgentRegistryState = {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      revision: this.state.revision + 1,
      entries: [...entries].sort((left, right) => left.profileId.localeCompare(right.profileId, "en")),
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, this.filePath);
    this.state = next;
  }
}
