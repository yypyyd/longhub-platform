import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const VERSION = "\\d+\\.\\d+\\.\\d+";
const ROLLBACK_ENTRY = [
  "openclaw",
  "packs",
  "agent-registry\\.json",
  "trusted-keys\\.json",
  "device\\.json",
  "client-update-state\\.json",
].join("|");
const ROOT_ROLLBACK_TEMP = new RegExp(
  `^\\.(?:${ROLLBACK_ENTRY})\\.rollback-${UUID}\\.tmp$`,
  "i",
);
const SNAPSHOT_TEMP = new RegExp(`^\\d+-${VERSION}-${UUID}\\.tmp$`, "i");
const DOWNLOAD_TEMP = new RegExp(`^\\.LongHub-Setup-${VERSION}\\.exe\\.${UUID}\\.download$`, "i");
const COMPLETED_INSTALLER = new RegExp(`^LongHub-Setup-${VERSION}\\.exe$`, "i");
const VERSION_DIRECTORY = new RegExp(`^${VERSION}$`);
const UUID_ATOMIC_TEMP = new RegExp(`^\\.${UUID}\\.tmp$`, "i");
const ROOT_ATOMIC_TEMP = new RegExp(
  `^(?:agent-registry\\.json|trusted-keys\\.json|openclaw\\.json)\\.tmp$|^device\\.json\\.\\d+\\.${UUID}\\.tmp$`,
  "i",
);
const OPENCLAW_ATOMIC_TEMP = new RegExp(`^runtime-config-cache\\.json\\.\\d+\\.${UUID}\\.tmp$`, "i");
const PACK_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const PACK_TEMP = new RegExp(`^\\.staging-${VERSION}$|^current\\.json\\.tmp$`);

export const DEFAULT_STORAGE_POLICY = Object.freeze({
  logFileBytes: 5 * 1024 * 1024,
  retainedLogFiles: 5,
  temporaryMaxAgeMs: 24 * 60 * 60 * 1_000,
  completedDownloadMaxAgeMs: 7 * 24 * 60 * 60 * 1_000,
  stateHardLimitBytes: 8 * 1024 * 1024 * 1024,
  minimumFreeBytes: 256 * 1024 * 1024,
  maxEntriesScanned: 250_000,
});

export interface StoragePolicy {
  logFileBytes: number;
  retainedLogFiles: number;
  temporaryMaxAgeMs: number;
  completedDownloadMaxAgeMs: number;
  stateHardLimitBytes: number;
  minimumFreeBytes: number;
  maxEntriesScanned: number;
}

export interface StorageMaintenanceReport {
  deletedFiles: number;
  deletedDirectories: number;
  reclaimedBytes: number;
  stateBytes: number;
  skippedUnsafeEntries: number;
  errors: number;
}

export class StorageQuotaExceededError extends Error {
  readonly code = "STORAGE_QUOTA_EXCEEDED";

  constructor(readonly stateBytes: number, readonly limitBytes: number) {
    super("龙枢专属状态目录超过安全上限，且没有可安全清理的数据");
    this.name = "StorageQuotaExceededError";
  }
}

export class StorageQuotaCheckError extends Error {
  readonly code = "STORAGE_QUOTA_EXCEEDED";

  constructor() {
    super("无法在扫描安全上限内确认龙枢专属状态大小");
    this.name = "StorageQuotaCheckError";
  }
}

export class StorageFreeSpaceError extends Error {
  readonly code = "STORAGE_SPACE_LOW";

  constructor(readonly availableBytes: number, readonly requiredBytes: number) {
    super("龙枢所在磁盘的剩余空间低于安全运行下限");
    this.name = "StorageFreeSpaceError";
  }
}

function contained(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
}

function ensurePrivateDirectory(root: string, target: string): void {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const rel = relative(resolvedRoot, resolvedTarget);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("受管存储目录路径越界");
  mkdirSync(resolvedRoot, { recursive: true, mode: 0o700 });
  let current = resolvedRoot;
  for (const segment of ["", ...(rel ? rel.split(/[\\/]/) : [])]) {
    if (segment) current = join(current, segment);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("受管存储目录包含符号链接或异常条目");
  }
  if (resolve(realpathSync.native(resolvedTarget)).toLowerCase() !== resolvedTarget.toLowerCase()) {
    throw new Error("受管存储目录真实路径越界");
  }
}

function normalizedPaths(paths: readonly string[]): Set<string> {
  return new Set(paths.map((path) => resolve(path).toLowerCase()));
}

function isProtected(target: string, protectedPaths: ReadonlySet<string>): boolean {
  const resolved = resolve(target).toLowerCase();
  for (const protectedPath of protectedPaths) {
    const overlaps = resolved === protectedPath ||
      contained(protectedPath, resolved) ||
      contained(resolved, protectedPath);
    if (overlaps) return true;
  }
  return false;
}

function treeSize(path: string, budget: { entries: number }, maxEntries: number): number {
  if (!existsSync(path)) return 0;
  const stat = lstatSync(path);
  budget.entries += 1;
  if (budget.entries > maxEntries) throw new Error("受管状态目录条目数量超过扫描安全上限");
  if (stat.isSymbolicLink()) return 0;
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  let bytes = 0;
  for (const entry of readdirSync(path)) bytes += treeSize(join(path, entry), budget, maxEntries);
  return bytes;
}

/** 只统计龙枢明确拥有的状态；不读取文件内容，也不跟随符号链接。 */
export function measureManagedState(
  userDataDir: string,
  maxEntries: number = DEFAULT_STORAGE_POLICY.maxEntriesScanned,
): number {
  const roots = [
    "openclaw",
    "packs",
    "client-updates",
    "logs",
    "agent-registry.json",
    "trusted-keys.json",
    "device.json",
    "client-update-state.json",
  ];
  const budget = { entries: 0 };
  return roots.reduce((bytes, name) => {
    const root = join(userDataDir, name);
    if (existsSync(root) && lstatSync(root).isSymbolicLink()) {
      throw new Error("受管状态根目录包含符号链接");
    }
    return bytes + treeSize(root, budget, maxEntries);
  }, 0);
}

function removeCandidate(
  root: string,
  target: string,
  protectedPaths: ReadonlySet<string>,
  report: StorageMaintenanceReport,
): void {
  try {
    if (!contained(root, target) || isProtected(target, protectedPaths)) return;
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
      report.skippedUnsafeEntries += 1;
      return;
    }
    if (resolve(realpathSync.native(target)).toLowerCase() !== resolve(target).toLowerCase()) {
      report.skippedUnsafeEntries += 1;
      return;
    }
    const bytes = treeSize(target, { entries: 0 }, DEFAULT_STORAGE_POLICY.maxEntriesScanned);
    rmSync(target, { recursive: stat.isDirectory(), force: true, maxRetries: 3, retryDelay: 100 });
    report.reclaimedBytes += bytes;
    if (stat.isDirectory()) report.deletedDirectories += 1;
    else report.deletedFiles += 1;
  } catch {
    report.errors += 1;
  }
}

function stale(stat: Stats, nowMs: number, maxAgeMs: number): boolean {
  return nowMs - stat.mtimeMs >= maxAgeMs;
}

function scanExactChildren(
  root: string,
  matcher: RegExp,
  ageMs: number,
  nowMs: number,
  protectedPaths: ReadonlySet<string>,
  report: StorageMaintenanceReport,
): void {
  if (!existsSync(root)) return;
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    report.skippedUnsafeEntries += 1;
    return;
  }
  for (const name of readdirSync(root)) {
    if (!matcher.test(name)) continue;
    const target = join(root, name);
    const stat = lstatSync(target);
    if (!stale(stat, nowMs, ageMs)) continue;
    removeCandidate(root, target, protectedPaths, report);
  }
}

/**
 * 清理严格白名单内的可再生文件。报告仅含计数和字节数，不返回或记录文件名、路径。
 * OpenClaw 会话/记忆、Pack、Registry、凭据和失败回滚证据从不作为候选。
 */
export function maintainManagedStorage(options: {
  userDataDir: string;
  protectedPaths?: readonly string[];
  nowMs?: number;
  policy?: Partial<StoragePolicy>;
  availableBytes?: () => number;
}): StorageMaintenanceReport {
  const policy = { ...DEFAULT_STORAGE_POLICY, ...options.policy };
  if (
    !Number.isSafeInteger(policy.temporaryMaxAgeMs) || policy.temporaryMaxAgeMs < 0 ||
    !Number.isSafeInteger(policy.completedDownloadMaxAgeMs) || policy.completedDownloadMaxAgeMs < 0 ||
    !Number.isSafeInteger(policy.stateHardLimitBytes) || policy.stateHardLimitBytes < 1 ||
    !Number.isSafeInteger(policy.minimumFreeBytes) || policy.minimumFreeBytes < 0 ||
    !Number.isSafeInteger(policy.maxEntriesScanned) || policy.maxEntriesScanned < 1
  ) throw new Error("受管存储策略无效");
  const nowMs = options.nowMs ?? Date.now();
  const protectedPaths = normalizedPaths(options.protectedPaths ?? []);
  const report: StorageMaintenanceReport = {
    deletedFiles: 0,
    deletedDirectories: 0,
    reclaimedBytes: 0,
    stateBytes: 0,
    skippedUnsafeEntries: 0,
    errors: 0,
  };

  scanExactChildren(
    options.userDataDir,
    ROOT_ROLLBACK_TEMP,
    policy.temporaryMaxAgeMs,
    nowMs,
    protectedPaths,
    report,
  );
  scanExactChildren(
    options.userDataDir,
    ROOT_ATOMIC_TEMP,
    policy.temporaryMaxAgeMs,
    nowMs,
    protectedPaths,
    report,
  );
  scanExactChildren(
    options.userDataDir,
    UUID_ATOMIC_TEMP,
    policy.temporaryMaxAgeMs,
    nowMs,
    protectedPaths,
    report,
  );
  scanExactChildren(
    join(options.userDataDir, "client-updates"),
    UUID_ATOMIC_TEMP,
    policy.temporaryMaxAgeMs,
    nowMs,
    protectedPaths,
    report,
  );
  scanExactChildren(
    join(options.userDataDir, "openclaw"),
    OPENCLAW_ATOMIC_TEMP,
    policy.temporaryMaxAgeMs,
    nowMs,
    protectedPaths,
    report,
  );
  scanExactChildren(
    join(options.userDataDir, "openclaw"),
    ROOT_ATOMIC_TEMP,
    policy.temporaryMaxAgeMs,
    nowMs,
    protectedPaths,
    report,
  );
  scanExactChildren(
    join(options.userDataDir, "client-updates", "snapshots"),
    SNAPSHOT_TEMP,
    policy.temporaryMaxAgeMs,
    nowMs,
    protectedPaths,
    report,
  );

  const packsRoot = join(options.userDataDir, "packs");
  if (existsSync(packsRoot)) {
    const packsStat = lstatSync(packsRoot);
    if (!packsStat.isDirectory() || packsStat.isSymbolicLink()) {
      report.skippedUnsafeEntries += 1;
    } else {
      for (const packId of readdirSync(packsRoot)) {
        if (!PACK_ID.test(packId)) continue;
        scanExactChildren(
          join(packsRoot, packId),
          PACK_TEMP,
          policy.temporaryMaxAgeMs,
          nowMs,
          protectedPaths,
          report,
        );
      }
    }
  }

  const downloadsRoot = join(options.userDataDir, "client-updates", "downloads");
  if (existsSync(downloadsRoot)) {
    const rootStat = lstatSync(downloadsRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      report.skippedUnsafeEntries += 1;
    } else {
      for (const version of readdirSync(downloadsRoot)) {
        if (!VERSION_DIRECTORY.test(version)) continue;
        const versionDir = join(downloadsRoot, version);
        const versionStat = lstatSync(versionDir);
        if (!versionStat.isDirectory() || versionStat.isSymbolicLink()) {
          report.skippedUnsafeEntries += 1;
          continue;
        }
        for (const name of readdirSync(versionDir)) {
          const target = join(versionDir, name);
          const stat = lstatSync(target);
          const maxAge = DOWNLOAD_TEMP.test(name)
            ? policy.temporaryMaxAgeMs
            : COMPLETED_INSTALLER.test(name)
              ? policy.completedDownloadMaxAgeMs
              : undefined;
          if (maxAge === undefined) continue;
          if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
            report.skippedUnsafeEntries += 1;
            continue;
          }
          if (!stale(stat, nowMs, maxAge)) continue;
          removeCandidate(downloadsRoot, target, protectedPaths, report);
        }
        if (!isProtected(versionDir, protectedPaths) && readdirSync(versionDir).length === 0) {
          removeCandidate(downloadsRoot, versionDir, protectedPaths, report);
        }
      }
    }
  }

  try {
    report.stateBytes = measureManagedState(options.userDataDir, policy.maxEntriesScanned);
  } catch {
    throw new StorageQuotaCheckError();
  }
  if (report.stateBytes > policy.stateHardLimitBytes) {
    throw new StorageQuotaExceededError(report.stateBytes, policy.stateHardLimitBytes);
  }
  let availableBytes: number;
  try {
    if (options.availableBytes) {
      availableBytes = options.availableBytes();
    } else {
      const filesystem = statfsSync(options.userDataDir);
      availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
    }
  } catch {
    throw new StorageQuotaCheckError();
  }
  if (!Number.isSafeInteger(availableBytes) || availableBytes < 0) throw new StorageQuotaCheckError();
  if (availableBytes < policy.minimumFreeBytes) {
    throw new StorageFreeSpaceError(availableBytes, policy.minimumFreeBytes);
  }
  return report;
}

/** 有界 JSONL 文件写入器；轮转文件名固定，拒绝符号链接和非普通文件。 */
export class RotatingJsonlLogWriter {
  private readonly directory: string;
  private readonly activePath: string;

  constructor(
    userDataDir: string,
    private readonly policy: Pick<StoragePolicy, "logFileBytes" | "retainedLogFiles"> = DEFAULT_STORAGE_POLICY,
  ) {
    if (!Number.isSafeInteger(policy.logFileBytes) || policy.logFileBytes < 1_024) {
      throw new Error("日志单文件上限无效");
    }
    if (!Number.isSafeInteger(policy.retainedLogFiles) || policy.retainedLogFiles < 1 || policy.retainedLogFiles > 32) {
      throw new Error("日志保留数量无效");
    }
    this.directory = join(userDataDir, "logs");
    this.activePath = join(this.directory, "desktop.jsonl");
    ensurePrivateDirectory(userDataDir, this.directory);
    this.assertSafeFile(this.activePath);
  }

  write(line: string): void {
    const payload = `${line.replace(/[\r\n]+/g, " ")}\n`;
    const bytes = Buffer.byteLength(payload);
    if (bytes > this.policy.logFileBytes) return;
    this.assertSafeFile(this.activePath);
    const currentBytes = existsSync(this.activePath) ? lstatSync(this.activePath).size : 0;
    if (currentBytes + bytes > this.policy.logFileBytes) this.rotate();
    appendFileSync(this.activePath, payload, { encoding: "utf8", mode: 0o600, flag: "a" });
  }

  private assertSafeFile(path: string): void {
    if (!existsSync(path)) return;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`日志文件类型无效: ${basename(path)}`);
  }

  private rotate(): void {
    for (let index = this.policy.retainedLogFiles - 1; index >= 1; index -= 1) {
      const source = index === 1 ? this.activePath : join(this.directory, `desktop.${index - 1}.jsonl`);
      const target = join(this.directory, `desktop.${index}.jsonl`);
      this.assertSafeFile(source);
      this.assertSafeFile(target);
      if (existsSync(target)) rmSync(target, { force: true });
      if (existsSync(source)) renameSync(source, target);
    }
    if (this.policy.retainedLogFiles === 1 && existsSync(this.activePath)) rmSync(this.activePath, { force: true });
  }
}
