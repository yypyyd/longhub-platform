/**
 * Desktop 应用服务：聚合 Core 客户端、套装安装器与权限确认策略，
 * 供 Electron IPC 层调用；本身不依赖 Electron，可独立测试。
 */
import { readFileSync } from "node:fs";
import type { PackFile } from "@longhub/pack-schema";
import type { TaskEvent } from "@longhub/core";
import { CoreClient } from "./core-client.js";
import type { AgentLifecycleCoordinator } from "./agent-lifecycle-coordinator.js";
import { CloudPackClient, type SigningKeyInfo } from "./pack-distribution.js";
import { PackInstaller, type InstallContext, type InstallResult, type InstalledPack } from "./pack-installer.js";

export interface SubmitTaskParams {
  idempotencyKey: string;
  skillId: string;
  input: unknown;
  /** 只能降低 Core 默认预算，不能授予权限或抬高预算上限。 */
  budget?: { maxTokens: number; maxCostCents: number; maxDurationMs: number };
}

export type SubmitTaskResult = { taskId: string; status: string };

export interface DesktopAppOptions {
  persistTrustedKey?: (key: SigningKeyInfo) => void | Promise<void>;
}

export type AgentPackProvisionResult =
  | { ok: true; packId: string; version: string; agentIds: readonly string[] }
  | { ok: false; code: string; message: string };

export class DesktopApp {
  constructor(
    private readonly core: CoreClient,
    private readonly installer: PackInstaller,
    private readonly installCtx: InstallContext,
    private readonly lifecycle?: AgentLifecycleCoordinator,
    private readonly options: DesktopAppOptions = {},
  ) {}

  start(): void {
    this.core.start();
    this.lifecycle?.startEntitlementPolling();
  }

  stop(): void {
    this.lifecycle?.stopEntitlementPolling();
    this.core.stop();
  }

  hello(): Promise<unknown> {
    return this.core.request("core.hello");
  }

  /** 历史无权限任务入口；企业技能必须使用带可信 Agent 上下文的 Bridge。 */
  async submitTask(params: SubmitTaskParams): Promise<SubmitTaskResult> {
    return (await this.core.request("task.submit", {
      idempotencyKey: params.idempotencyKey,
      skillId: params.skillId,
      input: params.input,
      ...(params.budget ? { budget: params.budget } : {}),
    })) as { taskId: string; status: string };
  }

  respondConfirmation(params: { confirmationId: string; approved: boolean }): Promise<unknown> {
    return this.core.request("confirm.respond", params);
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

  enablePack(packId: string): Promise<unknown> {
    if (!this.lifecycle) return Promise.reject(new Error("Pack 运行时生命周期尚未就绪"));
    return this.lifecycle.enablePack(packId);
  }

  disablePack(packId: string): Promise<unknown> {
    if (!this.lifecycle) return Promise.reject(new Error("Pack 运行时生命周期尚未就绪"));
    return this.lifecycle.disablePack(packId);
  }

  /** 从云端下载并安装：获取云端签名公钥并入信任集，下载后走完整验签安装流程 */
  async installPackFromCloud(params: {
    baseUrl: string;
    packId: string;
    version?: string;
    deviceToken: string;
  }): Promise<InstallResult> {
    const prepared = await this.prepareCloudPack(params);
    if (!prepared.ok) return prepared;
    const installed = this.installer.install(prepared.pack, {
      ...this.installCtx,
      trustedKeys: prepared.trustedKeys,
    });
    if (installed.ok) await this.options.persistTrustedKey?.(prepared.signingKey);
    return installed;
  }

  /** 下载、验签、持久化信任并激活；供原生 Selector 的窄权限安装入口使用。 */
  async provisionAgentPackFromCloud(params: {
    baseUrl: string;
    packId: string;
    version?: string;
    deviceToken: string;
  }): Promise<AgentPackProvisionResult> {
    if (!this.lifecycle) {
      return { ok: false, code: "PACK_LIFECYCLE_UNAVAILABLE", message: "Pack 运行时生命周期尚未就绪" };
    }
    const prepared = await this.prepareCloudPack(params);
    if (!prepared.ok) return prepared;
    const installed = this.installer.install(prepared.pack, {
      ...this.installCtx,
      trustedKeys: prepared.trustedKeys,
    });
    if (!installed.ok) return installed;
    try {
      await this.options.persistTrustedKey?.(prepared.signingKey);
    } catch (error) {
      this.restoreProvisionPointer(installed);
      return {
        ok: false,
        code: "TRUST_STORE_WRITE_FAILED",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      const activated = await this.lifecycle.enablePack(params.packId, {
        ...this.installCtx,
        trustedKeys: prepared.trustedKeys,
      });
      return {
        ok: true,
        packId: installed.packId,
        version: installed.version,
        agentIds: activated.agentIds,
      };
    } catch (error) {
      this.restoreProvisionPointer(installed);
      return {
        ok: false,
        code: "PACK_ACTIVATION_FAILED",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async prepareCloudPack(params: {
    baseUrl: string;
    packId: string;
    version?: string;
    deviceToken: string;
  }): Promise<
    | {
        ok: true;
        pack: PackFile;
        signingKey: SigningKeyInfo;
        trustedKeys: ReadonlyMap<string, string>;
      }
    | { ok: false; code: string; message: string }
  > {
    const client = new CloudPackClient(params.baseUrl);
    let signingKey;
    let downloaded;
    try {
      [signingKey, downloaded] = await Promise.all([
        client.fetchSigningKey(),
        client.downloadPack(params.deviceToken, params.packId, params.version),
      ]);
    } catch (err) {
      return { ok: false, code: "CLOUD_UNREACHABLE", message: err instanceof Error ? err.message : String(err) };
    }
    if (!downloaded.ok) return downloaded;
    if (
      downloaded.digest !== downloaded.pack.manifest.integrity.digest ||
      downloaded.signatureKeyId !== downloaded.pack.manifest.integrity.signatureKeyId ||
      signingKey.keyId !== downloaded.signatureKeyId
    ) {
      return { ok: false, code: "CLOUD_ARTIFACT_METADATA_INVALID", message: "云端制品元数据与签名身份不一致" };
    }
    const trustedKeys = new Map(this.installCtx.trustedKeys);
    trustedKeys.set(signingKey.keyId, signingKey.publicKeyPem);
    return { ok: true, pack: downloaded.pack, signingKey, trustedKeys };
  }

  private restoreProvisionPointer(installed: Extract<InstallResult, { ok: true }>): void {
    if (installed.previousVersion) {
      const rolledBack = this.installer.rollback(installed.packId);
      if (!rolledBack.ok) throw new Error(`Pack 激活失败且旧版本恢复失败: ${rolledBack.message}`);
      return;
    }
    this.installer.clearActiveVersion(installed.packId, installed.version);
  }
}
