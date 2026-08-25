import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SignedClientUpdateMetadata } from "@longhub/pack-schema";
import { ClientUpdateCoordinator, ClientUpdateRecoveryStore } from "../src/client-update-coordinator.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function metadata(version = "0.5.0"): SignedClientUpdateMetadata {
  return {
    manifest: {
      schema_version: "longhub/client-update/v2",
      product_surface: "longhub-manager",
      sequence: 9,
      version,
      channel: "stable",
      platform: "win32",
      arch: "x64",
      filename: `LongHub-Manager-Setup-${version}.exe`,
      size: 1,
      sha256: "0".repeat(64),
      url_path: `/downloads/LongHub-Manager-Setup-${version}.exe`,
      published_at: "2026-07-29T00:00:00.000Z",
      rollback_data_strategy: "snapshot_required",
      rollout: {
        status: "active",
        basis_points: 10_000,
        seed: "a".repeat(64),
        updated_at: "2026-07-29T00:00:00.000Z",
      },
    },
    signature_key_id: "update-2026",
    signature: "x".repeat(40),
  };
}

describe("稳定渠道客户端更新事务", () => {
  it("严格按检查、下载确认、验证、安装确认、停机、快照、启动执行", async () => {
    const calls: string[] = [];
    const update = metadata();
    const snapshot = {
      createPending: () => { calls.push("snapshot"); },
      cancelPending: () => calls.push("cancel"),
    };
    const coordinator = new ClientUpdateCoordinator({
      currentVersion: "0.4.0",
      check: async () => {
        calls.push("check");
        return {
          action: "update_available",
          metadata: update,
          artifactUrl: "https://cloud.example/update.exe",
        };
      },
      revalidate: async () => {
        calls.push("revalidate");
        return {
          action: "update_available",
          metadata: update,
          artifactUrl: "https://cloud.example/update.exe",
        };
      },
      resolveRollback: async () => {
        calls.push("resolve-rollback");
        return { metadata: metadata("0.4.0"), artifactUrl: "https://cloud.example/rollback.exe" };
      },
      confirmDownload: async () => { calls.push("confirm-download"); return true; },
      download: async () => { calls.push("download"); return "C:\\updates\\LongHub-Manager-Setup-0.5.0.exe"; },
      downloadRollback: async () => {
        calls.push("download-rollback");
        return "C:\\updates\\LongHub-Manager-Setup-0.4.0.exe";
      },
      verifyInstaller: () => { calls.push("verify-installer"); },
      confirmInstall: async () => { calls.push("confirm-install"); return true; },
      stopRuntime: async () => { calls.push("stop-runtime"); },
      snapshot: snapshot as unknown as ClientUpdateRecoveryStore,
      launchInstaller: async () => { calls.push("launch"); },
    });
    await expect(coordinator.checkOnce()).resolves.toBe("install_launched");
    expect(calls).toEqual([
      "check", "confirm-download", "download", "verify-installer",
      "resolve-rollback", "download-rollback", "verify-installer", "confirm-install",
      "revalidate", "stop-runtime", "snapshot", "launch",
    ]);
  });

  it("拒绝、无更新和并发检查都不会越过事务边界", async () => {
    let releaseCheck!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseCheck = resolve; });
    const update = metadata();
    const coordinator = new ClientUpdateCoordinator({
      currentVersion: "0.4.0",
      check: async () => {
        await blocked;
        return {
          action: "update_available",
          metadata: update,
          artifactUrl: "https://cloud.example/update.exe",
        };
      },
      revalidate: async () => ({ action: "none", reason: "paused" }),
      resolveRollback: async () => ({
        metadata: metadata("0.4.0"), artifactUrl: "https://cloud.example/rollback.exe",
      }),
      confirmDownload: async () => false,
      download: async () => { throw new Error("unreachable"); },
      downloadRollback: async () => { throw new Error("unreachable"); },
      verifyInstaller: () => undefined,
      confirmInstall: async () => false,
      stopRuntime: async () => undefined,
      snapshot: {} as ClientUpdateRecoveryStore,
      launchInstaller: async () => undefined,
    });
    const first = coordinator.checkOnce();
    await expect(coordinator.checkOnce()).resolves.toBe("busy");
    releaseCheck();
    await expect(first).resolves.toBe("declined");
  });

  it("安装器启动失败时撤销 pending 标记", async () => {
    const update = metadata();
    let canceled = false;
    const snapshot = { createPending: () => undefined, cancelPending: () => { canceled = true; } };
    const coordinator = new ClientUpdateCoordinator({
      currentVersion: "0.4.0",
      check: async () => ({
        action: "update_available",
        metadata: update,
        artifactUrl: "https://cloud.example/update.exe",
      }),
      revalidate: async () => ({
        action: "update_available",
        metadata: update,
        artifactUrl: "https://cloud.example/update.exe",
      }),
      resolveRollback: async () => ({
        metadata: metadata("0.4.0"), artifactUrl: "https://cloud.example/rollback.exe",
      }),
      confirmDownload: async () => true,
      download: async () => "C:\\updates\\LongHub-Manager-Setup-0.5.0.exe",
      downloadRollback: async () => "C:\\updates\\LongHub-Manager-Setup-0.4.0.exe",
      verifyInstaller: () => undefined,
      confirmInstall: async () => true,
      stopRuntime: async () => undefined,
      snapshot: snapshot as unknown as ClientUpdateRecoveryStore,
      launchInstaller: async () => { throw new Error("launch failed"); },
    });
    await expect(coordinator.checkOnce()).rejects.toThrow("launch failed");
    expect(canceled).toBe(true);
  });

  it("安装前复验发现暂停时不停止运行时或创建快照", async () => {
    const update = metadata();
    let stopped = false;
    const coordinator = new ClientUpdateCoordinator({
      currentVersion: "0.4.0",
      check: async () => ({
        action: "update_available",
        metadata: update,
        artifactUrl: "https://cloud.example/update.exe",
      }),
      revalidate: async () => ({ action: "none", reason: "paused", metadata: update }),
      resolveRollback: async () => ({
        metadata: metadata("0.4.0"), artifactUrl: "https://cloud.example/rollback.exe",
      }),
      confirmDownload: async () => true,
      download: async () => "C:\\updates\\LongHub-Manager-Setup-0.5.0.exe",
      downloadRollback: async () => "C:\\updates\\LongHub-Manager-Setup-0.4.0.exe",
      verifyInstaller: () => undefined,
      confirmInstall: async () => true,
      stopRuntime: async () => { stopped = true; },
      snapshot: {
        createPending: () => { throw new Error("unreachable"); },
      } as unknown as ClientUpdateRecoveryStore,
      launchInstaller: async () => { throw new Error("unreachable"); },
    });
    await expect(coordinator.checkOnce()).resolves.toBe("withdrawn");
    expect(stopped).toBe(false);
  });
});

describe("客户端更新跨版本健康标记", () => {
  it("快照固定状态，新版本启动计数并在健康后清除 pending", () => {
    const root = mkdtempSync(join(tmpdir(), "longhub-update-recovery-"));
    roots.push(root);
    mkdirSync(join(root, "openclaw"));
    writeFileSync(join(root, "openclaw", "state.json"), "state", "utf8");
    writeFileSync(join(root, "agent-registry.json"), "{}", "utf8");
    const installer = join(root, "LongHub-Manager-Setup-0.5.0.exe");
    writeFileSync(installer, "x", "utf8");
    const store = new ClientUpdateRecoveryStore(root);
    const rollbackDirectory = store.installerDirectory("0.4.0");
    mkdirSync(rollbackDirectory, { recursive: true });
    const rollbackInstaller = join(rollbackDirectory, "LongHub-Manager-Setup-0.4.0.exe");
    writeFileSync(rollbackInstaller, "x", "utf8");
    const pending = store.createPending(
      "0.4.0", metadata(), installer, metadata("0.4.0"), rollbackInstaller,
    );
    expect(existsSync(join(pending.snapshot_path, "openclaw", "state.json"))).toBe(true);
    const restarted = new ClientUpdateRecoveryStore(root);
    expect(restarted.beginStartup("0.4.0")).toMatchObject({
      pending: true,
      attempts: 0,
      targetVersion: "0.5.0",
    });
    expect(restarted.beginStartup("0.5.0"))
      .toMatchObject({ pending: true, attempts: 1, targetVersion: "0.5.0" });
    restarted.markHealthy("0.5.0");
    expect(existsSync(join(root, "client-updates", "pending-update.json"))).toBe(false);
    const lastSuccessful = join(root, "client-updates", "last-successful-update.json");
    expect(JSON.parse(readFileSync(lastSuccessful, "utf8"))).toMatchObject({
      previous_version: "0.4.0",
      target_version: "0.5.0",
      attempts: 1,
    });
  });

  it("第三次失败启动恢复快照、保留失败状态并由旧版本确认回滚", () => {
    const root = mkdtempSync(join(tmpdir(), "longhub-update-recovery-"));
    roots.push(root);
    mkdirSync(join(root, "openclaw"));
    writeFileSync(join(root, "openclaw", "state.json"), "stable", "utf8");
    const targetInstaller = join(root, "LongHub-Manager-Setup-0.5.0.exe");
    writeFileSync(targetInstaller, "target", "utf8");
    const store = new ClientUpdateRecoveryStore(root);
    const rollbackDirectory = store.installerDirectory("0.4.0");
    mkdirSync(rollbackDirectory, { recursive: true });
    const rollbackInstaller = join(rollbackDirectory, "LongHub-Manager-Setup-0.4.0.exe");
    writeFileSync(rollbackInstaller, "rollback", "utf8");
    store.createPending(
      "0.4.0", metadata(), targetInstaller, metadata("0.4.0"), rollbackInstaller,
    );
    writeFileSync(join(root, "openclaw", "state.json"), "broken", "utf8");
    writeFileSync(join(root, "device.json"), "new-state", "utf8");
    expect(store.beginStartup("0.5.0").shouldRollback).toBe(false);
    expect(store.beginStartup("0.5.0").shouldRollback).toBe(false);
    expect(store.beginStartup("0.5.0")).toMatchObject({ attempts: 3, shouldRollback: true });
    const rollback = store.prepareRollback("startup_failure_threshold");
    expect(readFileSync(join(root, "openclaw", "state.json"), "utf8")).toBe("stable");
    expect(readFileSync(join(rollback.failed_state_path!, "openclaw", "state.json"), "utf8")).toBe("broken");
    expect(existsSync(join(root, "device.json"))).toBe(false);
    expect(readFileSync(join(rollback.failed_state_path!, "device.json"), "utf8")).toBe("new-state");
    expect(store.prepareRollback("startup_failure_threshold").failed_state_path).toBe(rollback.failed_state_path);
    expect(readFileSync(join(root, "openclaw", "state.json"), "utf8")).toBe("stable");
    expect(store.beginStartup("0.4.0")).toMatchObject({ pending: false, rollbackCompleted: true });
    expect(JSON.parse(readFileSync(store.rollbackRecordPath, "utf8"))).toMatchObject({
      previous_version: "0.4.0",
      target_version: "0.5.0",
      attempts: 3,
      reason: "startup_failure_threshold",
    });
  });

  it("损坏或带未知字段的 pending 状态按失败关闭处理", () => {
    const root = mkdtempSync(join(tmpdir(), "longhub-update-recovery-"));
    roots.push(root);
    const path = join(root, "client-updates", "pending-update.json");
    mkdirSync(join(root, "client-updates"), { recursive: true });
    writeFileSync(path, JSON.stringify({ schema_version: "longhub/client-update-pending/v1", extra: true }), "utf8");
    expect(() => new ClientUpdateRecoveryStore(root).beginStartup("0.5.0")).toThrow("状态损坏");
  });
});
