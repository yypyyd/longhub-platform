import { isDeepStrictEqual } from "node:util";
import type { SkillPackage } from "@longhub/pack-schema";
import { SkillRegistry, type SkillRegistrySnapshot } from "./skill-registry.js";
import {
  resolveSkillRuntimePlan,
  type SkillRuntimePlan,
} from "./skill-runtime-policy.js";

export interface CoreSkillGrant {
  readonly agentId: string;
  readonly profileId: string;
  readonly skillId: string;
  readonly version: string;
  readonly digest: string;
  readonly runtime: SkillRuntimePlan;
  readonly permissions: readonly string[];
  readonly maxCostMicros: number;
}

export interface GatewaySkillView {
  readonly agentId: string;
  readonly skillId: string;
  readonly name: string;
  readonly version: string;
  readonly runtimeKind: SkillRuntimePlan["kind"];
}

export interface SkillLifecycleCoordinatorOptions {
  readonly registry: SkillRegistry;
  readonly cloudServiceIds?: ReadonlySet<string>;
  readonly verifyPackage: (manifest: SkillPackage) => Promise<void>;
  readonly verifyEntitlement: (skillId: string, version: string) => Promise<boolean>;
  readonly readCorePolicy: () => Promise<readonly CoreSkillGrant[]>;
  readonly replaceCorePolicy: (policy: readonly CoreSkillGrant[]) => Promise<void>;
  readonly readGatewaySkills: () => Promise<readonly GatewaySkillView[]>;
  readonly replaceGatewaySkills: (skills: readonly GatewaySkillView[]) => Promise<void>;
}

export type SkillLifecycleCode =
  | "SKILL_NOT_ENTITLED"
  | "SKILL_TRANSACTION_FAILED"
  | "SKILL_TRANSACTION_ROLLBACK_FAILED";

export class SkillLifecycleError extends Error {
  constructor(
    readonly code: SkillLifecycleCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SkillLifecycleError";
  }
}

export class SkillLifecycleCoordinator {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: SkillLifecycleCoordinatorOptions) {}

  install(params: {
    readonly package: unknown;
    readonly profileId: string;
    readonly agentId: string;
    readonly enabled?: boolean;
  }): Promise<void> {
    return this.exclusive(async () => {
      const resolved = resolveSkillRuntimePlan(params.package, { cloudServiceIds: this.options.cloudServiceIds });
      await this.verifyInstallInput(resolved.manifest);
      await this.transact(() => {
        this.options.registry.install(resolved.manifest, true);
        this.options.registry.bind({
          skillId: resolved.manifest.skill.id,
          profileId: params.profileId,
          agentId: params.agentId,
          enabled: params.enabled ?? resolved.manifest.binding.defaultEnabled,
        });
      });
    });
  }

  setEnabled(skillId: string, agentId: string, enabled: boolean): Promise<void> {
    return this.exclusive(async () => {
      if (enabled) {
        const manifest = this.mustActiveManifest(skillId);
        await this.verifyInstallInput(manifest);
      }
      await this.transact(() => this.options.registry.setBindingEnabled(skillId, agentId, enabled));
    });
  }

  upgrade(packageInput: unknown): Promise<void> {
    return this.exclusive(async () => {
      const resolved = resolveSkillRuntimePlan(packageInput, { cloudServiceIds: this.options.cloudServiceIds });
      await this.verifyInstallInput(resolved.manifest);
      await this.transact(() => this.options.registry.install(resolved.manifest, true));
    });
  }

  rollback(skillId: string): Promise<void> {
    return this.exclusive(async () => {
      const entry = this.options.registry.findSkill(skillId);
      const target = entry?.versions.find((version) => version.manifest.skill.version === entry.previousVersion)?.manifest;
      if (!target) throw new Error("Skill 没有可回滚版本");
      await this.verifyInstallInput(target);
      await this.transact(() => this.options.registry.rollback(skillId));
    });
  }

  uninstall(skillId: string): Promise<void> {
    return this.exclusive(() => this.transact(() => this.options.registry.remove(skillId)));
  }

  /** Cloud 撤销事件进入后，下一次新执行必须在 Gateway UI 隐藏前先从 Core policy 移除。 */
  revoke(skillId: string): Promise<void> {
    return this.exclusive(() => this.transact(() => this.options.registry.markRevoked(skillId)));
  }

  private async verifyInstallInput(manifest: SkillPackage): Promise<void> {
    await this.options.verifyPackage(manifest);
    if (!(await this.options.verifyEntitlement(manifest.skill.id, manifest.skill.version))) {
      throw new SkillLifecycleError("SKILL_NOT_ENTITLED", "Skill entitlement 无效或版本已撤销");
    }
  }

  private mustActiveManifest(skillId: string): SkillPackage {
    const manifest = this.options.registry.activeManifest(skillId);
    if (!manifest) throw new Error("Skill 未安装");
    return manifest;
  }

  private desiredState(): { core: readonly CoreSkillGrant[]; gateway: readonly GatewaySkillView[] } {
    const entries = new Map(this.options.registry.listSkills().map((entry) => [entry.skillId, entry]));
    const core: CoreSkillGrant[] = [];
    const gateway: GatewaySkillView[] = [];
    for (const binding of this.options.registry.listBindings()) {
      const entry = entries.get(binding.skillId);
      const manifest = entry?.versions.find((version) => version.manifest.skill.version === entry.activeVersion)?.manifest;
      if (!entry || !manifest || entry.status !== "installed" || !binding.enabled) continue;
      const runtime = resolveSkillRuntimePlan(manifest, { cloudServiceIds: this.options.cloudServiceIds }).plan;
      core.push({
        agentId: binding.agentId,
        profileId: binding.profileId,
        skillId: binding.skillId,
        version: manifest.skill.version,
        digest: manifest.integrity.digest,
        runtime,
        permissions: [...manifest.permissions.requested],
        maxCostMicros: manifest.limits.maxCostMicros,
      });
      gateway.push({
        agentId: binding.agentId,
        skillId: binding.skillId,
        name: manifest.skill.display.name,
        version: manifest.skill.version,
        runtimeKind: runtime.kind,
      });
    }
    const key = (item: { agentId: string; skillId: string }) => `${item.agentId}\0${item.skillId}`;
    return {
      core: core.sort((left, right) => key(left).localeCompare(key(right), "en")),
      gateway: gateway.sort((left, right) => key(left).localeCompare(key(right), "en")),
    };
  }

  private async transact(mutate: () => void): Promise<void> {
    const registrySnapshot = this.options.registry.snapshot();
    const previousCore = await this.options.readCorePolicy();
    const previousGateway = await this.options.readGatewaySkills();
    let coreAttempted = false;
    let gatewayAttempted = false;
    try {
      mutate();
      const desired = this.desiredState();
      if (!isDeepStrictEqual(previousCore, desired.core)) {
        coreAttempted = true;
        await this.options.replaceCorePolicy(desired.core);
      }
      if (!isDeepStrictEqual(previousGateway, desired.gateway)) {
        gatewayAttempted = true;
        await this.options.replaceGatewaySkills(desired.gateway);
      }
    } catch (error) {
      try {
        if (gatewayAttempted) await this.options.replaceGatewaySkills(previousGateway);
        if (coreAttempted) await this.options.replaceCorePolicy(previousCore);
        this.restoreRegistry(registrySnapshot);
      } catch (rollbackError) {
        throw new SkillLifecycleError(
          "SKILL_TRANSACTION_ROLLBACK_FAILED",
          "Skill Core/Gateway/Registry 补偿回滚失败",
          { operationError: error, rollbackError },
        );
      }
      if (error instanceof SkillLifecycleError) throw error;
      throw new SkillLifecycleError("SKILL_TRANSACTION_FAILED", "Skill 生命周期事务失败", error);
    }
  }

  private restoreRegistry(snapshot: SkillRegistrySnapshot): void {
    const current = this.options.registry.snapshot();
    if (!isDeepStrictEqual(current.skills, snapshot.skills) || !isDeepStrictEqual(current.bindings, snapshot.bindings)) {
      this.options.registry.restore(snapshot);
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}
