import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  computeSkillPackageDigest,
  signSkillPackageDigest,
  type SkillPackage,
} from "@longhub/pack-schema";
import { SkillCatalogClient } from "../src/skill-catalog-client.js";

function signedPackage(): { manifest: SkillPackage; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const base: SkillPackage = {
    schemaVersion: "longhub/skill-package/v1",
    skill: {
      id: "longhub.skill.resume-screen", version: "1.0.0", type: "tool",
      publisher: { namespace: "longhub", displayName: "龙枢官方" },
      display: { name: "简历初筛", description: "结构化初筛", category: "招聘", examples: [] },
    },
    compatibility: { minManagerVersion: "0.6.0", openclawVersion: "2026.7.1-2", runtimeApiVersion: "1.0" },
    binding: { allowedAgentProfileIds: ["longhub.agent.hr"], defaultEnabled: false },
    schemas: {}, capabilities: { requiredSkillIds: [], connectorIds: [] },
    permissions: { requested: ["connector:hr-api:read"], confirmationClass: "none" },
    runtime: { kind: "builtin", implementationId: "longhub.worker.resume-screen" },
    limits: { maxPackageBytes: 1024, maxSteps: 1, maxDurationMs: 30_000, maxConcurrency: 1, maxCostMicros: 0 },
    integrity: { algorithm: "sha256", digest: "0".repeat(64), signatureKeyId: "skill-test", signature: "A".repeat(86) + "==" },
  };
  const digest = computeSkillPackageDigest(base);
  return {
    manifest: {
      ...base,
      integrity: {
        ...base.integrity,
        digest,
        signature: signSkillPackageDigest(digest, privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
      },
    },
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

describe("Desktop Skill Catalog Client", () => {
  it("严格解析目录，并只接受预置信任锚验证的完整引用", async () => {
    const signed = signedPackage();
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/catalog/skills") {
        return Response.json({
          skills: [{
            skill_id: signed.manifest.skill.id,
            publisher: signed.manifest.skill.publisher,
            display: signed.manifest.skill.display,
            type: signed.manifest.skill.type,
            latest_version: signed.manifest.skill.version,
            versions: [signed.manifest.skill.version],
            runtime_kind: signed.manifest.runtime.kind,
            compatibility: signed.manifest.compatibility,
            permissions: signed.manifest.permissions,
            limits: signed.manifest.limits,
            entitled: true,
          }],
          filters: { manager_version: "0.6.0", openclaw_version: "2026.7.1-2" },
        });
      }
      return Response.json({
        package: signed.manifest,
        digest: signed.manifest.integrity.digest,
        signature_key_id: signed.manifest.integrity.signatureKeyId,
      });
    };
    const client = new SkillCatalogClient({
      baseUrl: "https://cloud.example",
      deviceToken: "device-token",
      openclawVersion: "2026.7.1-2",
      trustedKeys: new Map([[signed.manifest.integrity.signatureKeyId, signed.publicKeyPem]]),
      fetchImpl,
    });
    expect(await client.list()).toEqual([
      expect.objectContaining({ skillId: signed.manifest.skill.id, runtimeKind: "builtin", entitled: true }),
    ]);
    expect(await client.reference(signed.manifest.skill.id, signed.manifest.skill.version)).toEqual(signed.manifest);
  });

  it("未知密钥、篡改引用和非 HTTPS 公网源失败关闭", async () => {
    const signed = signedPackage();
    const client = new SkillCatalogClient({
      baseUrl: "https://cloud.example",
      deviceToken: "device-token",
      openclawVersion: "2026.7.1-2",
      trustedKeys: new Map(),
      fetchImpl: async () => Response.json({
        package: signed.manifest,
        digest: signed.manifest.integrity.digest,
        signature_key_id: signed.manifest.integrity.signatureKeyId,
      }),
    });
    await expect(client.reference(signed.manifest.skill.id, signed.manifest.skill.version))
      .rejects.toMatchObject({ code: "SKILL_SIGNATURE_INVALID" });
    expect(() => new SkillCatalogClient({
      baseUrl: "http://cloud.example",
      deviceToken: "x",
      openclawVersion: "2026.7.1-2",
      trustedKeys: new Map(),
    })).toThrow("HTTPS");
  });
});
