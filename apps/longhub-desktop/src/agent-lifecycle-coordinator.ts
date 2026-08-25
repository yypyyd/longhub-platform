import { isDeepStrictEqual } from "node:util";
import { validatePackContent } from "@longhub/pack-schema";
import type { BridgeExecutionPolicy } from "@longhub/core";
import {
  composeOpenClawAgentConfig,
  type AgentConfigComposerOptions,
  type OpenClawAgentEntry,
} from "./agent-config-composer.js";
import { activateInstalledAgentProfiles, materializeAgentWorkspace } from "./agent-runtime-activation.js";
import { AgentRegistry, type AgentRegistrySnapshot } from "./agent-registry.js";
import type { OpenClawGatewayClient } from "./openclaw-gateway-client.js";
import type { PackEligibilitySource } from "./pack-eligibility.js";
import { PackInstaller, type InstallContext } from "./pack-installer.js";
import { buildToolBridgePolicy } from "./tool-bridge-policy.js";

export type PackLifecycleCode =
  | "PACK_NOT_INSTALLED"
  | "PACK_VERIFICATION_FAILED"
  | "PACK_NOT_ENTITLED"
  | "PACK_ENABLE_FAILED"
  | "PACK_DISABLE_FAILED"
  | "CONFIG_ROLLBACK_FAILED";

export class PackLifecycleError extends Error {
  constructor(
    readonly code: PackLifecycleCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "PackLifecycleError";
  }
}

export interface AgentLifecycleCoordinatorOptions {
  installer: PackInstaller;
  registry: AgentRegistry;
  installContext: InstallContext;
  stateDir: string;
  baseConfig: Record<string, unknown>;
  composer: Omit<AgentConfigComposerOptions, "profiles">;
  gateway: OpenClawGatewayClient;
  eligibility: PackEligibilitySource;
  initialBridgePolicy: BridgeExecutionPolicy;
  constrainBridgePolicy?: (policy: BridgeExecutionPolicy) => BridgeExecutionPolicy;
  replaceBridgePolicy: (policy: BridgeExecutionPolicy) => Promise<void>;
  pollIntervalMs?: number;
  onAgentsChanged?: (agents: readonly { id: string; label: string }[]) => void;
  onAgentsRemoved?: (agentIds: readonly string[]) => void;
  onSyncError?: (error: unknown) => void;
}

export interface PackLifecycleResult {
  packId: string;
  enabled: boolean;
  agentIds: readonly string[];
  fallbackAgentId: "main";
}

export type EntitlementSyncResult =
  | { status: "fresh"; revokedPackIds: readonly string[] }
  | { status: "stale"; revokedPackIds: readonly []; error: string };

function agentsFromConfig(config: Record<string, unknown>): unknown[] {
  const agents = config.agents;
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) {
    throw new Error("Gateway 配置缺少 agents");
  }
  const list = (agents as Record<string, unknown>).list;
  if (!Array.isArray(list)) throw new Error("Gateway 配置缺少 agents.list");
  return list;
}

function agentIds(agents: readonly unknown[]): string[] {
  return agents.map((value) => {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      typeof (value as { id?: unknown }).id !== "string"
    ) {
      throw new Error("agents.list 包含无效智能体");
    }
    return (value as { id: string }).id;
  });
}

/**
 * Pack、Registry 与 OpenClaw Selector 的单写者。
 * workspace/session 永不删除；Core 的在线授权复验仍是最终执行边界。
 */
export class AgentLifecycleCoordinator {
  private queue: Promise<void> = Promise.resolve();
  private pollTimer: NodeJS.Timeout | undefined;
  private bridgePolicy: BridgeExecutionPolicy;
  private sourceBridgePolicy: BridgeExecutionPolicy;

  constructor(private readonly options: AgentLifecycleCoordinatorOptions) {
    this.sourceBridgePolicy = options.initialBridgePolicy;
    this.bridgePolicy = options.constrainBridgePolicy?.(options.initialBridgePolicy)
      ?? options.initialBridgePolicy;
  }

  async refreshBridgePolicyConstraint(): Promise<void> {
    const next = this.options.constrainBridgePolicy?.(this.sourceBridgePolicy)
      ?? this.sourceBridgePolicy;
    if (isDeepStrictEqual(next, this.bridgePolicy)) return;
    await this.options.replaceBridgePolicy(next);
    this.bridgePolicy = next;
  }

  enablePack(packId: string, installContext = this.options.installContext): Promise<PackLifecycleResult> {
    return this.exclusive(async () => {
      if (!this.options.installer.activeVersion(packId)) {
        throw new PackLifecycleError("PACK_NOT_INSTALLED", `Pack ${packId} 尚未安装`);
      }
      let active;
      try {
        active = this.options.installer.verifyActivePack(packId, installContext);
      } catch (error) {
        throw new PackLifecycleError("PACK_VERIFICATION_FAILED", `Pack ${packId} 无法安全启用`, error);
      }
      const eligible = await this.options.eligibility.eligiblePackIds([
        { packId, version: active.manifest.pack.version },
      ]);
      if (!eligible.has(packId)) {
        throw new PackLifecycleError("PACK_NOT_ENTITLED", `Pack ${packId} 没有有效授权或版本已停用`);
      }
      try {
        const result = await this.applyMutation(() => {
          const validated = validatePackContent(active.manifest, active.files);
          if (!validated.ok) throw new Error(`Pack ${packId} 内容复验失败`);
          const entry = this.options.registry.register({
            manifest: validated.manifest,
            files: active.files,
            enabled: true,
          });
          materializeAgentWorkspace(
            this.options.stateDir,
            entry.agentId,
            validated.profile,
            active.files,
          );
        });
        return { packId, enabled: true, agentIds: result.currentAgentIds, fallbackAgentId: "main" };
      } catch (error) {
        if (error instanceof PackLifecycleError) throw error;
        throw new PackLifecycleError("PACK_ENABLE_FAILED", `Pack ${packId} 启用失败`, error);
      }
    });
  }

  disablePack(packId: string): Promise<PackLifecycleResult> {
    return this.exclusive(async () => {
      try {
        const result = await this.applyMutation(() => {
          const active = this.options.installer.readActivePack(packId);
          if (!active) throw new PackLifecycleError("PACK_NOT_INSTALLED", `Pack ${packId} 尚未安装`);
          const existing = this.options.registry.list().filter((entry) => entry.packId === packId);
          if (existing.length === 0) {
            this.options.registry.register({ manifest: active.manifest, files: active.files, enabled: false });
          } else {
            this.options.registry.setPackEnabled(packId, false);
          }
        });
        return { packId, enabled: false, agentIds: result.currentAgentIds, fallbackAgentId: "main" };
      } catch (error) {
        if (error instanceof PackLifecycleError) throw error;
        throw new PackLifecycleError("PACK_DISABLE_FAILED", `Pack ${packId} 停用失败`, error);
      }
    });
  }

  syncEntitlements(): Promise<EntitlementSyncResult> {
    return this.exclusive(async () => {
      const installed = this.installedVersions();
      let eligible: ReadonlySet<string>;
      try {
        eligible = await this.options.eligibility.eligiblePackIds(installed);
      } catch (error) {
        this.options.onSyncError?.(error);
        return {
          status: "stale",
          revokedPackIds: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
      const revokedPackIds = [
        ...new Set(
          this.options.registry
            .enabled()
            .map((entry) => entry.packId)
            .filter((packId) => !eligible.has(packId)),
        ),
      ].sort();
      if (revokedPackIds.length === 0) return { status: "fresh", revokedPackIds };
      await this.applyMutation(() => {
        for (const packId of revokedPackIds) this.options.registry.setPackEnabled(packId, false);
      });
      return { status: "fresh", revokedPackIds };
    });
  }

  startEntitlementPolling(): void {
    if (this.pollTimer) return;
    void this.syncEntitlements().catch((error) => this.options.onSyncError?.(error));
    this.pollTimer = setInterval(() => {
      void this.syncEntitlements().catch((error) => this.options.onSyncError?.(error));
    }, this.options.pollIntervalMs ?? 30_000);
    this.pollTimer.unref();
  }

  stopEntitlementPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  private installedVersions(): Array<{ packId: string; version: string }> {
    return this.options.installer
      .listInstalled()
      .filter((pack): pack is { packId: string; activeVersion: string; previousVersion?: string } =>
        typeof pack.activeVersion === "string",
      )
      .map((pack) => ({ packId: pack.packId, version: pack.activeVersion }));
  }

  private async applyMutation(mutate: () => void): Promise<{ currentAgentIds: string[] }> {
    const registrySnapshot = this.options.registry.snapshot();
    const gatewaySnapshot = await this.options.gateway.getConfig();
    const previousAgents = agentsFromConfig(gatewaySnapshot.config);
    const previousAgentIds = agentIds(previousAgents);
    let gatewayWriteAttempted = false;
    let bridgePolicyWriteAttempted = false;
    const previousBridgePolicy = this.bridgePolicy;
    const previousSourceBridgePolicy = this.sourceBridgePolicy;
    try {
      mutate();
      const profiles = activateInstalledAgentProfiles({
        installer: this.options.installer,
        registry: this.options.registry,
        stateDir: this.options.stateDir,
      });
      const candidate = composeOpenClawAgentConfig(this.options.baseConfig, {
        ...this.options.composer,
        profiles,
      });
      const nextAgents = agentsFromConfig(candidate) as OpenClawAgentEntry[];
      const expectedIds = agentIds(nextAgents);
      const nextSourceBridgePolicy = buildToolBridgePolicy(profiles);
      const nextBridgePolicy = this.options.constrainBridgePolicy?.(nextSourceBridgePolicy)
        ?? nextSourceBridgePolicy;
      // 撤销/停用先关闭 Core 执行边界，再从可见 Selector 移除。
      bridgePolicyWriteAttempted = true;
      await this.options.replaceBridgePolicy(nextBridgePolicy);
      gatewayWriteAttempted = true;
      await this.options.gateway.replaceAgents(nextAgents, gatewaySnapshot.hash);
      const confirmed = await this.options.gateway.listAgents();
      const confirmedIds = confirmed.agents.map((agent) => agent.id);
      if (confirmed.defaultId !== "main" || !isDeepStrictEqual(confirmedIds, expectedIds)) {
        throw new Error(
          `agents.list 回读不一致: expected=${expectedIds.join(",")} actual=${confirmedIds.join(",")}`,
        );
      }
      const removed = previousAgentIds.filter((id) => id !== "main" && !expectedIds.includes(id));
      this.bridgePolicy = nextBridgePolicy;
      this.sourceBridgePolicy = nextSourceBridgePolicy;
      this.options.onAgentsChanged?.(nextAgents.map((agent) => ({
        id: agent.id,
        label: agent.identity.name || agent.name,
      })));
      if (removed.length > 0) this.options.onAgentsRemoved?.(removed);
      return { currentAgentIds: expectedIds };
    } catch (error) {
      try {
        if (gatewayWriteAttempted) await this.rollbackGatewayAgents(previousAgents);
        if (bridgePolicyWriteAttempted) await this.options.replaceBridgePolicy(previousBridgePolicy);
        this.sourceBridgePolicy = previousSourceBridgePolicy;
        this.restoreRegistry(registrySnapshot);
      } catch (rollbackError) {
        throw new PackLifecycleError(
          "CONFIG_ROLLBACK_FAILED",
          `OpenClaw 配置回滚失败: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          { operationError: error, rollbackError },
        );
      }
      throw error;
    }
  }

  private async rollbackGatewayAgents(previousAgents: readonly unknown[]): Promise<void> {
    const current = await this.options.gateway.getConfig();
    const currentAgents = agentsFromConfig(current.config);
    if (isDeepStrictEqual(currentAgents, previousAgents)) return;
    await this.options.gateway.replaceAgents(previousAgents, current.hash);
    const confirmed = await this.options.gateway.listAgents();
    const previousIds = agentIds(previousAgents);
    if (confirmed.defaultId !== "main" || !isDeepStrictEqual(confirmed.agents.map((agent) => agent.id), previousIds)) {
      throw new Error("回滚后的 agents.list 回读不一致");
    }
  }

  private restoreRegistry(snapshot: AgentRegistrySnapshot): void {
    if (isDeepStrictEqual(this.options.registry.list(), snapshot.entries)) return;
    this.options.registry.restore(snapshot);
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
