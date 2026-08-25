import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CLOUD_SKILL_ADAPTER_SCHEMA,
  computeCloudSkillAdapterFileDigest,
  computeCloudSkillAdapterDigest,
  createCloudSkillAdapterFile,
  containsCloudSkillAdapterPrivateFields,
  findCloudSkillAdapterPrivateField,
  isPublicCloudSkillAdapterManifest,
  signCloudSkillAdapterManifest,
  toPublicCloudSkillAdapterManifest,
  validateCloudSkillAdapterManifest,
  verifyCloudSkillAdapterSignature,
  verifyCloudSkillAdapterFileDigests,
  verifyCloudSkillAdapterWithTrustedKeys,
  type CloudSkillAdapterManifest,
} from "../src/index.js";

const baseManifest: CloudSkillAdapterManifest = {
  schema_version: CLOUD_SKILL_ADAPTER_SCHEMA,
  skill_id: "longhub.skill.resume-screen",
  version: "1.0.0",
  display: {
    name: "简历初筛",
    description: "根据已授权的简历输入返回结构化筛选结果",
    category: "hr",
  },
  service: {
    service_id: "longhub.cloud.resume-screen",
    api_version: "1.0",
    entry: "local-longhub-bridge",
  },
  schemas: {
    input: "schemas/input.json",
    output: "schemas/output.json",
  },
  files: [
    { path: "SKILL.md", sha256: "1".repeat(64), size: 24 },
    { path: "schemas/input.json", sha256: "2".repeat(64), size: 16 },
    { path: "schemas/output.json", sha256: "3".repeat(64), size: 17 },
  ],
  subscription: { plan_ids: ["longhub-pro"] },
  permissions: {
    requested: ["candidate.read"],
    confirmation_class: "none",
  },
  compatibility: {
    manager_min_version: "0.1.0",
    openclaw_version: "2026.7.1-2",
  },
  integrity: {
    algorithm: "sha256",
    digest: "a".repeat(64),
    signature_key_id: "longhub-skill-2026-01",
    signature: "Y".repeat(86) + "==",
  },
};

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

describe("Cloud Skill Adapter V1 manifest", () => {
  it("accepts the contract example shape and rejects unknown/private fields", () => {
    expect(validateCloudSkillAdapterManifest(baseManifest).ok).toBe(true);
    for (const candidate of [
      { ...baseManifest, endpoint: "https://evil.invalid" },
      { ...baseManifest, implementation: "prompt-and-code" },
      { ...baseManifest, service: { ...baseManifest.service, url: "https://evil.invalid" } },
      { ...baseManifest, schemas: { ...baseManifest.schemas, input: "https://evil.invalid/input.json" } },
      { ...baseManifest, compatibility: { ...baseManifest.compatibility, model: "secret-model" } },
    ]) {
      expect(validateCloudSkillAdapterManifest(candidate).ok).toBe(false);
    }
  });

  it("enforces safe IDs, paths, versions, unique plans and confirmation", () => {
    expect(validateCloudSkillAdapterManifest({
      ...baseManifest,
      skill_id: "longhub.skill.resume_screen",
    }).ok).toBe(false);
    expect(validateCloudSkillAdapterManifest({
      ...baseManifest,
      schemas: { input: "../input.json", output: "schemas/output.json" },
    }).ok).toBe(false);
    expect(validateCloudSkillAdapterManifest({
      ...baseManifest,
      subscription: { plan_ids: ["longhub-pro", "longhub-pro"] },
    }).ok).toBe(false);
    expect(validateCloudSkillAdapterManifest({
      ...baseManifest,
      permissions: { requested: ["candidate.write"], confirmation_class: "none" },
    }).ok).toBe(false);
    expect(validateCloudSkillAdapterManifest({
      ...baseManifest,
      permissions: { requested: ["candidate.write"], confirmation_class: "per_execution" },
    }).ok).toBe(true);
  });

  it("computes a stable canonical digest independent of object key order", () => {
    const digest = computeCloudSkillAdapterDigest(baseManifest);
    const reordered = {
      integrity: { ...baseManifest.integrity, signature: "Z".repeat(86) + "==", digest: "f".repeat(64) },
      compatibility: baseManifest.compatibility,
      permissions: baseManifest.permissions,
      subscription: baseManifest.subscription,
      schemas: baseManifest.schemas,
      files: baseManifest.files,
      service: baseManifest.service,
      display: baseManifest.display,
      version: baseManifest.version,
      skill_id: baseManifest.skill_id,
      schema_version: baseManifest.schema_version,
    } satisfies CloudSkillAdapterManifest;
    expect(computeCloudSkillAdapterDigest(reordered)).toBe(digest);
    expect(computeCloudSkillAdapterDigest({
      ...baseManifest,
      integrity: { ...baseManifest.integrity, digest: "f".repeat(64), signature: "Z".repeat(86) + "==" },
    })).toBe(digest);
  });

  it("signs and verifies Ed25519 signatures, including trusted key lookup", () => {
    const keys = keyPair();
    const signed = signCloudSkillAdapterManifest(baseManifest, keys.privateKey);
    expect(signed.integrity.digest).toBe(computeCloudSkillAdapterDigest(signed));
    expect(verifyCloudSkillAdapterSignature(signed, keys.publicKey)).toBe(true);
    expect(verifyCloudSkillAdapterWithTrustedKeys(
      signed,
      new Map([[signed.integrity.signature_key_id, keys.publicKey]]),
    )).toBe(true);
    expect(verifyCloudSkillAdapterWithTrustedKeys(signed, new Map([["other", keys.publicKey]]))).toBe(false);
    expect(verifyCloudSkillAdapterSignature({
      ...signed,
      display: { ...signed.display, name: "篡改" },
    }, keys.publicKey)).toBe(false);
  });

  it("matches the Go canonical/Ed25519 interoperability vector", () => {
    const privateKey = createPrivateKey({
      key: Buffer.concat([
        Buffer.from("302e020100300506032b657004220420", "hex"),
        Buffer.alloc(32),
      ]),
      format: "der",
      type: "pkcs8",
    });
    const files = [
      createFile("SKILL.md", "---\nname: resume-screen\ndescription: Test\n---\n"),
      createFile("schemas/input.json", "{}"),
      createFile("schemas/output.json", "{}"),
    ];
    const signed = signCloudSkillAdapterManifest({
      ...baseManifest,
      files,
      integrity: {
        ...baseManifest.integrity,
        digest: "0".repeat(64),
        signature_key_id: "test-key",
        signature: "A".repeat(86) + "==",
      },
      display: { name: "Resume", description: "Test", category: "hr" },
    }, privateKey);
    expect(signed.integrity.digest).toBe("885a973c04a1125d012129b0aa5a7a90cc02fa0eddf62f45bcadbfa48ebda879");
    expect(signed.integrity.signature).toBe("YlC23JjvC8KpYVD/4XRygcpjSNNtANzg4qcJCjGRiVuRZ+fukEIpmBPF9vX9/+5EpeYDHUe6VyykiiODTtu0DA==");
  });

  it("keeps private implementation fields out of the public boundary", () => {
    const privatePayload = { ...baseManifest, system_prompt: "do not ship", service: {
      ...baseManifest.service,
      executor_url: "https://executor.internal",
    } };
    expect(containsCloudSkillAdapterPrivateFields(privatePayload)).toBe(true);
    expect(findCloudSkillAdapterPrivateField({ system_prompt: "do not ship" })).toBe("system_prompt");
    expect(findCloudSkillAdapterPrivateField({ executorUrl: "https://executor.internal" })).toBe("executorUrl");
    expect(findCloudSkillAdapterPrivateField(privatePayload)).toBe("service.executor_url");
    expect(() => toPublicCloudSkillAdapterManifest(privatePayload)).toThrow("PRIVATE_FIELD");
    expect(isPublicCloudSkillAdapterManifest(baseManifest)).toBe(true);
    expect(isPublicCloudSkillAdapterManifest(privatePayload)).toBe(false);
  });

  it("binds exactly the native pure-content files and verifies bytes", () => {
    const skill = "---\nname: resume-screen\n---\n";
    const input = "{\"type\":\"object\"}";
    const output = "{\"type\":\"object\" }";
    const files = [
      createCloudSkillAdapterFile("SKILL.md", skill),
      createCloudSkillAdapterFile("schemas/input.json", input),
      createCloudSkillAdapterFile("schemas/output.json", output),
    ] as const;
    const manifest = { ...baseManifest, files } satisfies CloudSkillAdapterManifest;
    expect(validateCloudSkillAdapterManifest(manifest).ok).toBe(true);
    expect(computeCloudSkillAdapterFileDigest(skill)).toBe(files[0].sha256);
    expect(verifyCloudSkillAdapterFileDigests(manifest, {
      "SKILL.md": skill,
      "schemas/input.json": input,
      "schemas/output.json": output,
    })).toBe(true);
    expect(verifyCloudSkillAdapterFileDigests(manifest, {
      "SKILL.md": `${skill}tampered`,
      "schemas/input.json": input,
      "schemas/output.json": output,
    })).toBe(false);
  });

  it("rejects unsorted, missing, executable, oversized, and unbound files", () => {
    const cases = [
      { files: [...baseManifest.files].reverse() },
      { files: baseManifest.files.slice(0, 2) },
      { files: baseManifest.files.map((file, index) => index === 2 ? { ...file, path: "scripts/run.js" } : file) },
      { files: baseManifest.files.map((file, index) => index === 1 ? { ...file, size: 4 * 1024 * 1024 + 1 } : file) },
      { files: baseManifest.files.map((file, index) => index === 1 ? { ...file, path: "schemas/other.json" } : file) },
    ];
    for (const candidate of cases) {
      expect(validateCloudSkillAdapterManifest({ ...baseManifest, ...candidate }).ok).toBe(false);
    }
  });
});

function createFile(path: string, content: string) {
  return {
    path,
    sha256: computeCloudSkillAdapterFileDigest(content),
    size: Buffer.byteLength(content, "utf8"),
  };
}
