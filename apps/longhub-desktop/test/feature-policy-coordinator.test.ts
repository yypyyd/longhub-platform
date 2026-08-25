import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FeaturePolicyDocument, FeaturePolicyEntry } from "@longhub/feature-policy";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FeaturePolicyCoordinator,
  FeaturePolicyCoordinatorError,
} from "../src/feature-policy-coordinator.js";

const NOW = Date.parse("2026-07-30T12:02:00.000Z");
const ETAG = 'W/"abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"';

const baseEntry: FeaturePolicyEntry = {
  feature_id: "skill.catalog",
  enabled: true,
  scope: "global",
  audience: "user",
  mode: "default",
  risk_level: "low",
  limits: {},
  data_policy: {
    processing_location: "platform_region",
    retention_days: 0,
    export_allowed: false,
    deletion_allowed: true,
  },
  required_entitlements: [],
  required_permissions: [],
  min_manager_version: "0.0.0",
  emergency_disabled: false,
};

function document(
  features: readonly FeaturePolicyEntry[] = [baseEntry],
  version = "fp-test-1",
): FeaturePolicyDocument {
  return {
    schema_version: "longhub/feature-policy/v2",
    policy_version: version,
    issued_at: "2026-07-30T12:00:00.000Z",
    expires_at: "2026-07-30T12:05:00.000Z",
    features,
  };
}

function jsonResponse(body: unknown = document(), status = 200, etag = ETAG): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", etag },
  });
}

const temporaryDirectories: string[] = [];

function temporaryCache(): { root: string; cacheFile: string } {
  const root = mkdtempSync(join(tmpdir(), "longhub-feature-policy-"));
  temporaryDirectories.push(root);
  return { root, cacheFile: join(root, "feature-policy-cache.json") };
}

function coordinator(
  cacheFile: string,
  fetchImpl: typeof fetch,
  overrides: Partial<ConstructorParameters<typeof FeaturePolicyCoordinator>[0]> = {},
): FeaturePolicyCoordinator {
  return new FeaturePolicyCoordinator({
    cloudBaseUrl: "https://cloud.example",
    deviceId: "device-a",
    deviceToken: "dt-super-secret",
    desktopVersion: "0.5.0",
    cacheFile,
    fetchImpl,
    now: () => NOW,
    ...overrides,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
});

describe("Manager Feature Policy 协调器", () => {
  it("网络策略原子落盘且不缓存设备 Token", async () => {
    const { root, cacheFile } = temporaryCache();
    const target = coordinator(cacheFile, vi.fn(async () => jsonResponse()) as typeof fetch);

    await expect(target.refresh()).resolves.toMatchObject({
      source: "network",
      document: { policy_version: "fp-test-1" },
    });
    const saved = readFileSync(cacheFile, "utf8");
    expect(saved).toContain("longhub/feature-policy-cache/v1");
    expect(saved).toContain("device-a");
    expect(saved).not.toContain("dt-super-secret");
    expect(saved).not.toMatch(/authorization|bearer/i);
    expect(readFileSync(cacheFile).byteLength).toBeGreaterThan(0);
    expect(root).toBeTruthy();
  });

  it("发送 ETag，304 网络确认后继续使用同源同设备策略", async () => {
    const { cacheFile } = temporaryCache();
    await coordinator(cacheFile, vi.fn(async () => jsonResponse()) as typeof fetch).refresh();
    const conditional = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        "if-none-match": ETAG,
        "x-longhub-manager-version": "0.5.0",
      });
      return new Response(null, { status: 304, headers: { etag: ETAG } });
    });
    const snapshot = await coordinator(cacheFile, conditional as typeof fetch).refresh();
    expect(snapshot.source).toBe("network");
    expect(snapshot.document.policy_version).toBe("fp-test-1");
  });

  it("拒绝跨设备和跨 Cloud origin 的缓存", async () => {
    const { cacheFile } = temporaryCache();
    await coordinator(cacheFile, vi.fn(async () => jsonResponse()) as typeof fetch).refresh();
    const offline = vi.fn(async () => {
      throw new Error("offline");
    }) as typeof fetch;

    await expect(coordinator(cacheFile, offline, { deviceId: "device-b" }).refresh())
      .rejects.toMatchObject({ reason: "network" });
    await expect(coordinator(cacheFile, offline, { cloudBaseUrl: "https://other.example" }).refresh())
      .rejects.toMatchObject({ reason: "network" });
  });

  it("拒绝过期缓存", async () => {
    const { cacheFile } = temporaryCache();
    await coordinator(cacheFile, vi.fn(async () => jsonResponse()) as typeof fetch).refresh();
    const offline = vi.fn(async () => {
      throw new Error("offline");
    }) as typeof fetch;
    await expect(coordinator(cacheFile, offline, {
      now: () => Date.parse("2026-07-30T12:05:00.000Z"),
    }).refresh()).rejects.toMatchObject({ reason: "network" });
  });

  it.each([401, 403])("状态 %s 立即失效且绝不回退缓存", async (status) => {
    const { cacheFile } = temporaryCache();
    await coordinator(cacheFile, vi.fn(async () => jsonResponse()) as typeof fetch).refresh();
    const target = coordinator(
      cacheFile,
      vi.fn(async () => new Response(null, { status })) as typeof fetch,
    );

    await expect(target.refresh()).rejects.toMatchObject({ reason: "auth" });
    expect(target.current()).toBeUndefined();
    expect(target.decide("skill.catalog")).toEqual({
      allowed: false,
      reason: "POLICY_UNAVAILABLE",
    });
  });

  it("瞬时故障允许低风险功能使用未过期缓存", async () => {
    const { cacheFile } = temporaryCache();
    await coordinator(cacheFile, vi.fn(async () => jsonResponse()) as typeof fetch).refresh();
    const target = coordinator(
      cacheFile,
      vi.fn(async () => new Response(null, { status: 503 })) as typeof fetch,
    );

    await expect(target.refresh()).resolves.toMatchObject({ source: "cache" });
    expect(target.decide("skill.catalog")).toMatchObject({ allowed: true, source: "cache" });
  });

  it("离线缓存固定拒绝高风险功能", async () => {
    const { cacheFile } = temporaryCache();
    const highRisk = { ...baseEntry, risk_level: "high" as const };
    await coordinator(
      cacheFile,
      vi.fn(async () => jsonResponse(document([highRisk]))) as typeof fetch,
    ).refresh();
    const target = coordinator(cacheFile, vi.fn(async () => {
      throw new Error("offline");
    }) as typeof fetch);

    await target.refresh();
    expect(target.decide("skill.catalog")).toMatchObject({
      allowed: false,
      reason: "POLICY_OFFLINE",
      source: "cache",
    });
  });

  it("紧急停用刷新立即拒绝并只回调新增 feature", async () => {
    const { cacheFile } = temporaryCache();
    const onEmergencyDisabled = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse())
      .mockResolvedValueOnce(jsonResponse(document([
        { ...baseEntry, emergency_disabled: true },
      ], "fp-test-2")));
    const target = coordinator(cacheFile, fetchMock as typeof fetch, { onEmergencyDisabled });

    await target.refresh();
    await target.refresh();
    expect(onEmergencyDisabled).toHaveBeenCalledWith(["skill.catalog"]);
    expect(target.decide("skill.catalog")).toMatchObject({
      allowed: false,
      reason: "EMERGENCY_DISABLED",
    });
  });

  it("拒绝未知字段和超出 64 KiB 的响应", async () => {
    const first = temporaryCache();
    await expect(coordinator(
      first.cacheFile,
      vi.fn(async () => jsonResponse({ ...document(), unexpected: true })) as typeof fetch,
    ).refresh()).rejects.toBeInstanceOf(FeaturePolicyCoordinatorError);

    const second = temporaryCache();
    const oversized = JSON.stringify({ value: "中".repeat(70_000) });
    await expect(coordinator(
      second.cacheFile,
      vi.fn(async () => new Response(oversized, {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
    ).refresh()).rejects.toMatchObject({ reason: "protocol" });
  });

  it("不把符号链接当作可用缓存", async () => {
    const { root, cacheFile } = temporaryCache();
    const outside = join(root, "outside.json");
    writeFileSync(outside, JSON.stringify({ secret: true }));
    symlinkSync(outside, cacheFile, "file");
    const target = coordinator(cacheFile, vi.fn(async () => {
      throw new Error("offline");
    }) as typeof fetch);

    await expect(target.refresh()).rejects.toMatchObject({ reason: "network" });
  });

  it("同时校验 entitlement 和 permission", async () => {
    const { cacheFile } = temporaryCache();
    const guarded = {
      ...baseEntry,
      required_entitlements: ["plan:pro"],
      required_permissions: ["skill:catalog:read"],
    };
    const target = coordinator(
      cacheFile,
      vi.fn(async () => jsonResponse(document([guarded]))) as typeof fetch,
    );
    await target.refresh();
    expect(target.decide("skill.catalog", {
      entitlements: [],
      permissions: ["skill:catalog:read"],
    })).toMatchObject({ allowed: false, reason: "MISSING_ENTITLEMENT" });
    expect(target.decide("skill.catalog", {
      entitlements: ["plan:pro"],
      permissions: [],
    })).toMatchObject({ allowed: false, reason: "MISSING_PERMISSION" });
    expect(target.decide("skill.catalog", {
      entitlements: ["plan:pro"],
      permissions: ["skill:catalog:read"],
    })).toMatchObject({ allowed: true });
  });

  it("合并并发刷新，不产生重叠网络请求", async () => {
    const { cacheFile } = temporaryCache();
    let resolveResponse: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    }));
    const target = coordinator(cacheFile, fetchMock as typeof fetch);

    const first = target.refresh();
    const second = target.refresh();
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveResponse!(jsonResponse());
    await expect(first).resolves.toMatchObject({ source: "network" });
  });
});
