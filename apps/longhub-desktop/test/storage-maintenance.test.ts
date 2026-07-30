import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  maintainManagedStorage,
  measureManagedState,
  RotatingJsonlLogWriter,
  StorageFreeSpaceError,
  StorageQuotaCheckError,
  StorageQuotaExceededError,
} from "../src/storage-maintenance.js";

const roots: string[] = [];
const UUID = "12345678-1234-4234-9234-123456789abc";

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "longhub-storage-"));
  roots.push(value);
  return value;
}

function old(path: string): void {
  utimesSync(path, new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-01T00:00:00.000Z"));
}

afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe("龙枢受管状态维护", () => {
  it("只清理固定命名的过期临时文件和下载，不触碰 OpenClaw 会话", () => {
    const userData = root();
    const session = join(userData, "openclaw", "agents", "main", "sessions", "history.jsonl");
    mkdirSync(join(session, ".."), { recursive: true });
    writeFileSync(session, "用户会话必须保留");

    const snapshotTemp = join(userData, "client-updates", "snapshots", `9-0.5.0-${UUID}.tmp`);
    mkdirSync(snapshotTemp, { recursive: true });
    writeFileSync(join(snapshotTemp, "partial"), "1234");
    old(snapshotTemp);

    const versionDir = join(userData, "client-updates", "downloads", "0.5.0");
    mkdirSync(versionDir, { recursive: true });
    const completed = join(versionDir, "LongHub-Setup-0.5.0.exe");
    const unknown = join(versionDir, "keep-me.bin");
    writeFileSync(completed, "12345");
    writeFileSync(unknown, "unknown");
    old(completed);

    const report = maintainManagedStorage({
      userDataDir: userData,
      nowMs: Date.parse("2026-07-30T00:00:00.000Z"),
      policy: { stateHardLimitBytes: 1024 * 1024 },
    });

    expect(existsSync(snapshotTemp)).toBe(false);
    expect(existsSync(completed)).toBe(false);
    expect(readFileSync(session, "utf8")).toBe("用户会话必须保留");
    expect(readFileSync(unknown, "utf8")).toBe("unknown");
    expect(report.reclaimedBytes).toBe(9);
    expect(report).not.toHaveProperty("paths");
  });

  it("保留 pending 更新引用的旧下载和快照临时目录", () => {
    const userData = root();
    const snapshotTemp = join(userData, "client-updates", "snapshots", `9-0.5.0-${UUID}.tmp`);
    const installer = join(userData, "client-updates", "downloads", "0.5.0", "LongHub-Setup-0.5.0.exe");
    mkdirSync(snapshotTemp, { recursive: true });
    mkdirSync(join(installer, ".."), { recursive: true });
    writeFileSync(join(snapshotTemp, "partial"), "snapshot");
    writeFileSync(installer, "installer");
    old(snapshotTemp);
    old(installer);

    maintainManagedStorage({
      userDataDir: userData,
      protectedPaths: [snapshotTemp, installer],
      nowMs: Date.parse("2026-07-30T00:00:00.000Z"),
      policy: { stateHardLimitBytes: 1024 * 1024 },
    });

    expect(existsSync(snapshotTemp)).toBe(true);
    expect(existsSync(installer)).toBe(true);
  });

  it("不跟随符号链接，也不删除链接目标", () => {
    const userData = root();
    const external = root();
    const secret = join(external, "LongHub-Setup-0.5.0.exe");
    writeFileSync(secret, "outside");
    const versionDir = join(userData, "client-updates", "downloads", "0.5.0");
    mkdirSync(versionDir, { recursive: true });
    const link = join(versionDir, "LongHub-Setup-0.5.0.exe");
    symlinkSync(secret, link, "file");
    old(link);

    const report = maintainManagedStorage({
      userDataDir: userData,
      nowMs: Date.parse("2026-07-30T00:00:00.000Z"),
      policy: { stateHardLimitBytes: 1024 * 1024 },
    });

    expect(existsSync(link)).toBe(true);
    expect(readFileSync(secret, "utf8")).toBe("outside");
    expect(report.skippedUnsafeEntries).toBe(1);
  });

  it("无法安全释放时返回固定配额错误，不删除会话", () => {
    const userData = root();
    const session = join(userData, "openclaw", "sessions", "large.jsonl");
    mkdirSync(join(session, ".."), { recursive: true });
    writeFileSync(session, "x".repeat(64));

    expect(() => maintainManagedStorage({
      userDataDir: userData,
      policy: { stateHardLimitBytes: 32 },
    })).toThrow(StorageQuotaExceededError);
    expect(existsSync(session)).toBe(true);
    expect(measureManagedState(userData)).toBe(64);
  });

  it("无法在条目上限内确认大小时同样安全阻断", () => {
    const userData = root();
    const session = join(userData, "openclaw", "sessions", "history.jsonl");
    mkdirSync(join(session, ".."), { recursive: true });
    writeFileSync(session, "history");
    expect(() => maintainManagedStorage({
      userDataDir: userData,
      policy: { maxEntriesScanned: 1 },
    })).toThrow(StorageQuotaCheckError);
    expect(readFileSync(session, "utf8")).toBe("history");
  });

  it("龙枢受管根被替换为符号链接时安全阻断，不扫描外部目录", () => {
    const userData = root();
    const external = root();
    const session = join(external, "sessions", "history.jsonl");
    mkdirSync(join(session, ".."), { recursive: true });
    writeFileSync(session, "outside-history");
    symlinkSync(external, join(userData, "openclaw"), "junction");

    expect(() => maintainManagedStorage({ userDataDir: userData })).toThrow(StorageQuotaCheckError);
    expect(readFileSync(session, "utf8")).toBe("outside-history");
  });

  it("磁盘剩余空间低于保留线时固定失败且不删除会话", () => {
    const userData = root();
    const session = join(userData, "openclaw", "sessions", "history.jsonl");
    mkdirSync(join(session, ".."), { recursive: true });
    writeFileSync(session, "history");

    expect(() => maintainManagedStorage({
      userDataDir: userData,
      availableBytes: () => 255 * 1024 * 1024,
    })).toThrow(StorageFreeSpaceError);
    expect(readFileSync(session, "utf8")).toBe("history");
  });
});

describe("JSONL 日志轮转", () => {
  it("限制单文件和保留数量，并保持每行 JSONL", () => {
    const userData = root();
    const writer = new RotatingJsonlLogWriter(userData, { logFileBytes: 1_024, retainedLogFiles: 2 });
    for (let index = 0; index < 20; index += 1) writer.write(JSON.stringify({ index, value: "x".repeat(90) }));

    const logs = join(userData, "logs");
    expect(existsSync(join(logs, "desktop.jsonl"))).toBe(true);
    expect(existsSync(join(logs, "desktop.1.jsonl"))).toBe(true);
    expect(existsSync(join(logs, "desktop.2.jsonl"))).toBe(false);
    for (const name of ["desktop.jsonl", "desktop.1.jsonl"]) {
      const content = readFileSync(join(logs, name), "utf8");
      expect(Buffer.byteLength(content)).toBeLessThanOrEqual(1_024);
      for (const line of content.trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("拒绝把日志写入符号链接", () => {
    const userData = root();
    const outside = root();
    mkdirSync(join(userData, "logs"), { recursive: true });
    const target = join(outside, "target.jsonl");
    writeFileSync(target, "safe");
    symlinkSync(target, join(userData, "logs", "desktop.jsonl"), "file");
    expect(() => new RotatingJsonlLogWriter(userData)).toThrow(/日志文件类型无效/);
    expect(readFileSync(target, "utf8")).toBe("safe");
  });
});
