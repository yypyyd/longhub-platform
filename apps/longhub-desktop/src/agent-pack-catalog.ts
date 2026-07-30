import { HR_AGENT_ID, HR_PACK_ID } from "@longhub/hr-suite";
import { agentIdForProfile } from "./agent-registry.js";
import { CloudPackClient } from "./pack-distribution.js";

export type AgentPackInstallState = "ready" | "installing" | "error";

export interface InstallableAgentPack {
  packId: string;
  version: string;
  agentId: string;
  label: string;
  state: AgentPackInstallState;
  error?: string;
}

const KNOWN_AGENT_PACKS: Readonly<Record<string, { profileId: string; label: string }>> = {
  [HR_PACK_ID]: { profileId: HR_AGENT_ID, label: "HR 助理" },
};

/**
 * 只把客户端锁定版本认识的 Pack 映射为可安装 Agent。目录文案不能自行声明 profileId/agentId；
 * 真正安装时仍以下载制品内的签名 Manifest 与 Agent Profile 为准。
 */
export async function discoverInstallableAgentPacks(options: {
  client: CloudPackClient;
  deviceToken: string;
  installedPackIds: ReadonlySet<string>;
  now?: number;
}): Promise<InstallableAgentPack[]> {
  const [catalog, entitlements] = await Promise.all([
    options.client.listCatalog(options.deviceToken),
    options.client.listEntitlements(options.deviceToken),
  ]);
  const now = options.now ?? Date.now();
  const entitled = new Set(
    entitlements
      .filter((item) => {
        const expiresAt = Date.parse(item.expires_at);
        return item.status === "active" && Number.isFinite(expiresAt) && expiresAt > now;
      })
      .map((item) => item.pack_id),
  );
  return catalog
    .filter((pack) => entitled.has(pack.pack_id) && !options.installedPackIds.has(pack.pack_id))
    .flatMap((pack) => {
      const known = KNOWN_AGENT_PACKS[pack.pack_id];
      if (!known) return [];
      return [{
        packId: pack.pack_id,
        version: pack.latest_version,
        agentId: agentIdForProfile(known.profileId),
        label: known.label,
        state: "ready" as const,
      }];
    })
    .sort((left, right) => left.agentId.localeCompare(right.agentId, "en"));
}

