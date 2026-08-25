import { describe, expect, it } from "vitest";
import {
  FEATURE_POLICY_MAX_BYTES,
  FeaturePolicyUnavailableError,
  FeaturePolicyValidationError,
  compareSemver,
  decideFeatureAccess,
  parseFeaturePolicyDocument,
  parseFeaturePolicyJson,
  resolveFeaturePolicy,
  type FeaturePolicyDocument,
  type FeaturePolicyEntry,
} from "../src/index.js";

const now = new Date("2026-07-30T12:01:00.000Z");

const globalEntry: FeaturePolicyEntry = {
  feature_id: "skill.catalog",
  enabled: true,
  scope: "global",
  audience: "user",
  mode: "default",
  risk_level: "low",
  limits: { count: 20, bytes: 10_000 },
  data_policy: {
    processing_location: "platform_region",
    retention_days: 90,
    export_allowed: true,
    deletion_allowed: true,
  },
  required_entitlements: ["plan:standard"],
  required_permissions: ["skill:catalog:read"],
  min_manager_version: "0.5.0",
  emergency_disabled: false,
};

function documentWith(features: readonly FeaturePolicyEntry[]): FeaturePolicyDocument {
  return {
    schema_version: "longhub/feature-policy/v2",
    policy_version: "policy-42",
    issued_at: "2026-07-30T12:00:00.000Z",
    expires_at: "2026-07-30T12:05:00.000Z",
    features,
  };
}

const context = {
  manager_version: "0.5.0",
  audience: "user" as const,
  scope_ids: {
    tenant: "tenant-a",
    plan: "standard",
    device: "device-a",
    agent: "longhub.agent.hr",
  },
  now,
};

describe("Feature Policy V2 严格契约", () => {
  it("解析并重建合法文档", () => {
    const parsed = parseFeaturePolicyDocument(documentWith([globalEntry]));
    expect(parsed).toEqual(documentWith([globalEntry]));
    expect(parsed.features[0]).not.toBe(globalEntry);
  });

  it("拒绝顶层、策略和 limits 未知字段", () => {
    expect(() =>
      parseFeaturePolicyDocument({ ...documentWith([]), unexpected: true }),
    ).toThrow(FeaturePolicyValidationError);
    expect(() =>
      parseFeaturePolicyDocument(documentWith([{ ...globalEntry, unexpected: true } as FeaturePolicyEntry])),
    ).toThrow(FeaturePolicyValidationError);
    expect(() =>
      parseFeaturePolicyDocument(
        documentWith([{ ...globalEntry, limits: { count: 1, arbitrary: 2 } as never }]),
      ),
    ).toThrow(FeaturePolicyValidationError);
  });

  it("clean launch 只接受 Manager 版本字段，不提供 Desktop 别名", () => {
    const { min_manager_version: _minManagerVersion, ...withoutManagerVersion } = globalEntry;
    expect(() =>
      parseFeaturePolicyDocument(documentWith([{
        ...withoutManagerVersion,
        min_desktop_version: "0.5.0",
      } as unknown as FeaturePolicyEntry])),
    ).toThrow(FeaturePolicyValidationError);

    expect(() =>
      parseFeaturePolicyDocument(documentWith([{
        ...globalEntry,
        max_desktop_version: "1.0.0",
      } as unknown as FeaturePolicyEntry])),
    ).toThrow(FeaturePolicyValidationError);
  });

  it("要求非全局 scope_id 且禁止全局 scope_id", () => {
    expect(() =>
      parseFeaturePolicyDocument(
        documentWith([{ ...globalEntry, scope: "tenant" } as FeaturePolicyEntry]),
      ),
    ).toThrow(/scope_id/);
    expect(() =>
      parseFeaturePolicyDocument(
        documentWith([{ ...globalEntry, scope_id: "unexpected" }]),
      ),
    ).toThrow(/scope_id/);
  });

  it("允许同一功能的不同 Agent 目标，拒绝相同目标重复", () => {
    const first = { ...globalEntry, scope: "agent" as const, scope_id: "agent-a" };
    const second = { ...globalEntry, scope: "agent" as const, scope_id: "agent-b" };
    expect(parseFeaturePolicyDocument(documentWith([first, second])).features).toHaveLength(2);
    expect(() => parseFeaturePolicyDocument(documentWith([first, { ...first }]))).toThrow(/重复/);
  });

  it("拒绝过长 TTL、宽松时间、非法版本和重复要求", () => {
    expect(() =>
      parseFeaturePolicyDocument({
        ...documentWith([]),
        expires_at: "2026-07-30T12:06:00.000Z",
      }),
    ).toThrow(/有效期/);
    expect(() =>
      parseFeaturePolicyDocument({ ...documentWith([]), issued_at: "2026-07-30 12:00:00Z" }),
    ).toThrow(/规范化/);
    expect(() =>
      parseFeaturePolicyDocument(
        documentWith([{ ...globalEntry, min_manager_version: "0.5" }]),
      ),
    ).toThrow(/语义版本/);
    expect(() =>
      parseFeaturePolicyDocument(
        documentWith([{ ...globalEntry, required_permissions: ["skill:a:read", "skill:a:read"] }]),
      ),
    ).toThrow(/重复/);
  });

  it("按 UTF-8 字节限制响应并拒绝坏 JSON", () => {
    expect(() => parseFeaturePolicyJson("{")).toThrow(/JSON/);
    expect(() => parseFeaturePolicyJson("中".repeat(FEATURE_POLICY_MAX_BYTES))).toThrow(/字节/);
  });
});

describe("Feature Policy V2 合并和执行判定", () => {
  const tenantEntry: FeaturePolicyEntry = {
    ...globalEntry,
    scope: "tenant",
    scope_id: "tenant-a",
    mode: "admin_approved",
    risk_level: "high",
    limits: { count: 5, duration_ms: 2_000 },
    data_policy: {
      processing_location: "device_local",
      retention_days: 30,
      export_allowed: false,
      deletion_allowed: true,
    },
    required_entitlements: ["tenant:skills"],
    required_permissions: ["skill:catalog:install"],
  };

  it("deny-wins、限制取最小、风险取最高且数据策略只收紧", () => {
    const policy = resolveFeaturePolicy(documentWith([globalEntry, tenantEntry]), "skill.catalog", context);
    expect(policy).toMatchObject({
      enabled: true,
      emergency_disabled: false,
      mode: "admin_approved",
      risk_level: "high",
      limits: { count: 5, bytes: 10_000, duration_ms: 2_000 },
      data_policy: {
        processing_location: "device_local",
        retention_days: 30,
        export_allowed: false,
        deletion_allowed: true,
      },
    });

    const disabled = resolveFeaturePolicy(
      documentWith([globalEntry, { ...tenantEntry, enabled: false }]),
      "skill.catalog",
      context,
    );
    expect(disabled?.enabled).toBe(false);
  });

  it("必要 entitlement 和 permission 跨层取并集，不会被交集消掉", () => {
    const policy = resolveFeaturePolicy(documentWith([globalEntry, tenantEntry]), "skill.catalog", context);
    expect(policy?.required_entitlements).toEqual(["plan:standard", "tenant:skills"]);
    expect(policy?.required_permissions).toEqual([
      "skill:catalog:install",
      "skill:catalog:read",
    ]);

    expect(
      decideFeatureAccess(policy, {
        entitlements: ["plan:standard"],
        permissions: ["skill:catalog:read"],
      }),
    ).toEqual({
      allowed: false,
      reason: "MISSING_ENTITLEMENT",
      missing: ["tenant:skills"],
    });
    expect(
      decideFeatureAccess(policy, {
        entitlements: ["plan:standard", "tenant:skills"],
        permissions: ["skill:catalog:read", "skill:catalog:install"],
      }),
    ).toEqual({ allowed: true });
  });

  it("紧急关闭优先于 enabled 并给出稳定拒绝原因", () => {
    const policy = resolveFeaturePolicy(
      documentWith([{ ...globalEntry, emergency_disabled: true }]),
      "skill.catalog",
      context,
    );
    expect(policy?.enabled).toBe(false);
    expect(
      decideFeatureAccess(policy, {
        entitlements: ["plan:standard"],
        permissions: ["skill:catalog:read"],
      }),
    ).toEqual({ allowed: false, reason: "EMERGENCY_DISABLED" });
  });

  it("只合并可信上下文匹配的 audience、scope 和版本", () => {
    const otherTenant = { ...tenantEntry, scope_id: "tenant-b", enabled: false };
    const future = { ...globalEntry, min_manager_version: "0.6.0", enabled: false };
    const admin = { ...globalEntry, audience: "tenant_admin" as const, enabled: false };
    const policy = resolveFeaturePolicy(
      documentWith([globalEntry, otherTenant, future, admin]),
      "skill.catalog",
      context,
    );
    expect(policy?.enabled).toBe(true);
    expect(policy?.applied_scopes).toEqual(["global"]);
  });

  it("同一设备可以同时匹配多个有效套餐 scope", () => {
    const standard = {
      ...tenantEntry,
      scope: "plan" as const,
      scope_id: "standard",
      required_entitlements: ["plan:standard"],
    };
    const addon = {
      ...tenantEntry,
      scope: "plan" as const,
      scope_id: "knowledge-addon",
      required_entitlements: ["plan:knowledge-addon"],
    };
    const policy = resolveFeaturePolicy(
      documentWith([globalEntry, standard, addon]),
      "skill.catalog",
      {
        ...context,
        scope_ids: { ...context.scope_ids, plan: ["standard", "knowledge-addon"] },
      },
    );
    expect(policy?.applied_scopes).toEqual([
      "global",
      "plan:standard",
      "plan:knowledge-addon",
    ]);
  });

  it("缺失策略安全拒绝，过期或未生效文档不可用于授权", () => {
    const document = documentWith([globalEntry]);
    expect(resolveFeaturePolicy(document, "file.input", context)).toBeUndefined();
    expect(decideFeatureAccess(undefined, { entitlements: [], permissions: [] })).toEqual({
      allowed: false,
      reason: "POLICY_NOT_FOUND",
    });
    expect(() =>
      resolveFeaturePolicy(document, "skill.catalog", {
        ...context,
        now: new Date(document.expires_at),
      }),
    ).toThrow(FeaturePolicyUnavailableError);
    expect(() =>
      resolveFeaturePolicy(document, "skill.catalog", {
        ...context,
        now: new Date("2026-07-30T11:59:59.000Z"),
      }),
    ).toThrow(/尚未生效/);
  });

  it("按 SemVer 处理正式版和预发布版本", () => {
    expect(compareSemver("0.5.0", "0.5.0-rc.1")).toBe(1);
    expect(compareSemver("0.5.0-rc.2", "0.5.0-rc.10")).toBe(-1);
    expect(compareSemver("1.0.0", "0.99.99")).toBe(1);
  });
});
