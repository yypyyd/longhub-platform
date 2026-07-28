import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
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

function buildPack(version: string, files: Record<string, string>): PackFile {
  const digest = computePackDigest(files);
  const manifest: PackManifest = {
    schemaVersion: "longhub/v1",
    pack: { id: "longhub.hr-suite", version, minDesktopVersion: "1.0.0" },
    agentTemplate: { id: "longhub.agent.hr", version: "1.0.0" },
    capabilities: [
      { id: "longhub.capability.recruitment", version: "1.0.0", required: true, permissions: [] },
    ],
    runtime: { sdkVersion: "1.0", executionMode: "hybrid" },
    limits: { maxConcurrentSkills: 3, maxTaskDepth: 3 },
    integrity: { algorithm: "sha256", digest, signatureKeyId: KEY_ID },
  };
  return { manifest, files, signature: signPackDigest(digest, privatePem) };
}

const ctx = { trustedKeys, desktopVersion: "1.0.0" };

describe("套装签名、安装、原子切换与回滚", () => {
  const installer = new PackInstaller(installRoot);

  it("正常安装并激活", () => {
    const result = installer.install(buildPack("1.0.0", { "agent.yaml": "id: hr" }), ctx);
    expect(result).toMatchObject({ ok: true, version: "1.0.0" });
    expect(installer.activeVersion("longhub.hr-suite")).toBe("1.0.0");
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
    const pack = buildPack("1.1.0", { "agent.yaml": "id: hr" });
    pack.manifest.integrity.signatureKeyId = "unknown-key";
    // 重新计算摘要以隔离密钥校验逻辑
    const result = installer.install(pack, ctx);
    expect(result.ok).toBe(false);
  });

  it("Desktop 版本不兼容被拒绝", () => {
    const pack = buildPack("1.1.0", { "agent.yaml": "id: hr" });
    pack.manifest.pack.minDesktopVersion = "9.9.9";
    // minDesktopVersion 不在摘要覆盖范围内（摘要只覆盖 files），签名仍有效
    const result = installer.install(pack, { ...ctx, desktopVersion: "1.0.0" });
    expect(result).toMatchObject({ ok: false, code: "DESKTOP_INCOMPATIBLE" });
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
  });
});
