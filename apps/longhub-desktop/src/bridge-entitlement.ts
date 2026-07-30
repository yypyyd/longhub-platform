import type { BridgeEntitlementVerifier } from "@longhub/core";

/** Core 子进程使用的在线授权复验：每次执行同时检查 entitlement 与精确 Pack 版本状态。 */
export function createEntitlementVerifier(env: NodeJS.ProcessEnv): BridgeEntitlementVerifier {
  return async ({ packId, packVersion }) => {
    const baseUrl = env.LONGHUB_CLOUD_URL;
    const deviceToken = env.LONGHUB_DEVICE_TOKEN;
    if (!baseUrl || !deviceToken) return { active: false, reason: "缺少云端授权复验配置" };
    const headers = { authorization: `Bearer ${deviceToken}` };
    const [entitlementResponse, releaseResponse] = await Promise.all([
      fetch(`${baseUrl}/v1/entitlements`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      }),
      fetch(`${baseUrl}/v1/releases/check`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          desktop_version: env.LONGHUB_DESKTOP_VERSION ?? "0.0.0",
          installed_packs: [{ pack_id: packId, version: packVersion }],
        }),
        signal: AbortSignal.timeout(10_000),
      }),
    ]);
    if (!entitlementResponse.ok || !releaseResponse.ok) {
      return { active: false, reason: "云端授权或版本复验被拒绝" };
    }
    const entitlementBody = await entitlementResponse.json() as {
      entitlements?: Array<{ pack_id?: string; status?: string; expires_at?: string }>;
    };
    const releaseBody = await releaseResponse.json() as {
      packs?: Array<{ pack_id?: string; action?: string }>;
    };
    const entitlement = entitlementBody.entitlements?.find(
      (item) => item.pack_id === packId && item.status === "active" && typeof item.expires_at === "string",
    );
    const release = releaseBody.packs?.find((item) => item.pack_id === packId);
    if (!entitlement) return { active: false, reason: `Pack ${packId} 没有有效 entitlement` };
    if (!release || !["none", "update_available"].includes(release.action ?? "")) {
      return { active: false, reason: `Pack ${packId}@${packVersion} 不再允许执行` };
    }
    return { active: true, expiresAt: entitlement.expires_at };
  };
}
