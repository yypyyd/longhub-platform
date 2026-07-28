/**
 * Desktop 应用服务：聚合 Core 客户端、套装安装器与权限确认策略，
 * 供 Electron IPC 层调用；本身不依赖 Electron，可独立测试。
 */
import { readFileSync } from "node:fs";
import type { PackFile } from "@longhub/pack-schema";
import type { TaskEvent } from "@longhub/core";
import { CoreClient } from "./core-client.js";
import { CloudPackClient } from "./pack-distribution.js";
import { PackInstaller, type InstallContext, type InstallResult, type InstalledPack } from "./pack-installer.js";
import { permissionsRequiringConfirmation } from "./permission-policy.js";

export interface SubmitTaskParams {
  idempotencyKey: string;
  skillId: string;
  input: unknown;
  grantedPermissions?: readonly string[];
  /** 用户已在确认弹窗中批准需要人工确认的权限 */
  userConfirmed?: boolean;
}

export type SubmitTaskResult =
  | { needsConfirmation: string[] }
  | { taskId: string; status: string };

export class DesktopApp {
  constructor(
    private readonly core: CoreClient,
    private readonly installer: PackInstaller,
    private readonly installCtx: InstallContext,
  ) {}

  start(): void {
    this.core.start();
  }

  stop(): void {
    this.core.stop();
  }

  hello(): Promise<unknown> {
    return this.core.request("core.hello");
  }

  /** 敏感权限未经用户确认时不提交，返回需要确认的权限列表 */
  async submitTask(params: SubmitTaskParams): Promise<SubmitTaskResult> {
    if (!params.userConfirmed) {
      const needsConfirmation = permissionsRequiringConfirmation(
        params.grantedPermissions ?? [],
      );
      if (needsConfirmation.length > 0) return { needsConfirmation };
    }
    return (await this.core.request("task.submit", {
      idempotencyKey: params.idempotencyKey,
      skillId: params.skillId,
      input: params.input,
      grantedPermissions: params.grantedPermissions ?? [],
    })) as { taskId: string; status: string };
  }

  getTask(taskId: string): Promise<unknown> {
    return this.core.request("task.get", { taskId });
  }

  cancelTask(taskId: string): Promise<unknown> {
    return this.core.request("task.cancel", { taskId });
  }

  onTaskEvent(listener: (event: TaskEvent) => void): () => void {
    return this.core.onTaskEvent(listener);
  }

  listPacks(): InstalledPack[] {
    return this.installer.listInstalled();
  }

  installPackFromFile(filePath: string): InstallResult {
    let pack: PackFile;
    try {
      pack = JSON.parse(readFileSync(filePath, "utf-8")) as PackFile;
    } catch (err) {
      return {
        ok: false,
        code: "PACK_FILE_INVALID",
        message: err instanceof Error ? err.message : String(err),
      };
    }
    return this.installer.install(pack, this.installCtx);
  }

  rollbackPack(packId: string): InstallResult {
    return this.installer.rollback(packId);
  }

  /** 从云端下载并安装：获取云端签名公钥并入信任集，下载后走完整验签安装流程 */
  async installPackFromCloud(params: {
    baseUrl: string;
    packId: string;
    version?: string;
    deviceToken: string;
  }): Promise<InstallResult> {
    const client = new CloudPackClient(params.baseUrl);
    let signingKey;
    let downloaded;
    try {
      signingKey = await client.fetchSigningKey();
      downloaded = await client.downloadPack(params.deviceToken, params.packId, params.version);
    } catch (err) {
      return { ok: false, code: "CLOUD_UNREACHABLE", message: err instanceof Error ? err.message : String(err) };
    }
    if (!downloaded.ok) return downloaded;
    const trustedKeys = new Map(this.installCtx.trustedKeys);
    trustedKeys.set(signingKey.keyId, signingKey.publicKeyPem);
    return this.installer.install(downloaded.pack, { ...this.installCtx, trustedKeys });
  }
}
