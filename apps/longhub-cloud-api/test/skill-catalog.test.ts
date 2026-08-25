import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FeaturePolicyEntry } from "@longhub/feature-policy";
import {
  verifySkillPackageSignature,
  type SkillPackage,
} from "@longhub/pack-schema";
import { MemoryStore } from "../src/memory-store.js";
import { createCloudApiServer } from "../src/server.js";
import { activateTestDevice } from "./helpers/activate-device.js";

const adminToken = "skill-catalog-admin";
const openclawVersion = "2026.7.1-2";
/**
 * This file covers the retired SkillPackage/reference implementation. The
 * clean-launch catalog is exercised by cloud-skill-adapter-distribution.test;
 * keep this regression suite opt-in so old publishing cannot look like a
 * current product capability.
 */
const RUN_LEGACY_SURFACE_TESTS = process.env.LONGHUB_RUN_LEGACY_SURFACE_TESTS === "true";

const skillPackage: SkillPackage = {
  schemaVersion: "longhub/skill-package/v1",
  skill: {
    id: "longhub.skill.resume-screen",
    version: "1.0.0",
    type: "tool",
    publisher: { namespace: "longhub", displayName: "龙枢官方" },
    display: {
      name: "简历初筛",
      description: "按岗位条件生成结构化初筛结果",
      category: "招聘",
      examples: ["筛选这份前端工程师简历"],
    },
  },
  compatibility: {
    minManagerVersion: "0.6.0",
    openclawVersion,
    runtimeApiVersion: "1.0",
  },
  binding: { allowedAgentProfileIds: ["longhub.agent.hr"], defaultEnabled: false },
  schemas: { input: "schemas/resume-screen.input.json", output: "schemas/resume-screen.output.json" },
  capabilities: { requiredSkillIds: [], connectorIds: [] },
  permissions: { requested: ["connector:hr-api:read"], confirmationClass: "none" },
  runtime: { kind: "builtin", implementationId: "longhub.worker.resume-screen" },
  limits: {
    maxPackageBytes: 1_048_576,
    maxSteps: 1,
    maxDurationMs: 30_000,
    maxConcurrency: 2,
    maxCostMicros: 0,
  },
  integrity: {
    algorithm: "sha256",
    digest: "0".repeat(64),
    signatureKeyId: "untrusted-upload-value",
    signature: "A".repeat(86) + "==",
  },
};

function policy(enabled = true): FeaturePolicyEntry {
  return {
    feature_id: "skill.catalog",
    enabled,
    scope: "global",
    audience: "user",
    mode: "default",
    risk_level: "low",
    limits: {},
    data_policy: {
      processing_location: "platform_region",
      retention_days: 30,
      export_allowed: false,
      deletion_allowed: false,
    },
    required_entitlements: [],
    required_permissions: [],
    min_manager_version: "0.6.0",
    emergency_disabled: false,
  };
}

describe.skipIf(!RUN_LEGACY_SURFACE_TESTS)("历史 SkillPackage Catalog 兼容闭环（仅显式 LONGHUB_RUN_LEGACY_SURFACE_TESTS=true）", () => {
  let store: MemoryStore;
  let api: ReturnType<typeof createCloudApiServer>;
  let baseUrl: string;
  let deviceId: string;
  let deviceToken: string;

  const adminHeaders = {
    authorization: `Bearer ${adminToken}`,
    "content-type": "application/json",
  };

  beforeAll(async () => {
    store = new MemoryStore();
    api = createCloudApiServer({
      executorUrl: "http://127.0.0.1:1",
      store,
      adminToken,
      legacySurfaceEnabled: true,
    }).listen(0);
    await once(api, "listening");
    baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    const registered = await fetch(baseUrl + "/v1/devices/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        platform: "windows",
        app_version: "0.6.0",
        device_fingerprint: "skill-catalog-device",
      }),
    });
    expect(registered.status).toBe(201);
    const device = await registered.json() as { device_id: string; device_token: string };
    deviceId = device.device_id;
    deviceToken = device.device_token;
    await activateTestDevice(baseUrl, adminToken, deviceToken);
  });

  afterAll(async () => {
    api.close();
    await once(api, "close");
  });

  it("默认拒绝缺失策略，并在关闭策略时继续阻断目录", async () => {
    const missing = await fetch(baseUrl + "/v1/catalog/skills", {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(missing.status).toBe(403);
    expect((await missing.json() as { code: string }).code).toBe("FEATURE_DISABLED");

    await store.upsertFeaturePolicy(policy(false));
    const disabled = await fetch(baseUrl + "/v1/catalog/skills", {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(disabled.status).toBe(403);
  });

  it("发布、兼容过滤、授权分发、签名验证、撤销和审计形成闭环", async () => {
    const publish = (packageValue: unknown) => fetch(baseUrl + "/v1/admin/skills", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ package: packageValue }),
    });
    const created = await publish(skillPackage);
    expect(created.status).toBe(201);
    const release = await created.json() as {
      skill_id: string;
      digest: string;
      signature_key_id: string;
    };
    expect(release).toMatchObject({ skill_id: skillPackage.skill.id });
    expect(release.digest).toMatch(/^[a-f0-9]{64}$/);

    expect((await publish(skillPackage)).status).toBe(409);
    expect((await publish({ ...skillPackage, arbitrary_url: "https://attacker.invalid/run" })).status).toBe(422);

    await store.upsertFeaturePolicy(policy(true));
    const incompatibleCatalog = await fetch(
      baseUrl + "/v1/catalog/skills?openclaw_version=2026.6.0",
      { headers: { authorization: `Bearer ${deviceToken}` } },
    );
    expect(incompatibleCatalog.status).toBe(200);
    expect((await incompatibleCatalog.json() as { skills: unknown[] }).skills).toEqual([]);

    const catalog = await fetch(
      baseUrl + `/v1/catalog/skills?openclaw_version=${encodeURIComponent(openclawVersion)}`,
      { headers: { authorization: `Bearer ${deviceToken}` } },
    );
    const catalogBody = await catalog.json() as { skills: { skill_id: string; entitled: boolean }[] };
    expect(catalog.status).toBe(200);
    expect(catalogBody.skills).toEqual([
      expect.objectContaining({ skill_id: skillPackage.skill.id, entitled: false }),
    ]);

    const detail = await fetch(
      baseUrl + `/v1/catalog/skills/${skillPackage.skill.id}?openclaw_version=${encodeURIComponent(openclawVersion)}`,
      { headers: { authorization: `Bearer ${deviceToken}` } },
    );
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      skill: { skill_id: skillPackage.skill.id, runtime_kind: "builtin", entitled: false },
    });

    const referenceUrl = baseUrl + `/v1/skills/${skillPackage.skill.id}/reference` +
      `?version=${skillPackage.skill.version}&openclaw_version=${encodeURIComponent(openclawVersion)}`;
    const denied = await fetch(referenceUrl, { headers: { authorization: `Bearer ${deviceToken}` } });
    expect(denied.status).toBe(403);
    expect((await denied.json() as { code: string }).code).toBe("NOT_ENTITLED");

    const entitlement = await fetch(baseUrl + "/v1/admin/entitlements", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ device_id: deviceId, pack_id: `skill:${skillPackage.skill.id}` }),
    });
    expect(entitlement.status).toBe(201);

    const incompatibleReference = await fetch(
      referenceUrl.replace(encodeURIComponent(openclawVersion), "2026.6.0"),
      { headers: { authorization: `Bearer ${deviceToken}` } },
    );
    expect(incompatibleReference.status).toBe(426);

    const distributed = await fetch(referenceUrl, { headers: { authorization: `Bearer ${deviceToken}` } });
    expect(distributed.status).toBe(200);
    const artifact = await distributed.json() as {
      package: SkillPackage;
      digest: string;
      signature_key_id: string;
    };
    const keyResponse = await fetch(baseUrl + "/v1/skills/signing-key");
    const key = await keyResponse.json() as { key_id: string; public_key_pem: string };
    expect(keyResponse.status).toBe(200);
    expect(artifact.signature_key_id).toBe(key.key_id);
    expect(artifact.package.integrity.digest).toBe(artifact.digest);
    expect(verifySkillPackageSignature(artifact.package, key.public_key_pem)).toBe(true);

    const revoked = await fetch(
      baseUrl + `/v1/admin/skills/${skillPackage.skill.id}/${skillPackage.skill.version}/revoke`,
      { method: "POST", headers: adminHeaders },
    );
    expect(revoked.status).toBe(202);
    const blocked = await fetch(referenceUrl, { headers: { authorization: `Bearer ${deviceToken}` } });
    expect(blocked.status).toBe(410);

    const actions = (await store.listAudits()).map((audit) => audit.action);
    expect(actions).toContain("skill_release.publish");
    expect(actions).toContain("skill_release.revoke");
  });
});

describe.skipIf(RUN_LEGACY_SURFACE_TESTS)("Clean launch SkillPackage surface boundary", () => {
  let api: ReturnType<typeof createCloudApiServer>;
  let baseUrl: string;

  beforeAll(async () => {
    api = createCloudApiServer({ executorUrl: "http://127.0.0.1:1", adminToken }).listen(0);
    await once(api, "listening");
    baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    api.close();
    await once(api, "close");
  });

  it("rejects retired SkillPackage publishing, reference and signing-key paths", async () => {
    const paths = [
      "/v1/admin/skills",
      "/v1/skills/signing-key",
      "/v1/skills/longhub.skill.resume-screen/reference?version=1.0.0&openclaw_version=2026.7.1-2",
    ];
    for (const path of paths) {
      const response = await fetch(baseUrl + path, {
        method: path === "/v1/admin/skills" ? "POST" : "GET",
        headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        body: path === "/v1/admin/skills" ? JSON.stringify({ package: {} }) : undefined,
      });
      expect(response.status, path).toBe(410);
      expect((await response.json() as { code: string }).code, path).toBe("LEGACY_SURFACE_DISABLED");
    }
  });
});
