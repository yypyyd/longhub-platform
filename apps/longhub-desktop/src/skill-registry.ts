import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  assertSkillIdOwnership,
  validateSkillPackage,
  type SkillPackage,
} from "@longhub/pack-schema";
import { agentIdForProfile } from "./agent-registry.js";

const REGISTRY_SCHEMA = "longhub/skill-registry/v1" as const;
const LEGACY_SCHEMA = "longhub/skill-registry/v0" as const;
const HEX_64 = /^[a-f0-9]{64}$/;
const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface InstalledSkillVersion {
  manifest: SkillPackage;
  installedAt: string;
}

export interface SkillRegistryEntry {
  skillId: string;
  publisherNamespace: string;
  activeVersion: string;
  previousVersion?: string;
  status: "installed" | "revoked";
  versions: InstalledSkillVersion[];
  updatedAt: string;
}

export interface AgentSkillBinding {
  skillId: string;
  profileId: string;
  agentId: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface SkillRegistryState {
  schemaVersion: typeof REGISTRY_SCHEMA;
  ownerHash: string;
  revision: number;
  skills: SkillRegistryEntry[];
  bindings: AgentSkillBinding[];
}

interface LegacySkillRegistryState {
  schemaVersion: typeof LEGACY_SCHEMA;
  ownerHash: string;
  revision: number;
  skills: SkillPackage[];
  bindings: Array<Pick<AgentSkillBinding, "skillId" | "profileId" | "agentId" | "enabled">>;
}

export interface SkillRegistrySnapshot {
  readonly revision: number;
  readonly skills: readonly SkillRegistryEntry[];
  readonly bindings: readonly AgentSkillBinding[];
}

export class SkillRegistryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SkillRegistryError";
  }
}

function ownerHash(ownerScope: string): string {
  if (!ownerScope.trim() || ownerScope.length > 512) {
    throw new SkillRegistryError("SKILL_REGISTRY_OWNER_INVALID", "Skill Registry owner scope 无效");
  }
  return createHash("sha256").update(ownerScope, "utf8").digest("hex");
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function cloneState<T>(value: T): T {
  return structuredClone(value);
}

function parseVersion(value: unknown): InstalledSkillVersion {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SkillRegistryError("SKILL_REGISTRY_CORRUPT", "Skill 版本记录无效");
  }
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["manifest", "installedAt"]) || !isIsoTimestamp(record.installedAt)) {
    throw new SkillRegistryError("SKILL_REGISTRY_CORRUPT", "Skill 版本记录包含未知或无效字段");
  }
  const parsed = validateSkillPackage(record.manifest);
  if (!parsed.ok) throw new SkillRegistryError("SKILL_REGISTRY_CORRUPT", "Skill Registry Manifest 无效");
  return { manifest: parsed.manifest, installedAt: record.installedAt };
}

function parseSkillEntry(value: unknown): SkillRegistryEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SkillRegistryError("SKILL_REGISTRY_CORRUPT", "Skill Registry 条目无效");
  }
  const entry = value as Record<string, unknown>;
  const required = ["activeVersion", "publisherNamespace", "skillId", "status", "updatedAt", "versions"];
  const allowed = entry.previousVersion === undefined ? required : [...required, "previousVersion"];
  if (!exactKeys(entry, allowed) || !isIsoTimestamp(entry.updatedAt) || !Array.isArray(entry.versions)) {
    throw new SkillRegistryError("SKILL_REGISTRY_CORRUPT", "Skill Registry 条目包含未知或无效字段");
  }
  const versions = entry.versions.map(parseVersion);
  if (
    typeof entry.skillId !== "string" ||
    typeof entry.publisherNamespace !== "string" ||
    typeof entry.activeVersion !== "string" ||
    (entry.previousVersion !== undefined && typeof entry.previousVersion !== "string") ||
    (entry.status !== "installed" && entry.status !== "revoked") ||
    versions.length === 0
  ) {
    throw new SkillRegistryError("SKILL_REGISTRY_CORRUPT", "Skill Registry 条目格式无效");
  }
  const versionNames = versions.map((version) => version.manifest.skill.version);
  if (new Set(versionNames).size !== versionNames.length || !versionNames.includes(entry.activeVersion as string)) {
    throw new SkillRegistryError("SKILL_REGISTRY_CORRUPT", "Skill Registry 版本列表无效");
  }
  if (entry.previousVersion !== undefined && !versionNames.includes(entry.previousVersion as string)) {
    throw new SkillRegistryError("SKILL_REGISTRY_CORRUPT", "Skill Registry 上一版本不存在");
  }
  for (const version of versions) {
    if (
      version.manifest.skill.id !== entry.skillId ||
      version.manifest.skill.publisher.namespace !== entry.publisherNamespace
    ) {
      throw new SkillRegistryError("SKILL_REGISTRY_CORRUPT", "Skill Registry 版本身份不一致");
    }
  }
  return {
    skillId: entry.skillId,
    publisherNamespace: entry.publisherNamespace,
    activeVersion: entry.activeVersion,
    ...(entry.previousVersion === undefined ? {} : { previousVersion: entry.previousVersion }),
    status: entry.status,
    versions,
    updatedAt: entry.updatedAt,
  };
}

function parseBinding(value: unknown): AgentSkillBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SkillRegistryError("SKILL_REGISTRY_CORRUPT", "Agent-Skill Binding 无效");
  }
  const binding = value as Record<string, unknown>;
  if (
    !exactKeys(binding, ["agentId", "createdAt", "enabled", "profileId", "skillId", "updatedAt"]) ||
    typeof binding.skillId !== "string" ||
    typeof binding.profileId !== "string" ||
    typeof binding.agentId !== "string" ||
    !AGENT_ID.test(binding.agentId) ||
    binding.agentId !== agentIdForProfile(binding.profileId) ||
    typeof binding.enabled !== "boolean" ||
    !isIsoTimestamp(binding.createdAt) ||
    !isIsoTimestamp(binding.updatedAt)
  ) {
    throw new SkillRegistryError("SKILL_REGISTRY_CORRUPT", "Agent-Skill Binding 包含未知或无效字段");
  }
  return binding as unknown as AgentSkillBinding;
}

function validateRelationships(state: SkillRegistryState): SkillRegistryState {
  if (new Set(state.skills.map((entry) => entry.skillId)).size !== state.skills.length) {
    throw new SkillRegistryError("SKILL_REGISTRY_CORRUPT", "Skill Registry 存在重复 Skill ID");
  }
  const bindingKeys = state.bindings.map((binding) => `${binding.agentId}\0${binding.skillId}`);
  if (new Set(bindingKeys).size !== bindingKeys.length) {
    throw new SkillRegistryError("SKILL_REGISTRY_CORRUPT", "Skill Registry 存在重复 Agent-Skill Binding");
  }
  for (const binding of state.bindings) {
    const entry = state.skills.find((candidate) => candidate.skillId === binding.skillId);
    const manifest = entry?.versions.find((version) => version.manifest.skill.version === entry.activeVersion)?.manifest;
    if (!entry || !manifest || !manifest.binding.allowedAgentProfileIds.includes(binding.profileId)) {
      throw new SkillRegistryError("SKILL_REGISTRY_CORRUPT", "Agent-Skill Binding 引用不存在或不允许的 Skill");
    }
    if (entry.status === "revoked" && binding.enabled) {
      throw new SkillRegistryError("SKILL_REGISTRY_CORRUPT", "已撤销 Skill 不能保留启用 Binding");
    }
  }
  return state;
}

function parseV1(input: unknown, expectedOwnerHash: string): SkillRegistryState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new SkillRegistryError("SKILL_REGISTRY_CORRUPT", "Skill Registry 不是对象");
  }
  const state = input as Record<string, unknown>;
  if (
    !exactKeys(state, ["bindings", "ownerHash", "revision", "schemaVersion", "skills"]) ||
    state.schemaVersion !== REGISTRY_SCHEMA ||
    state.ownerHash !== expectedOwnerHash ||
    !HEX_64.test(String(state.ownerHash)) ||
    !Number.isSafeInteger(state.revision) ||
    (state.revision as number) < 0 ||
    !Array.isArray(state.skills) ||
    !Array.isArray(state.bindings)
  ) {
    const code = state.ownerHash !== expectedOwnerHash ? "SKILL_REGISTRY_OWNER_MISMATCH" : "SKILL_REGISTRY_CORRUPT";
    throw new SkillRegistryError(code, "Skill Registry 格式、版本或 owner 无效");
  }
  return validateRelationships({
    schemaVersion: REGISTRY_SCHEMA,
    ownerHash: expectedOwnerHash,
    revision: state.revision as number,
    skills: state.skills.map(parseSkillEntry),
    bindings: state.bindings.map(parseBinding),
  });
}

function parseLegacy(input: Record<string, unknown>, expectedOwnerHash: string, now: string): SkillRegistryState {
  if (
    !exactKeys(input, ["bindings", "ownerHash", "revision", "schemaVersion", "skills"]) ||
    input.schemaVersion !== LEGACY_SCHEMA ||
    input.ownerHash !== expectedOwnerHash ||
    !Number.isSafeInteger(input.revision) ||
    (input.revision as number) < 0 ||
    !Array.isArray(input.skills) ||
    !Array.isArray(input.bindings)
  ) {
    throw new SkillRegistryError("SKILL_REGISTRY_CORRUPT", "旧 Skill Registry 格式无效");
  }
  const skills = input.skills.map((candidate) => {
    const parsed = validateSkillPackage(candidate);
    if (!parsed.ok) throw new SkillRegistryError("SKILL_REGISTRY_CORRUPT", "旧 Skill Manifest 无效");
    return {
      skillId: parsed.manifest.skill.id,
      publisherNamespace: parsed.manifest.skill.publisher.namespace,
      activeVersion: parsed.manifest.skill.version,
      status: "installed" as const,
      versions: [{ manifest: parsed.manifest, installedAt: now }],
      updatedAt: now,
    };
  });
  const bindings = input.bindings.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new SkillRegistryError("SKILL_REGISTRY_CORRUPT", "旧 Binding 无效");
    }
    const binding = candidate as Record<string, unknown>;
    if (
      !exactKeys(binding, ["agentId", "enabled", "profileId", "skillId"]) ||
      typeof binding.skillId !== "string" ||
      typeof binding.profileId !== "string" ||
      typeof binding.agentId !== "string" ||
      binding.agentId !== agentIdForProfile(binding.profileId) ||
      typeof binding.enabled !== "boolean"
    ) {
      throw new SkillRegistryError("SKILL_REGISTRY_CORRUPT", "旧 Binding 格式无效");
    }
    return { ...binding, createdAt: now, updatedAt: now } as AgentSkillBinding;
  });
  return validateRelationships({
    schemaVersion: REGISTRY_SCHEMA,
    ownerHash: expectedOwnerHash,
    revision: (input.revision as number) + 1,
    skills,
    bindings,
  });
}

export class SkillRegistry {
  private state: SkillRegistryState;
  private readonly ownerHash: string;
  private readonly backupPath: string;

  constructor(
    private readonly filePath: string,
    ownerScope: string,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.ownerHash = ownerHash(ownerScope);
    this.backupPath = `${filePath}.bak`;
    this.state = this.load();
  }

  listSkills(): readonly SkillRegistryEntry[] {
    return cloneState(this.state.skills);
  }

  listBindings(agentId?: string): readonly AgentSkillBinding[] {
    const bindings = agentId === undefined
      ? this.state.bindings
      : this.state.bindings.filter((binding) => binding.agentId === agentId);
    return cloneState(bindings);
  }

  findSkill(skillId: string): SkillRegistryEntry | undefined {
    const entry = this.state.skills.find((candidate) => candidate.skillId === skillId);
    return entry ? cloneState(entry) : undefined;
  }

  activeManifest(skillId: string): SkillPackage | undefined {
    const entry = this.state.skills.find((candidate) => candidate.skillId === skillId);
    const manifest = entry?.versions.find((version) => version.manifest.skill.version === entry.activeVersion)?.manifest;
    return manifest ? cloneState(manifest) : undefined;
  }

  install(manifestInput: unknown, activate = true): SkillRegistryEntry {
    const parsed = validateSkillPackage(manifestInput);
    if (!parsed.ok) throw new SkillRegistryError("SKILL_PACKAGE_INVALID", "Skill Package 无效");
    const manifest = parsed.manifest;
    const existing = this.state.skills.find((entry) => entry.skillId === manifest.skill.id);
    try {
      assertSkillIdOwnership({
        skillId: manifest.skill.id,
        publisherNamespace: manifest.skill.publisher.namespace,
        existingPublisherNamespace: existing?.publisherNamespace,
      });
    } catch (error) {
      throw new SkillRegistryError(
        error instanceof Error ? error.message : "SKILL_ID_OWNERSHIP_CONFLICT",
        "Skill ID 发布方所有权冲突",
      );
    }
    const sameVersion = existing?.versions.find((version) => version.manifest.skill.version === manifest.skill.version);
    if (sameVersion) {
      if (sameVersion.manifest.integrity.digest !== manifest.integrity.digest) {
        throw new SkillRegistryError("SKILL_VERSION_IMMUTABLE", "同一 Skill 版本的摘要不可变化");
      }
      return cloneState(existing!);
    }
    const now = this.clock().toISOString();
    const next: SkillRegistryEntry = existing
      ? {
          ...existing,
          ...(activate ? { previousVersion: existing.activeVersion, activeVersion: manifest.skill.version } : {}),
          status: "installed",
          versions: [...existing.versions, { manifest, installedAt: now }],
          updatedAt: now,
        }
      : {
          skillId: manifest.skill.id,
          publisherNamespace: manifest.skill.publisher.namespace,
          activeVersion: manifest.skill.version,
          status: "installed",
          versions: [{ manifest, installedAt: now }],
          updatedAt: now,
        };
    this.commit(
      existing
        ? this.state.skills.map((entry) => entry.skillId === next.skillId ? next : entry)
        : [...this.state.skills, next],
      this.state.bindings,
    );
    return cloneState(next);
  }

  bind(params: { skillId: string; profileId: string; agentId: string; enabled?: boolean }): AgentSkillBinding {
    if (params.agentId !== agentIdForProfile(params.profileId)) {
      throw new SkillRegistryError("SKILL_BINDING_AGENT_MISMATCH", "Agent ID 与 Profile 不匹配");
    }
    const skill = this.state.skills.find((entry) => entry.skillId === params.skillId);
    const manifest = skill?.versions.find((version) => version.manifest.skill.version === skill.activeVersion)?.manifest;
    if (!skill || !manifest || skill.status !== "installed") {
      throw new SkillRegistryError("SKILL_NOT_INSTALLED", "Skill 未安装或已撤销");
    }
    if (!manifest.binding.allowedAgentProfileIds.includes(params.profileId)) {
      throw new SkillRegistryError("SKILL_BINDING_NOT_ALLOWED", "Skill 不允许绑定此 Agent Profile");
    }
    const existing = this.state.bindings.find(
      (binding) => binding.agentId === params.agentId && binding.skillId === params.skillId,
    );
    const now = this.clock().toISOString();
    const next: AgentSkillBinding = {
      skillId: params.skillId,
      profileId: params.profileId,
      agentId: params.agentId,
      enabled: params.enabled ?? manifest.binding.defaultEnabled,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (existing && existing.enabled === next.enabled && existing.profileId === next.profileId) {
      return cloneState(existing);
    }
    this.commit(
      this.state.skills,
      existing
        ? this.state.bindings.map((binding) =>
            binding.agentId === params.agentId && binding.skillId === params.skillId ? next : binding)
        : [...this.state.bindings, next],
    );
    return cloneState(next);
  }

  setBindingEnabled(skillId: string, agentId: string, enabled: boolean): AgentSkillBinding {
    const entry = this.state.skills.find((candidate) => candidate.skillId === skillId);
    const binding = this.state.bindings.find(
      (candidate) => candidate.skillId === skillId && candidate.agentId === agentId,
    );
    if (!entry || !binding) throw new SkillRegistryError("SKILL_BINDING_NOT_FOUND", "Agent-Skill Binding 不存在");
    if (enabled && entry.status !== "installed") {
      throw new SkillRegistryError("SKILL_REVOKED", "已撤销 Skill 不能启用");
    }
    if (binding.enabled === enabled) return cloneState(binding);
    const next = { ...binding, enabled, updatedAt: this.clock().toISOString() };
    this.commit(
      this.state.skills,
      this.state.bindings.map((candidate) =>
        candidate.skillId === skillId && candidate.agentId === agentId ? next : candidate),
    );
    return cloneState(next);
  }

  activateVersion(skillId: string, version: string): SkillRegistryEntry {
    const entry = this.state.skills.find((candidate) => candidate.skillId === skillId);
    if (!entry) throw new SkillRegistryError("SKILL_NOT_INSTALLED", "Skill 未安装");
    if (entry.status !== "installed") throw new SkillRegistryError("SKILL_REVOKED", "已撤销 Skill 不能切换版本");
    if (!entry.versions.some((candidate) => candidate.manifest.skill.version === version)) {
      throw new SkillRegistryError("SKILL_VERSION_NOT_INSTALLED", "目标 Skill 版本未安装");
    }
    if (entry.activeVersion === version) return cloneState(entry);
    const next: SkillRegistryEntry = {
      ...entry,
      activeVersion: version,
      previousVersion: entry.activeVersion,
      updatedAt: this.clock().toISOString(),
    };
    this.commit(
      this.state.skills.map((candidate) => candidate.skillId === skillId ? next : candidate),
      this.state.bindings,
    );
    return cloneState(next);
  }

  rollback(skillId: string): SkillRegistryEntry {
    const entry = this.state.skills.find((candidate) => candidate.skillId === skillId);
    if (!entry?.previousVersion) {
      throw new SkillRegistryError("SKILL_ROLLBACK_UNAVAILABLE", "Skill 没有可回滚版本");
    }
    return this.activateVersion(skillId, entry.previousVersion);
  }

  markRevoked(skillId: string): SkillRegistryEntry {
    const entry = this.state.skills.find((candidate) => candidate.skillId === skillId);
    if (!entry) throw new SkillRegistryError("SKILL_NOT_INSTALLED", "Skill 未安装");
    if (entry.status === "revoked") return cloneState(entry);
    const now = this.clock().toISOString();
    const next = { ...entry, status: "revoked" as const, updatedAt: now };
    this.commit(
      this.state.skills.map((candidate) => candidate.skillId === skillId ? next : candidate),
      this.state.bindings.map((binding) => binding.skillId === skillId
        ? { ...binding, enabled: false, updatedAt: now }
        : binding),
    );
    return cloneState(next);
  }

  remove(skillId: string): void {
    if (!this.state.skills.some((candidate) => candidate.skillId === skillId)) {
      throw new SkillRegistryError("SKILL_NOT_INSTALLED", "Skill 未安装");
    }
    this.commit(
      this.state.skills.filter((candidate) => candidate.skillId !== skillId),
      this.state.bindings.filter((binding) => binding.skillId !== skillId),
    );
  }

  snapshot(): SkillRegistrySnapshot {
    return { revision: this.state.revision, skills: this.listSkills(), bindings: this.listBindings() };
  }

  restore(snapshot: SkillRegistrySnapshot): void {
    if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
      throw new SkillRegistryError("SKILL_REGISTRY_SNAPSHOT_INVALID", "Skill Registry 快照 revision 无效");
    }
    const checked = validateRelationships({
      schemaVersion: REGISTRY_SCHEMA,
      ownerHash: this.ownerHash,
      revision: this.state.revision,
      skills: cloneState([...snapshot.skills]),
      bindings: cloneState([...snapshot.bindings]),
    });
    this.commit(checked.skills, checked.bindings);
  }

  private load(): SkillRegistryState {
    if (!existsSync(this.filePath)) {
      if (existsSync(this.backupPath)) return this.recoverFromBackup();
      return { schemaVersion: REGISTRY_SCHEMA, ownerHash: this.ownerHash, revision: 0, skills: [], bindings: [] };
    }
    try {
      const input = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
      if (input && typeof input === "object" && !Array.isArray(input) &&
        (input as Record<string, unknown>).schemaVersion === LEGACY_SCHEMA) {
        const migrated = parseLegacy(input as Record<string, unknown>, this.ownerHash, this.clock().toISOString());
        this.writeCurrent(migrated);
        return migrated;
      }
      return parseV1(input, this.ownerHash);
    } catch (error) {
      if (error instanceof SkillRegistryError && error.code === "SKILL_REGISTRY_OWNER_MISMATCH") throw error;
      if (existsSync(this.backupPath)) return this.recoverFromBackup();
      throw new SkillRegistryError("SKILL_REGISTRY_CORRUPT", "Skill Registry 损坏且没有可用备份");
    }
  }

  private recoverFromBackup(): SkillRegistryState {
    try {
      const recovered = parseV1(JSON.parse(readFileSync(this.backupPath, "utf8")) as unknown, this.ownerHash);
      this.writeCurrent(recovered);
      return recovered;
    } catch (error) {
      if (error instanceof SkillRegistryError && error.code === "SKILL_REGISTRY_OWNER_MISMATCH") throw error;
      throw new SkillRegistryError("SKILL_REGISTRY_CORRUPT", "Skill Registry 及备份均不可恢复");
    }
  }

  private commit(skills: readonly SkillRegistryEntry[], bindings: readonly AgentSkillBinding[]): void {
    const next = validateRelationships({
      schemaVersion: REGISTRY_SCHEMA,
      ownerHash: this.ownerHash,
      revision: this.state.revision + 1,
      skills: cloneState([...skills]).sort((a, b) => a.skillId.localeCompare(b.skillId, "en")),
      bindings: cloneState([...bindings]).sort((a, b) =>
        `${a.agentId}\0${a.skillId}`.localeCompare(`${b.agentId}\0${b.skillId}`, "en")),
    });
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp`;
    writeFileSync(temporary, JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
    if (existsSync(this.filePath)) {
      if (!lstatSync(this.filePath).isFile() || lstatSync(this.filePath).isSymbolicLink()) {
        throw new SkillRegistryError("SKILL_REGISTRY_UNSAFE_PATH", "Skill Registry 路径不是普通文件");
      }
      const backupTemporary = `${this.backupPath}.tmp`;
      copyFileSync(this.filePath, backupTemporary);
      renameSync(backupTemporary, this.backupPath);
    }
    renameSync(temporary, this.filePath);
    this.state = next;
  }

  private writeCurrent(state: SkillRegistryState): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp`;
    writeFileSync(temporary, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.filePath);
  }
}
