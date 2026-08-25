export interface InstalledPackVersion {
  packId: string;
  version: string;
}

export interface PackEligibilitySource {
  eligiblePackIds(packs: readonly InstalledPackVersion[]): Promise<ReadonlySet<string>>;
}

export interface CloudPackEligibilityOptions {
  baseUrl: string;
  deviceToken: string;
  desktopVersion: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Desktop Selector 使用的云端授权快照；网络错误抛出，由协调器保留当前 Selector 状态。 */
export class CloudPackEligibilitySource implements PackEligibilitySource {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: CloudPackEligibilityOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async eligiblePackIds(packs: readonly InstalledPackVersion[]): Promise<ReadonlySet<string>> {
    const baseUrl = this.options.baseUrl.replace(/\/$/, "");
    const headers = { authorization: `Bearer ${this.options.deviceToken}` };
    const [entitlementResponse, releaseResponse] = await Promise.all([
      this.fetchImpl(`${baseUrl}/v1/entitlements`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      }),
      this.fetchImpl(`${baseUrl}/v1/releases/check`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          manager_version: this.options.desktopVersion,
          installed_packs: packs.map((pack) => ({ pack_id: pack.packId, version: pack.version })),
        }),
        signal: AbortSignal.timeout(10_000),
      }),
    ]);
    if (!entitlementResponse.ok || !releaseResponse.ok) {
      throw new Error(`云端授权同步失败 (${entitlementResponse.status}/${releaseResponse.status})`);
    }
    const entitlementBody = (await entitlementResponse.json()) as {
      entitlements?: Array<{ pack_id?: string; status?: string; expires_at?: string }>;
    };
    const releaseBody = (await releaseResponse.json()) as {
      packs?: Array<{ pack_id?: string; action?: string }>;
    };
    if (!Array.isArray(entitlementBody.entitlements) || !Array.isArray(releaseBody.packs)) {
      throw new Error("云端授权同步响应格式无效");
    }
    const now = this.now();
    const activeEntitlements = new Set(
      entitlementBody.entitlements
        .filter((item) => {
          const expiresAt = typeof item.expires_at === "string" ? Date.parse(item.expires_at) : Number.NaN;
          return (
            typeof item.pack_id === "string" &&
            item.status === "active" &&
            Number.isFinite(expiresAt) &&
            expiresAt > now
          );
        })
        .map((item) => item.pack_id as string),
    );
    const allowedReleases = new Set(
      releaseBody.packs
        .filter(
          (item) =>
            typeof item.pack_id === "string" && ["none", "update_available"].includes(item.action ?? ""),
        )
        .map((item) => item.pack_id as string),
    );
    return new Set(
      packs
        .map((pack) => pack.packId)
        .filter((packId) => activeEntitlements.has(packId) && allowedReleases.has(packId)),
    );
  }
}
