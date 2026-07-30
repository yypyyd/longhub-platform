import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadClientUpdateTrustPolicy } from "../src/client-update.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function writePolicy(value: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "longhub-update-policy-"));
  roots.push(root);
  const path = join(root, "policy.json");
  writeFileSync(path, JSON.stringify(value), "utf8");
  return path;
}

function publicPem(type: "ed25519" | "rsa" = "ed25519"): string {
  const pair = type === "ed25519"
    ? generateKeyPairSync("ed25519")
    : generateKeyPairSync("rsa", { modulusLength: 2048 });
  return pair.publicKey.export({ type: "spki", format: "pem" }).toString();
}

function policy(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "longhub/client-update-trust/v1",
    status: "pending",
    channel: "stable",
    expected_signer_subject: null,
    approved_by: null,
    approved_at: null,
    keys: [],
    ...overrides,
  };
}

describe("客户端更新预置信任清单", () => {
  it("内部候选允许 pending，但正式模式拒绝", () => {
    expect(loadClientUpdateTrustPolicy(writePolicy(policy()))).toMatchObject({ status: "pending" });
    expect(() => loadClientUpdateTrustPolicy(writePolicy(policy()), true)).toThrow("正式发布");
  });

  it("接受字段完整的 approved Ed25519 清单", () => {
    const path = writePolicy(policy({
      status: "approved",
      expected_signer_subject: "CN=LongHub Technology",
      approved_by: "release-security",
      approved_at: "2026-07-29T00:00:00.000Z",
      keys: [{ key_id: "update-2026", public_key_pem: publicPem() }],
    }));
    expect(loadClientUpdateTrustPolicy(path, true).trustedKeys.size).toBe(1);
  });

  it("拒绝缺字段、未知字段、重复 ID、RSA 和私钥", () => {
    expect(() => loadClientUpdateTrustPolicy(writePolicy(policy({ status: "approved" })))).toThrow("字段不完整");
    expect(() => loadClientUpdateTrustPolicy(writePolicy({ ...policy(), extra: true }))).toThrow("格式无效");
    const ed = publicPem();
    expect(() => loadClientUpdateTrustPolicy(writePolicy(policy({ keys: [
      { key_id: "same", public_key_pem: ed }, { key_id: "same", public_key_pem: ed },
    ] })))).toThrow("字段无效");
    expect(() => loadClientUpdateTrustPolicy(writePolicy(policy({ keys: [
      { key_id: "rsa", public_key_pem: publicPem("rsa") },
    ] })))).toThrow("Ed25519");
    const privatePem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => loadClientUpdateTrustPolicy(writePolicy(policy({ keys: [
      { key_id: "private", public_key_pem: privatePem },
    ] })))).toThrow("字段无效");
  });
});
