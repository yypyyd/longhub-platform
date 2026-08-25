import type { SkillRegistry } from "./skill-registry.js";
import type { SkillLifecycleCoordinator } from "./skill-lifecycle-coordinator.js";
import type { SkillCatalogClient, SkillCatalogItem } from "./skill-catalog-client.js";

export interface SkillCenterAgent {
  readonly profileId: string;
  readonly agentId: string;
  readonly name: string;
}

export interface SkillCenterItem {
  readonly skillId: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly publisher: string;
  readonly latestVersion: string;
  readonly installedVersion?: string;
  readonly runtimeKind: SkillCatalogItem["runtimeKind"];
  readonly actionLabel: "启用" | "安装" | "安装引用";
  readonly executionLabel: "本机内置能力" | "本机声明式内容" | "龙枢云端执行";
  readonly requestedPermissions: readonly string[];
  readonly confirmationClass: "none" | "per_execution";
  readonly maxCostMicros?: number;
  readonly entitled: boolean;
  readonly bindings: readonly { agentId: string; enabled: boolean }[];
}

export interface SkillCenterSnapshot {
  readonly schema_version: "longhub/skill-center/v1";
  readonly agents: readonly SkillCenterAgent[];
  readonly skills: readonly SkillCenterItem[];
}

export type SkillCenterAction = "install" | "enable" | "disable" | "upgrade" | "rollback" | "uninstall";

export class SkillCenterService {
  constructor(private readonly options: {
    readonly catalog: Pick<SkillCatalogClient, "list" | "reference">;
    readonly registry: SkillRegistry;
    readonly lifecycle: SkillLifecycleCoordinator;
    readonly agents: () => readonly SkillCenterAgent[];
  }) {}

  async read(): Promise<SkillCenterSnapshot> {
    const catalog = await this.options.catalog.list();
    const entries = new Map(this.options.registry.listSkills().map((entry) => [entry.skillId, entry]));
    const bindings = this.options.registry.listBindings();
    return {
      schema_version: "longhub/skill-center/v1",
      agents: this.options.agents().map((agent) => ({ ...agent })),
      skills: catalog.map((item) => {
        const entry = entries.get(item.skillId);
        const manifest = entry?.versions.find((version) => version.manifest.skill.version === entry.activeVersion)?.manifest;
        return {
          skillId: item.skillId,
          name: item.display.name,
          description: item.display.description,
          category: item.display.category,
          publisher: item.publisher.displayName,
          latestVersion: item.latestVersion,
          ...(entry ? { installedVersion: entry.activeVersion } : {}),
          runtimeKind: item.runtimeKind,
          actionLabel: item.runtimeKind === "builtin" ? "启用" : item.runtimeKind === "cloudRef" ? "安装引用" : "安装",
          executionLabel: item.runtimeKind === "builtin"
            ? "本机内置能力"
            : item.runtimeKind === "cloudRef" ? "龙枢云端执行" : "本机声明式内容",
          requestedPermissions: [...item.permissions.requested],
          confirmationClass: item.permissions.confirmationClass,
          maxCostMicros: manifest?.limits.maxCostMicros ?? item.limits.maxCostMicros,
          entitled: item.entitled,
          bindings: bindings.filter((binding) => binding.skillId === item.skillId)
            .map((binding) => ({ agentId: binding.agentId, enabled: binding.enabled })),
        };
      }),
    };
  }

  async perform(params: {
    readonly action: SkillCenterAction;
    readonly skillId: string;
    readonly agentId?: string;
  }): Promise<SkillCenterSnapshot> {
    const catalog = await this.options.catalog.list();
    const item = catalog.find((candidate) => candidate.skillId === params.skillId);
    if (!item) throw new Error("Skill 不在当前可见目录");
    const agent = params.agentId
      ? this.options.agents().find((candidate) => candidate.agentId === params.agentId)
      : undefined;
    if (["install", "enable", "disable"].includes(params.action) && !agent) {
      throw new Error("目标 Agent 不存在或未明确选择");
    }
    switch (params.action) {
      case "install": {
        if (!item.entitled) throw new Error("Skill 尚未授权");
        const reference = await this.options.catalog.reference(item.skillId, item.latestVersion);
        await this.options.lifecycle.install({ package: reference, profileId: agent!.profileId, agentId: agent!.agentId, enabled: true });
        break;
      }
      case "enable":
        await this.options.lifecycle.setEnabled(item.skillId, agent!.agentId, true);
        break;
      case "disable":
        await this.options.lifecycle.setEnabled(item.skillId, agent!.agentId, false);
        break;
      case "upgrade": {
        if (!item.entitled) throw new Error("Skill 尚未授权");
        await this.options.lifecycle.upgrade(await this.options.catalog.reference(item.skillId, item.latestVersion));
        break;
      }
      case "rollback":
        await this.options.lifecycle.rollback(item.skillId);
        break;
      case "uninstall":
        await this.options.lifecycle.uninstall(item.skillId);
        break;
    }
    return this.read();
  }
}
