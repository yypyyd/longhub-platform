import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CLIENT_UPDATE_SCHEMA,
  clientUpdateDigest,
  clientUpdateManifestSchema,
  clientUpdateRolloutBucket,
  compareClientVersions,
  isClientUpdateRolloutEligible,
  signClientUpdateManifest,
  verifyClientUpdateMetadata,
  type ClientUpdateManifest,
} from "../src/index.js";

function keys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function manifest(): ClientUpdateManifest {
  const content = Buffer.from("signed-installer");
  return {
    schema_version: CLIENT_UPDATE_SCHEMA,
    product_surface: "longhub-manager",
    sequence: 7,
    version: "0.4.0",
    channel: "stable",
    platform: "win32",
    arch: "x64",
    filename: "LongHub-Manager-Setup-0.4.0.exe",
    size: content.length,
    sha256: clientUpdateDigest(content),
    url_path: "/downloads/LongHub-Manager-Setup-0.4.0.exe",
    published_at: "2026-07-29T12:00:00.000Z",
    rollback_data_strategy: "snapshot_required",
    rollout: {
      status: "active",
      basis_points: 10_000,
      seed: "a".repeat(64),
      updated_at: "2026-07-29T12:00:00.000Z",
    },
  };
}

describe("客户端更新签名契约", () => {
  it("以独立用途域签名并用指定 key ID 验证", () => {
    const key = keys();
    const value = manifest();
    const metadata = {
      manifest: value,
      signature_key_id: "longhub-update-2026",
      signature: signClientUpdateManifest(value, key.privateKey),
    };
    expect(verifyClientUpdateMetadata(metadata, new Map([["longhub-update-2026", key.publicKey]]))).toBe(true);
    expect(verifyClientUpdateMetadata(metadata, new Map([["other-key", key.publicKey]]))).toBe(false);
  });

  it("版本、摘要、路径或序列被修改后验签失败", () => {
    const key = keys();
    const value = manifest();
    const signature = signClientUpdateManifest(value, key.privateKey);
    const trusted = new Map([["update", key.publicKey]]);
    for (const changed of [
      { ...value, version: "0.4.1" },
      { ...value, sha256: "0".repeat(64) },
      { ...value, url_path: "/downloads/LongHub-Manager-Setup-9.9.9.exe" },
      { ...value, sequence: 6 },
      { ...value, product_surface: "longhub-desktop" },
      { ...value, rollback_data_strategy: "backward_compatible" },
      { ...value, rollout: { ...value.rollout, status: "paused" } },
    ]) {
      const metadata = { manifest: changed, signature_key_id: "update", signature };
      expect(verifyClientUpdateMetadata(metadata, trusted)).toBe(false);
    }
  });

  it("使用签名 seed 对稳定设备身份做确定性、单调灰度", () => {
    const value = manifest();
    const identity = "dev-01234567-89ab-cdef-0123-456789abcdef";
    const bucket = clientUpdateRolloutBucket(value.rollout.seed, identity);
    expect(clientUpdateRolloutBucket(value.rollout.seed, identity)).toBe(bucket);
    expect(bucket).toBeGreaterThanOrEqual(0);
    expect(bucket).toBeLessThan(10_000);
    expect(isClientUpdateRolloutEligible({ ...value.rollout, basis_points: bucket + 1 }, identity)).toBe(true);
    expect(isClientUpdateRolloutEligible({ ...value.rollout, status: "paused" }, identity)).toBe(false);
    expect(() => clientUpdateRolloutBucket("bad", identity)).toThrow("seed");
    expect(() => clientUpdateRolloutBucket(value.rollout.seed, "bad identity")).toThrow("身份");
  });

  it("拒绝未知字段、版本文件名不一致与非规范版本", () => {
    const key = keys();
    const value = manifest();
    const trusted = new Map([["update", key.publicKey]]);
    const signed = (changed: unknown) => ({
      manifest: changed,
      signature_key_id: "update",
      signature: signClientUpdateManifest(value, key.privateKey),
    });
    expect(verifyClientUpdateMetadata(signed({ ...value, mirror: "https://evil.example" }), trusted)).toBe(false);
    const legacyFilename = {
      ...value,
      filename: "LongHub-Setup-0.4.0.exe",
      url_path: "/downloads/LongHub-Setup-0.4.0.exe",
    };
    expect(clientUpdateManifestSchema.safeParse(legacyFilename).success).toBe(false);
    expect(() => signClientUpdateManifest(
      legacyFilename as ClientUpdateManifest,
      key.privateKey,
    )).toThrow();
    const { product_surface: _surface, ...withoutProductSurface } = value;
    expect(verifyClientUpdateMetadata(signed(withoutProductSurface), trusted)).toBe(false);
    expect(() => compareClientVersions("v0.4.0", "0.3.7")).toThrow();
    expect(() => compareClientVersions("00.4.0", "0.3.7")).toThrow();
    expect(() => compareClientVersions("9999999999.0.0", "0.3.7")).toThrow();
    expect(compareClientVersions("0.4.0", "0.3.7")).toBe(1);
    expect(compareClientVersions("0.4.0", "0.4.0")).toBe(0);
  });
});
