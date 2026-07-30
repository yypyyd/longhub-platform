import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  isSupportedNodeVersion,
  validateSignatureRecord,
  verifyBrandAssets,
  verifyClientUpdateTrust,
} from "../scripts/release-verification.mjs";
import {
  externalRuntimeUnpackPatterns,
  verifyExternalRuntimeManifest,
} from "../scripts/openclaw-runtime-manifest.mjs";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "longhub-release-verification-"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("Windows 正式发布门禁", () => {
  it("内部候选接受当前临时品牌资产，但正式发布拒绝", () => {
    expect(verifyBrandAssets(appRoot)).toMatchObject({ status: "temporary" });
    expect(() => verifyBrandAssets(appRoot, { requireApproved: true })).toThrow("status=approved");
  });

  it("内部候选可携带 pending 更新信任清单，正式发布必须审批并绑定签名主体", () => {
    expect(verifyClientUpdateTrust(appRoot)).toMatchObject({ status: "pending", keys: [] });
    expect(() => verifyClientUpdateTrust(appRoot, {
      requireApproved: true,
      expectedSigner: "CN=LongHub Technology",
    })).toThrow("审批通过");

    const copyRoot = join(root, "update-trust-approved");
    mkdirSync(join(copyRoot, "assets"), { recursive: true });
    const publicKey = generateKeyPairSync("ed25519").publicKey
      .export({ type: "spki", format: "pem" }).toString();
    writeFileSync(join(copyRoot, "assets", "update-trusted-keys.json"), JSON.stringify({
      schema_version: "longhub/client-update-trust/v1",
      status: "approved",
      channel: "stable",
      expected_signer_subject: "CN=LongHub Technology",
      approved_by: "release-security",
      approved_at: "2026-07-29T00:00:00.000Z",
      keys: [{ key_id: "update-2026", public_key_pem: publicKey }],
    }));
    expect(verifyClientUpdateTrust(copyRoot, {
      requireApproved: true,
      expectedSigner: "CN=LongHub Technology",
    })).toMatchObject({ status: "approved" });
    expect(() => verifyClientUpdateTrust(copyRoot, {
      requireApproved: true,
      expectedSigner: "CN=Another Publisher",
    })).toThrow("主体不一致");
  });

  it("品牌资产被替换但未更新审批清单时拒绝", () => {
    const copyRoot = join(root, "brand-drift");
    mkdirSync(join(copyRoot, "assets"), { recursive: true });
    for (const name of ["brand-manifest.json", "longhub-icon.svg", "longhub-icon.png", "longhub-icon.ico"]) {
      writeFileSync(join(copyRoot, "assets", name), readFileSync(join(appRoot, "assets", name)));
    }
    writeFileSync(join(copyRoot, "assets", "longhub-icon.svg"), "<svg viewBox=\"0 0 1 1\"></svg>");
    expect(() => verifyBrandAssets(copyRoot)).toThrow("摘要不一致");
  });

  it("正式签名必须有效、主体匹配并带可信时间戳", () => {
    expect(() => validateSignatureRecord({ status: "NotSigned" }, { label: "安装包" })).toThrow("不是 Valid");
    expect(() => validateSignatureRecord({ status: "Valid", signerSubject: "CN=Other" }, {
      expectedSigner: "LongHub", label: "安装包",
    })).toThrow("主体不匹配");
    expect(() => validateSignatureRecord({ status: "Valid", signerSubject: "CN=LongHub" }, {
      expectedSigner: "LongHub", requireTimestamp: true, label: "安装包",
    })).toThrow("缺少可信时间戳");
    expect(validateSignatureRecord({
      status: "Valid",
      signerSubject: "CN=LongHub Technology",
      timestampSubject: "CN=Trusted Timestamp",
    }, {
      expectedSigner: "LongHub Technology",
      requireTimestamp: true,
      label: "安装包",
    }).acceptedUnsigned).toBe(false);
  });

  it("只允许 OpenClaw 支持的内置 Node 版本", () => {
    expect(isSupportedNodeVersion("v22.22.3")).toBe(true);
    expect(isSupportedNodeVersion("v24.15.0")).toBe(true);
    expect(isSupportedNodeVersion("v25.9.0")).toBe(true);
    expect(isSupportedNodeVersion("v26.0.0")).toBe(true);
    expect(isSupportedNodeVersion("v24.14.0")).toBe(false);
    expect(isSupportedNodeVersion("v25.8.0")).toBe(false);
  });

  it("sandbox 激活 preload 以 CommonJS 产物进入正式包", () => {
    const mainSource = readFileSync(join(appRoot, "src", "main.ts"), "utf8");
    expect(existsSync(join(appRoot, "src", "activation-preload.cts"))).toBe(true);
    expect(mainSource).toContain('preloadPath: join(dirname, "activation-preload.cjs")');
    expect(mainSource).not.toContain("activation-preload.js");
  });

  it("外置运行时白名单与当前 OpenClaw 生产依赖闭包一致", () => {
    const manifest = verifyExternalRuntimeManifest(appRoot);
    expect(manifest).toMatchObject({
      schema: "longhub/openclaw-external-runtime/v1",
      openclawVersion: "2026.7.1-2",
      roots: ["openclaw", "@longhub/openclaw-bridge"],
    });
    expect(manifest.packages).toContain("@lydell/node-pty-win32-x64");
    expect(manifest.packages).toContain("sqlite-vec-windows-x64");
    expect(externalRuntimeUnpackPatterns(manifest)).not.toContain("dist/**/*");
  });
});
