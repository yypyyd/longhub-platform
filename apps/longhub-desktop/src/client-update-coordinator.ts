import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  signedClientUpdateMetadataSchema,
  type SignedClientUpdateMetadata,
} from "@longhub/pack-schema";
import type { TrustedClientUpdate } from "./client-update.js";

const SNAPSHOT_SCHEMA = "longhub/client-update-snapshot/v1" as const;
const PENDING_SCHEMA = "longhub/client-update-pending/v2" as const;
const LAST_ROLLBACK_SCHEMA = "longhub/client-update-last-rollback/v1" as const;
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024 * 1024;
const SNAPSHOT_ENTRIES = [
  "openclaw",
  "packs",
  "agent-registry.json",
  "trusted-keys.json",
  "device.json",
  "client-update-state.json",
] as const;
type SnapshotEntry = typeof SNAPSHOT_ENTRIES[number];

export interface PendingClientUpdate {
  schema_version: typeof PENDING_SCHEMA;
  previous_version: string;
  target_version: string;
  target_metadata: SignedClientUpdateMetadata;
  target_installer_path: string;
  rollback_metadata: SignedClientUpdateMetadata;
  rollback_installer_path: string;
  snapshot_path: string;
  attempts: number;
  phase: "installing_update" | "rollback_launched";
  reason: string | null;
  failed_state_path: string | null;
  created_at: string;
  rollback_launched_at: string | null;
}

export interface ClientUpdateStartupState {
  pending: boolean;
  attempts: number;
  targetVersion?: string;
  phase?: PendingClientUpdate["phase"];
  shouldRollback?: boolean;
  rollbackCompleted?: boolean;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...expected].sort().join("|");
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function isContained(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
}

function ensureSafeDirectory(root: string, target: string): void {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const rel = relative(resolvedRoot, resolvedTarget);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("客户端更新目录路径越界");
  mkdirSync(resolvedRoot, { recursive: true, mode: 0o700 });
  const segments = rel ? rel.split(/[\\/]/) : [];
  let current = resolvedRoot;
  for (const segment of ["", ...segments]) {
    if (segment) current = join(current, segment);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("客户端更新目录包含符号链接或异常条目");
  }
}

function safeRemoveTree(root: string, target: string): void {
  if (!isContained(root, target)) throw new Error("客户端更新清理路径越界");
  rmSync(resolve(target), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function removeStateEntry(root: string, target: string): void {
  if (!isContained(root, target)) throw new Error("客户端更新状态清理路径越界");
  if (!existsSync(target)) return;
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error(`客户端状态恢复拒绝符号链接: ${basename(target)}`);
  rmSync(target, { recursive: stat.isDirectory(), force: true, maxRetries: 3, retryDelay: 100 });
}

function copySnapshotEntry(source: string, target: string, budget: { bytes: number; files: number }): void {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`客户端状态快照拒绝符号链接: ${basename(source)}`);
  if (stat.isDirectory()) {
    mkdirSync(target, { mode: 0o700 });
    for (const entry of readdirSync(source)) {
      copySnapshotEntry(join(source, entry), join(target, entry), budget);
    }
    return;
  }
  if (!stat.isFile()) throw new Error(`客户端状态快照遇到不支持的文件类型: ${basename(source)}`);
  budget.bytes += stat.size;
  budget.files += 1;
  if (budget.bytes > MAX_SNAPSHOT_BYTES) throw new Error("客户端状态快照超过 4 GiB 安全上限");
  if (budget.files > 200_000) throw new Error("客户端状态快照文件数量超过安全上限");
  copyFileSync(source, target);
}

function validInstallerPath(path: string, version: string, trustedRoot?: string): boolean {
  if (!isAbsolute(path) || basename(path) !== `LongHub-Setup-${version}.exe` || !existsSync(path)) return false;
  if (trustedRoot) ensureSafeDirectory(trustedRoot, dirname(path));
  if (resolve(realpathSync.native(path)).toLowerCase() !== resolve(path).toLowerCase()) return false;
  const stat = lstatSync(path);
  return stat.isFile() && !stat.isSymbolicLink();
}

function validInstallerReference(path: string, version: string): boolean {
  return isAbsolute(path) && basename(path) === `LongHub-Setup-${version}.exe`;
}

/** 管理可信安装器库存、安装前快照、失败恢复和跨版本健康标记。 */
export class ClientUpdateRecoveryStore {
  private readonly updateRoot: string;
  private readonly pendingFile: string;
  private readonly snapshotsRoot: string;
  private readonly installersRoot: string;
  private readonly failedStatesRoot: string;
  private readonly lastRollbackFile: string;

  constructor(private readonly userDataDir: string) {
    this.updateRoot = join(userDataDir, "client-updates");
    this.pendingFile = join(this.updateRoot, "pending-update.json");
    this.snapshotsRoot = join(this.updateRoot, "snapshots");
    this.installersRoot = join(this.updateRoot, "installers");
    this.failedStatesRoot = join(this.updateRoot, "failed-states");
    this.lastRollbackFile = join(this.updateRoot, "last-rollback.json");
    ensureSafeDirectory(this.userDataDir, this.updateRoot);
    ensureSafeDirectory(this.userDataDir, this.snapshotsRoot);
    ensureSafeDirectory(this.userDataDir, this.installersRoot);
    ensureSafeDirectory(this.userDataDir, this.failedStatesRoot);
  }

  get rollbackRecordPath(): string {
    return this.lastRollbackFile;
  }

  /** 清理器必须保留仍被更新事务引用的快照、安装器和失败状态。 */
  maintenanceProtectedPaths(): readonly string[] {
    const pending = this.readPending();
    if (!pending) return [];
    return [
      pending.snapshot_path,
      pending.target_installer_path,
      pending.rollback_installer_path,
      ...(pending.failed_state_path ? [pending.failed_state_path] : []),
    ];
  }

  installerDirectory(version: string): string {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("客户端安装器库存版本无效");
    const directory = join(this.installersRoot, version);
    ensureSafeDirectory(this.installersRoot, directory);
    return directory;
  }

  createPending(
    currentVersion: string,
    targetMetadata: SignedClientUpdateMetadata,
    targetInstallerPath: string,
    rollbackMetadata: SignedClientUpdateMetadata,
    rollbackInstallerPath: string,
  ): PendingClientUpdate {
    if (existsSync(this.pendingFile)) throw new Error("已有客户端更新等待健康确认");
    const target = signedClientUpdateMetadataSchema.parse(targetMetadata);
    const rollback = signedClientUpdateMetadataSchema.parse(rollbackMetadata);
    if (
      target.manifest.version === currentVersion || rollback.manifest.version !== currentVersion ||
      target.manifest.channel !== rollback.manifest.channel
    ) throw new Error("客户端更新新旧版本元数据不匹配");
    if (!validInstallerPath(targetInstallerPath, target.manifest.version)) {
      throw new Error("客户端更新目标安装器路径无效");
    }
    if (
      !validInstallerPath(rollbackInstallerPath, currentVersion, this.installersRoot) ||
      !isContained(this.installersRoot, rollbackInstallerPath)
    ) throw new Error("客户端更新回滚安装器不在可信库存");

    const snapshotPath = join(
      this.snapshotsRoot,
      `${target.manifest.sequence}-${target.manifest.version}-${randomUUID()}`,
    );
    const temporary = `${snapshotPath}.tmp`;
    mkdirSync(temporary, { recursive: true, mode: 0o700 });
    const budget = { bytes: 0, files: 0 };
    const entries: SnapshotEntry[] = [];
    try {
      for (const entry of SNAPSHOT_ENTRIES) {
        const source = join(this.userDataDir, entry);
        if (!existsSync(source)) continue;
        copySnapshotEntry(source, join(temporary, entry), budget);
        entries.push(entry);
      }
      atomicJson(join(temporary, "snapshot.json"), {
        schema_version: SNAPSHOT_SCHEMA,
        previous_version: currentVersion,
        target_version: target.manifest.version,
        sequence: target.manifest.sequence,
        created_at: new Date().toISOString(),
        entries,
        files: budget.files,
        bytes: budget.bytes,
      });
      renameSync(temporary, snapshotPath);
    } catch (error) {
      if (existsSync(temporary)) safeRemoveTree(this.snapshotsRoot, temporary);
      throw error;
    }
    const pending: PendingClientUpdate = {
      schema_version: PENDING_SCHEMA,
      previous_version: currentVersion,
      target_version: target.manifest.version,
      target_metadata: target,
      target_installer_path: resolve(targetInstallerPath),
      rollback_metadata: rollback,
      rollback_installer_path: resolve(rollbackInstallerPath),
      snapshot_path: snapshotPath,
      attempts: 0,
      phase: "installing_update",
      reason: null,
      failed_state_path: null,
      created_at: new Date().toISOString(),
      rollback_launched_at: null,
    };
    try {
      atomicJson(this.pendingFile, pending);
    } catch (error) {
      safeRemoveTree(this.snapshotsRoot, snapshotPath);
      throw error;
    }
    return pending;
  }

  beginStartup(currentVersion: string, maxAttempts = 3): ClientUpdateStartupState {
    const pending = this.readPending();
    if (!pending) return { pending: false, attempts: 0 };
    if (pending.phase === "rollback_launched" && pending.previous_version === currentVersion) {
      atomicJson(this.lastRollbackFile, {
        schema_version: LAST_ROLLBACK_SCHEMA,
        previous_version: pending.previous_version,
        target_version: pending.target_version,
        sequence: pending.target_metadata.manifest.sequence,
        attempts: pending.attempts,
        reason: pending.reason ?? "startup_failure",
        rolled_back_at: new Date().toISOString(),
        failed_state_path: pending.failed_state_path ?? "",
        snapshot_path: pending.snapshot_path,
      });
      rmSync(this.pendingFile, { force: true });
      this.pruneSnapshots(2);
      this.pruneInstallers(new Set([pending.previous_version]));
      return { pending: false, attempts: pending.attempts, rollbackCompleted: true };
    }
    if (pending.target_version === currentVersion) {
      pending.attempts += 1;
      atomicJson(this.pendingFile, pending);
    }
    return {
      pending: true,
      attempts: pending.attempts,
      targetVersion: pending.target_version,
      phase: pending.phase,
      shouldRollback: pending.target_version === currentVersion &&
        (pending.phase === "rollback_launched" || pending.attempts >= maxAttempts),
    };
  }

  pending(): PendingClientUpdate | undefined {
    return this.readPending();
  }

  /** 先保留失败状态，再从固定快照恢复；重复调用会重新得到同一恢复结果。 */
  prepareRollback(reason: string): PendingClientUpdate {
    const pending = this.readPending();
    if (!pending) throw new Error("没有等待回滚的客户端更新");
    const failedStatePath = pending.failed_state_path ?? join(
      this.failedStatesRoot,
      `${pending.target_version}-${pending.target_metadata.manifest.sequence}-${randomUUID()}`,
    );
    if (!isContained(this.failedStatesRoot, failedStatePath)) throw new Error("客户端失败状态路径越界");
    if (!pending.failed_state_path) {
      pending.failed_state_path = failedStatePath;
      pending.reason = reason;
      atomicJson(this.pendingFile, pending);
    }
    ensureSafeDirectory(this.failedStatesRoot, failedStatePath);
    const snapshot = this.readSnapshot(pending);
    const snapshotEntries = new Set(snapshot.entries);
    for (const entry of SNAPSHOT_ENTRIES) {
      const active = join(this.userDataDir, entry);
      const failed = join(failedStatePath, entry);
      const saved = join(pending.snapshot_path, entry);
      if (existsSync(active) && !existsSync(failed)) {
        const stat = lstatSync(active);
        if (stat.isSymbolicLink()) throw new Error(`客户端状态恢复拒绝符号链接: ${entry}`);
        renameSync(active, failed);
      } else if (existsSync(active)) {
        removeStateEntry(this.userDataDir, active);
      }
      if (!snapshotEntries.has(entry)) continue;
      if (!existsSync(saved)) throw new Error(`客户端更新快照缺少声明项: ${entry}`);
      const temporary = join(this.userDataDir, `.${entry}.rollback-${randomUUID()}.tmp`);
      const budget = { bytes: 0, files: 0 };
      try {
        copySnapshotEntry(saved, temporary, budget);
        renameSync(temporary, active);
      } catch (error) {
        if (existsSync(temporary)) removeStateEntry(this.userDataDir, temporary);
        throw error;
      }
    }
    pending.phase = "rollback_launched";
    pending.reason = reason;
    pending.rollback_launched_at = new Date().toISOString();
    atomicJson(this.pendingFile, pending);
    return pending;
  }

  markHealthy(currentVersion: string): void {
    const pending = this.readPending();
    if (!pending || pending.phase !== "installing_update" || pending.target_version !== currentVersion) return;
    const retainedTarget = this.retainInstaller(pending.target_installer_path, pending.target_metadata);
    atomicJson(join(this.updateRoot, "last-successful-update.json"), {
      previous_version: pending.previous_version,
      target_version: pending.target_version,
      sequence: pending.target_metadata.manifest.sequence,
      attempts: pending.attempts,
      healthy_at: new Date().toISOString(),
      snapshot_path: pending.snapshot_path,
      installer_path: retainedTarget,
    });
    rmSync(this.pendingFile, { force: true });
    this.pruneSnapshots(2);
    this.pruneInstallers(new Set([pending.previous_version, pending.target_version]));
  }

  cancelPending(): void {
    const pending = this.readPending();
    rmSync(this.pendingFile, { force: true });
    if (pending && existsSync(pending.snapshot_path)) safeRemoveTree(this.snapshotsRoot, pending.snapshot_path);
  }

  private retainInstaller(source: string, metadata: SignedClientUpdateMetadata): string {
    if (!validInstallerPath(source, metadata.manifest.version)) throw new Error("客户端更新安装器库存源无效");
    const directory = this.installerDirectory(metadata.manifest.version);
    ensureSafeDirectory(this.installersRoot, directory);
    const target = join(directory, metadata.manifest.filename);
    if (!existsSync(target)) linkSync(source, target);
    if (!validInstallerPath(target, metadata.manifest.version)) throw new Error("客户端更新安装器库存目标无效");
    return target;
  }

  private readSnapshot(pending: PendingClientUpdate): { entries: SnapshotEntry[] } {
    if (!isContained(this.snapshotsRoot, pending.snapshot_path)) throw new Error("客户端更新快照路径越界");
    const manifestPath = join(pending.snapshot_path, "snapshot.json");
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
      !exactKeys(parsed, [
        "schema_version", "previous_version", "target_version", "sequence",
        "created_at", "entries", "files", "bytes",
      ])
    ) throw new Error("客户端更新快照清单损坏");
    const value = parsed as Record<string, unknown>;
    if (
      value.schema_version !== SNAPSHOT_SCHEMA || value.previous_version !== pending.previous_version ||
      value.target_version !== pending.target_version ||
      value.sequence !== pending.target_metadata.manifest.sequence || !Array.isArray(value.entries) ||
      new Set(value.entries).size !== value.entries.length ||
      value.entries.some((entry) => !SNAPSHOT_ENTRIES.includes(entry as SnapshotEntry))
    ) throw new Error("客户端更新快照清单无效");
    return { entries: value.entries as SnapshotEntry[] };
  }

  private readPending(): PendingClientUpdate | undefined {
    if (!existsSync(this.pendingFile)) return undefined;
    const parsed = JSON.parse(readFileSync(this.pendingFile, "utf8")) as unknown;
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
      !exactKeys(parsed, [
        "schema_version", "previous_version", "target_version", "target_metadata",
        "target_installer_path", "rollback_metadata", "rollback_installer_path",
        "snapshot_path", "attempts", "phase", "reason", "failed_state_path",
        "created_at", "rollback_launched_at",
      ])
    ) throw new Error("客户端更新待确认状态损坏");
    const value = parsed as Record<string, unknown>;
    const target = signedClientUpdateMetadataSchema.safeParse(value.target_metadata);
    const rollback = signedClientUpdateMetadataSchema.safeParse(value.rollback_metadata);
    if (
      value.schema_version !== PENDING_SCHEMA || !target.success || !rollback.success ||
      typeof value.previous_version !== "string" || typeof value.target_version !== "string" ||
      target.data.manifest.version !== value.target_version ||
      rollback.data.manifest.version !== value.previous_version ||
      typeof value.snapshot_path !== "string" || !isContained(this.snapshotsRoot, value.snapshot_path) ||
      typeof value.target_installer_path !== "string" || typeof value.rollback_installer_path !== "string" ||
      !validInstallerReference(value.target_installer_path, value.target_version) ||
      !validInstallerPath(value.rollback_installer_path, value.previous_version, this.installersRoot) ||
      !isContained(this.installersRoot, value.rollback_installer_path) ||
      !Number.isSafeInteger(value.attempts) || (value.attempts as number) < 0 ||
      (value.phase !== "installing_update" && value.phase !== "rollback_launched") ||
      (value.reason !== null && typeof value.reason !== "string") ||
      (value.failed_state_path !== null &&
        (typeof value.failed_state_path !== "string" ||
          !isContained(this.failedStatesRoot, value.failed_state_path))) ||
      typeof value.created_at !== "string" || !Number.isFinite(Date.parse(value.created_at)) ||
      (value.rollback_launched_at !== null &&
        (typeof value.rollback_launched_at !== "string" || !Number.isFinite(Date.parse(value.rollback_launched_at))))
    ) throw new Error("客户端更新待确认状态无效");
    return value as unknown as PendingClientUpdate;
  }

  private pruneSnapshots(keep: number): void {
    if (!existsSync(this.snapshotsRoot)) return;
    const snapshots = readdirSync(this.snapshotsRoot)
      .map((name) => join(this.snapshotsRoot, name))
      .filter((path) => {
        const stat = lstatSync(path);
        return stat.isDirectory() && !stat.isSymbolicLink() && existsSync(join(path, "snapshot.json"));
      })
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
    for (const path of snapshots.slice(keep)) safeRemoveTree(this.snapshotsRoot, path);
  }

  private pruneInstallers(keepVersions: ReadonlySet<string>): void {
    if (!existsSync(this.installersRoot)) return;
    for (const name of readdirSync(this.installersRoot)) {
      const path = join(this.installersRoot, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("客户端安装器库存包含异常条目");
      if (!keepVersions.has(name)) safeRemoveTree(this.installersRoot, path);
    }
  }
}

export type ClientUpdateCoordinatorResult =
  | "busy"
  | "none"
  | "declined"
  | "downloaded"
  | "withdrawn"
  | "install_launched";

export interface ClientUpdateCoordinatorOptions {
  currentVersion: string;
  check: () => Promise<TrustedClientUpdate>;
  revalidate: () => Promise<TrustedClientUpdate>;
  resolveRollback: () => Promise<Required<Pick<TrustedClientUpdate, "metadata" | "artifactUrl">>>;
  confirmDownload: (metadata: SignedClientUpdateMetadata) => Promise<boolean>;
  confirmInstall: (metadata: SignedClientUpdateMetadata) => Promise<boolean>;
  download: (update: Required<Pick<TrustedClientUpdate, "metadata" | "artifactUrl">>) => Promise<string>;
  downloadRollback: (update: Required<Pick<TrustedClientUpdate, "metadata" | "artifactUrl">>) => Promise<string>;
  verifyInstaller: (path: string) => Promise<void> | void;
  stopRuntime: () => Promise<void>;
  snapshot: ClientUpdateRecoveryStore;
  launchInstaller: (path: string) => Promise<void>;
}

/** 单写者更新事务：目标安装器与旧版回滚安装器都可信后，才允许停机和启动安装。 */
export class ClientUpdateCoordinator {
  private running = false;

  constructor(private readonly options: ClientUpdateCoordinatorOptions) {}

  async checkOnce(): Promise<ClientUpdateCoordinatorResult> {
    if (this.running) return "busy";
    this.running = true;
    try {
      const update = await this.options.check();
      if (update.action !== "update_available" || !update.metadata || !update.artifactUrl) return "none";
      if (!(await this.options.confirmDownload(update.metadata))) return "declined";
      const installerPath = await this.options.download({
        metadata: update.metadata,
        artifactUrl: update.artifactUrl,
      });
      await this.options.verifyInstaller(installerPath);
      const rollback = await this.options.resolveRollback();
      const rollbackInstallerPath = await this.options.downloadRollback(rollback);
      await this.options.verifyInstaller(rollbackInstallerPath);
      if (!(await this.options.confirmInstall(update.metadata))) return "downloaded";
      const latest = await this.options.revalidate();
      if (
        latest.action !== "update_available" || !latest.metadata || !latest.artifactUrl ||
        latest.artifactUrl !== update.artifactUrl ||
        latest.metadata.manifest.version !== update.metadata.manifest.version ||
        latest.metadata.manifest.filename !== update.metadata.manifest.filename ||
        latest.metadata.manifest.size !== update.metadata.manifest.size ||
        latest.metadata.manifest.sha256 !== update.metadata.manifest.sha256
      ) return "withdrawn";
      await this.options.stopRuntime();
      this.options.snapshot.createPending(
        this.options.currentVersion,
        latest.metadata,
        installerPath,
        rollback.metadata,
        rollbackInstallerPath,
      );
      try {
        await this.options.launchInstaller(installerPath);
      } catch (error) {
        this.options.snapshot.cancelPending();
        throw error;
      }
      return "install_launched";
    } finally {
      this.running = false;
    }
  }
}
