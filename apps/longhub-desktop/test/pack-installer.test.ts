import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  computePackDigest,
  signPackDigest,
  type PackFile,
  type PackManifest,
} from "@longhub/pack-schema";
import { PackInstaller } from "../src/pack-installer.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const KEY_ID = "longhub-release-2026-01";
const trustedKeys = new Map([[KEY_ID, publicPem]]);

const installRoot = mkdtempSync(join(tmpdir(), "longhub-packs-"));
afterAll(() => rmSync(installRoot, { recursive: true, force: true }));

function withAgentProfile(files: Record<string, string>, minManagerVersion = "1.0.0"): Record<string, string> {
  const profile = {
    schemaVersion: "longhub/agent-profile/v1",
    id: "longhub.agent.hr",
    version: "1.0.0",
    display: { name: "HR 助理", starterPrompts: [] },
    workspace: { identity: "workspace/IDENTITY.md" },
    capabilities: [
      { id: "longhub.capability.recruitment", skillIds: ["longhub.skill.hr"], permissions: [] },
    ],
    openclaw: { skills: [], tools: { allow: [], deny: [] }, sandbox: "strict" },
    memory: { mode: "isolated" },
    lifecycle: { defaultSessionTitle: "HR 新会话", entitlementExpiryPolicy: "readonly" },
    compatibility: {
      minManagerVersion,
      openclawVersion: "2026.7.1-2",
      profileMigrationVersion: 1,
    },
  };
  return {
    "agent-profile.json": JSON.stringify(profile),
    "workspace/IDENTITY.md": "# HR 助理",
    ...files,
  };
}

function buildPack(
  version: string,
  inputFiles: Record<string, string>,
  options: { minManagerVersion?: string; signingKeyId?: string } = {},
): PackFile {
  const minManagerVersion = options.minManagerVersion ?? "1.0.0";
  const files = withAgentProfile(inputFiles, minManagerVersion);
  const manifest: PackManifest = {
    schemaVersion: "longhub/v1",
    pack: { id: "longhub.hr-suite", version, minManagerVersion },
    agentTemplate: { id: "longhub.agent.hr", version: "1.0.0", profilePath: "agent-profile.json" },
    capabilities: [
      { id: "longhub.capability.recruitment", version: "1.0.0", required: true, permissions: [] },
    ],
    runtime: { sdkVersion: "1.0", executionMode: "hybrid" },
    limits: { maxConcurrentSkills: 3, maxTaskDepth: 3 },
    integrity: { algorithm: "sha256", digest: "pending", signatureKeyId: options.signingKeyId ?? KEY_ID },
  };
  const digest = computePackDigest(manifest, files);
  manifest.integrity.digest = digest;
  return { manifest, files, signature: signPackDigest(digest, privatePem) };
}

const ctx = { trustedKeys, desktopVersion: "1.0.0" };

describe("套装签名、安装、原子切换与回滚", () => {
  const installer = new PackInstaller(installRoot);

  it("正常安装并激活", () => {
    const result = installer.install(buildPack("1.0.0", { "agent.yaml": "id: hr" }), ctx);
    expect(result).toMatchObject({ ok: true, version: "1.0.0" });
    expect(installer.activeVersion("longhub.hr-suite")).toBe("1.0.0");
    expect(installer.readActivePack("longhub.hr-suite")).toMatchObject({
      manifest: { pack: { id: "longhub.hr-suite", version: "1.0.0" } },
      files: { "workspace/IDENTITY.md": "# HR 助理" },
    });
    expect(installer.verifyActivePack("longhub.hr-suite", ctx).manifest.pack.version).toBe("1.0.0");
  });

  it("重新启用时复验安装目录保存的签名", () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), "longhub-active-signature-"));
    try {
      const isolated = new PackInstaller(isolatedRoot);
      expect(isolated.install(buildPack("1.0.0", { "agent.yaml": "id: hr" }), ctx).ok).toBe(true);
      writeFileSync(
        join(isolatedRoot, "longhub.hr-suite", "v1.0.0", ".longhub-signature"),
        Buffer.from("forged").toString("base64"),
        "utf8",
      );
      expect(() => isolated.verifyActivePack("longhub.hr-suite", ctx)).toThrow("签名复验失败");
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  it("运行时重新校验 active 制品并拒绝安装后篡改", () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), "longhub-active-pack-"));
    try {
      const isolated = new PackInstaller(isolatedRoot);
      expect(isolated.install(buildPack("1.0.0", { "agent.yaml": "id: hr" }), ctx).ok).toBe(true);
      writeFileSync(
        join(isolatedRoot, "longhub.hr-suite", "v1.0.0", "workspace", "IDENTITY.md"),
        "# 被篡改的助理",
        "utf8",
      );
      expect(() => isolated.readActivePack("longhub.hr-suite")).toThrow("摘要不一致");
      expect(() => isolated.readActivePack("../escape")).toThrow("Pack ID 无效");
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  it("篡改内容被拒绝（摘要不一致），旧版本保持激活", () => {
    const pack = buildPack("1.1.0", { "agent.yaml": "id: hr" });
    pack.files["agent.yaml"] = "id: evil";
    const result = installer.install(pack, ctx);
    expect(result).toMatchObject({ ok: false, code: "DIGEST_MISMATCH" });
    expect(installer.activeVersion("longhub.hr-suite")).toBe("1.0.0");
  });

  it("伪造签名被拒绝", () => {
    const pack = buildPack("1.1.0", { "agent.yaml": "id: hr" });
    pack.signature = Buffer.from("forged").toString("base64");
    const result = installer.install(pack, ctx);
    expect(result).toMatchObject({ ok: false, code: "SIGNATURE_INVALID" });
  });

  it("不信任的签名密钥被拒绝", () => {
    const pack = buildPack("1.1.0", { "agent.yaml": "id: hr" }, { signingKeyId: "unknown-key" });
    const result = installer.install(pack, ctx);
    expect(result).toMatchObject({ ok: false, code: "UNKNOWN_SIGNING_KEY" });
  });

  it("Desktop 版本不兼容被拒绝", () => {
    const pack = buildPack("1.1.0", { "agent.yaml": "id: hr" }, { minManagerVersion: "9.9.9" });
    const result = installer.install(pack, { ...ctx, desktopVersion: "1.0.0" });
    expect(result).toMatchObject({ ok: false, code: "DESKTOP_INCOMPATIBLE" });
  });

  it("签名后篡改 Manifest 被拒绝", () => {
    const pack = buildPack("1.1.0", { "agent.yaml": "id: hr" });
    pack.manifest.pack.version = "9.9.9";
    const result = installer.install(pack, ctx);
    expect(result).toMatchObject({ ok: false, code: "DIGEST_MISMATCH" });
  });

  it("升级后可原子回滚到上一版本，再次回滚可切回", () => {
    const upgraded = installer.install(buildPack("2.0.0", { "agent.yaml": "id: hr-v2" }), ctx);
    expect(upgraded).toMatchObject({ ok: true, version: "2.0.0", previousVersion: "1.0.0" });
    expect(installer.activeVersion("longhub.hr-suite")).toBe("2.0.0");

    const rolledBack = installer.rollback("longhub.hr-suite");
    expect(rolledBack).toMatchObject({ ok: true, version: "1.0.0" });
    expect(installer.activeVersion("longhub.hr-suite")).toBe("1.0.0");

    const rolledForward = installer.rollback("longhub.hr-suite");
    expect(rolledForward).toMatchObject({ ok: true, version: "2.0.0" });
  });

  it("没有上一版本时回滚报错", () => {
    const result = new PackInstaller(mkdtempSync(join(tmpdir(), "lh-empty-"))).rollback("longhub.hr-suite");
    expect(result).toMatchObject({ ok: false, code: "NO_PREVIOUS_VERSION" });
    expect(installer.rollback("../escape")).toMatchObject({ ok: false, code: "PACK_ID_INVALID" });
  });

  it("拒绝被篡改为路径穿越版本的 active 指针", () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), "longhub-pointer-"));
    try {
      const packDir = join(isolatedRoot, "longhub.hr-suite");
      mkdirSync(packDir, { recursive: true });
      writeFileSync(join(packDir, "current.json"), JSON.stringify({ active: { version: "../../escape" } }), "utf8");
      expect(() => new PackInstaller(isolatedRoot).readActivePack("longhub.hr-suite")).toThrow("active 版本无效");
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  it("全新 Pack 激活失败时清除 active 指针并允许同版本重试", () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), "longhub-activation-retry-"));
    try {
      const isolated = new PackInstaller(isolatedRoot);
      const pack = buildPack("1.0.0", { "agent.yaml": "id: hr" });
      expect(isolated.install(pack, ctx).ok).toBe(true);
      isolated.clearActiveVersion("longhub.hr-suite", "1.0.0");
      expect(isolated.activeVersion("longhub.hr-suite")).toBeUndefined();
      expect(isolated.install(pack, ctx)).toMatchObject({ ok: true, version: "1.0.0" });
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });
});
