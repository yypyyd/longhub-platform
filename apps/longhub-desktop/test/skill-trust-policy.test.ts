import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDevelopmentSkillTrustedKeys, loadSkillTrustPolicy } from "../src/skill-trust-policy.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function policy(overrides: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "longhub-skill-trust-"));
  roots.push(root);
  const path = join(root, "skill-trusted-keys.json");
  writeFileSync(path, JSON.stringify({
    schema_version: "longhub/skill-trust/v1",
    status: "pending",
    approved_by: null,
    approved_at: null,
    keys: [],
    ...overrides,
  }));
  return path;
}

describe("Skill 固定信任清单", () => {
  it("pending 可供内部候选禁用安装，正式发布拒绝", () => {
    expect(loadSkillTrustPolicy(policy()).status).toBe("pending");
    expect(() => loadSkillTrustPolicy(policy(), true)).toThrow("审批通过");
  });

  it("只接受审批完整、去重的 Ed25519 公钥", () => {
    const publicKey = generateKeyPairSync("ed25519").publicKey
      .export({ type: "spki", format: "pem" }).toString();
    expect(loadSkillTrustPolicy(policy({
      status: "approved",
      approved_by: "release-security",
      approved_at: "2026-07-31T00:00:00.000Z",
      keys: [{ key_id: "skill-2026", public_key_pem: publicKey }],
    }), true).trustedKeys.size).toBe(1);
    expect(() => loadSkillTrustPolicy(policy({
      keys: [
        { key_id: "duplicate", public_key_pem: publicKey },
        { key_id: "duplicate", public_key_pem: publicKey },
      ],
    }))).toThrow("记录无效");
  });

  it("开发覆盖同样拒绝私钥、未知字段和非 Ed25519 密钥", () => {
    expect(() => loadDevelopmentSkillTrustedKeys(JSON.stringify({ bad: "PRIVATE KEY" }))).toThrow("字段无效");
    expect(() => loadSkillTrustPolicy(policy({ unexpected: true }))).toThrow("格式无效");
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey
      .export({ type: "spki", format: "pem" }).toString();
    expect(() => loadDevelopmentSkillTrustedKeys(JSON.stringify({ rsa }))).toThrow("Ed25519");
  });
});
