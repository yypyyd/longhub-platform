import { describe, expect, it } from "vitest";
import { HR_PACK_ID } from "@longhub/hr-suite";
import { discoverInstallableAgentPacks } from "../src/agent-pack-catalog.js";
import type { CloudPackClient } from "../src/pack-distribution.js";

const NOW = Date.parse("2026-07-29T00:00:00.000Z");

function cloudClient(options: {
  catalog?: Array<{
    pack_id: string;
    name: string;
    latest_version: string;
    min_desktop_version: string;
  }>;
  entitlements?: Array<{ pack_id: string; status: string; expires_at: string }>;
}): CloudPackClient {
  return {
    async listCatalog() {
      return options.catalog ?? [];
    },
    async listEntitlements() {
      return options.entitlements ?? [];
    },
  } as unknown as CloudPackClient;
}

describe("可安装 Agent 目录", () => {
  it("只把客户端认识且当前授权的 HR Pack 映射为稳定 Agent", async () => {
    const result = await discoverInstallableAgentPacks({
      client: cloudClient({
        catalog: [
          { pack_id: HR_PACK_ID, name: "云端文案不能决定身份", latest_version: "1.2.3", min_desktop_version: "0.3.6" },
          { pack_id: "third-party.unknown", name: "未知 Agent", latest_version: "9.9.9", min_desktop_version: "0.1.0" },
        ],
        entitlements: [
          { pack_id: HR_PACK_ID, status: "active", expires_at: "2026-08-29T00:00:00.000Z" },
          { pack_id: "third-party.unknown", status: "active", expires_at: "2026-08-29T00:00:00.000Z" },
        ],
      }),
      deviceToken: "device-token",
      installedPackIds: new Set(),
      now: NOW,
    });

    expect(result).toEqual([expect.objectContaining({
      packId: HR_PACK_ID,
      version: "1.2.3",
      label: "HR 助理",
      state: "ready",
    })]);
    expect(result[0]?.agentId).toMatch(/^longhub-agent-hr-/);
  });

  it("过滤已安装、过期、已撤销和无效到期时间的授权", async () => {
    const baseCatalog = [{
      pack_id: HR_PACK_ID,
      name: "HR",
      latest_version: "1.0.0",
      min_desktop_version: "0.3.6",
    }];
    for (const entitlement of [
      { pack_id: HR_PACK_ID, status: "revoked", expires_at: "2026-08-29T00:00:00.000Z" },
      { pack_id: HR_PACK_ID, status: "active", expires_at: "2026-07-28T23:59:59.000Z" },
      { pack_id: HR_PACK_ID, status: "active", expires_at: "invalid" },
    ]) {
      await expect(discoverInstallableAgentPacks({
        client: cloudClient({ catalog: baseCatalog, entitlements: [entitlement] }),
        deviceToken: "device-token",
        installedPackIds: new Set(),
        now: NOW,
      })).resolves.toEqual([]);
    }

    await expect(discoverInstallableAgentPacks({
      client: cloudClient({
        catalog: baseCatalog,
        entitlements: [{ pack_id: HR_PACK_ID, status: "active", expires_at: "2026-08-29T00:00:00.000Z" }],
      }),
      deviceToken: "device-token",
      installedPackIds: new Set([HR_PACK_ID]),
      now: NOW,
    })).resolves.toEqual([]);
  });
});
