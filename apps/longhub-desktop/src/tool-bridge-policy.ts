import type { BridgeExecutionPolicy, CoreBudget } from "@longhub/core";
import { LONGHUB_BRIDGE_SKILL_PERMISSIONS } from "@longhub/openclaw-bridge";
import type { EnabledAgentProfile } from "./agent-config-composer.js";

export interface ToolBridgePolicyLimits {
  tenantPermissions?: readonly string[];
  devicePermissions?: readonly string[];
  budget?: CoreBudget;
}

const DEFAULT_BRIDGE_BUDGET: CoreBudget = {
  maxTokens: 100_000,
  maxCostCents: 100,
  maxDurationMs: 60_000,
};

const PRODUCT_PERMISSION_CEILING = [
  ...new Set(Object.values(LONGHUB_BRIDGE_SKILL_PERMISSIONS).flat()),
].sort((left, right) => left.localeCompare(right, "en"));

/** 从已验签且已激活的 Profile/Pack 原始声明生成 Core 策略；最终交集只能由 Core 计算。 */
export function buildToolBridgePolicy(
  profiles: readonly EnabledAgentProfile[],
  limits: ToolBridgePolicyLimits = {},
): BridgeExecutionPolicy {
  const policy: Record<string, BridgeExecutionPolicy[string][number][]> = {};
  for (const source of profiles) {
    const profilePermissions = new Map<string, Set<string>>();
    const packPermissions = new Map<string, Set<string>>();
    for (const capability of source.profile.capabilities) {
      for (const skillId of capability.skillIds) {
        const permissions = profilePermissions.get(skillId) ?? new Set<string>();
        for (const permission of capability.permissions) permissions.add(permission);
        profilePermissions.set(skillId, permissions);

        const packCapability = source.manifest.capabilities.find((item) => item.id === capability.id);
        const fromPack = packPermissions.get(skillId) ?? new Set<string>();
        for (const permission of packCapability?.permissions ?? []) fromPack.add(permission);
        packPermissions.set(skillId, fromPack);
      }
    }
    policy[source.registry.agentId] = Object.entries(LONGHUB_BRIDGE_SKILL_PERMISSIONS)
      .filter(([skillId]) => profilePermissions.has(skillId))
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([skillId, required]) => ({
        skillId,
        packId: source.manifest.pack.id,
        packVersion: source.manifest.pack.version,
        profileVersion: source.profile.version,
        requiredPermissions: [...required].sort(),
        profilePermissions: [...(profilePermissions.get(skillId) ?? [])].sort(),
        packPermissions: [...(packPermissions.get(skillId) ?? [])].sort(),
        tenantPermissions: [...(limits.tenantPermissions ?? PRODUCT_PERMISSION_CEILING)].sort(),
        devicePermissions: [...(limits.devicePermissions ?? PRODUCT_PERMISSION_CEILING)].sort(),
        budget: { ...(limits.budget ?? DEFAULT_BRIDGE_BUDGET) },
      }));
  }
  return policy;
}
