import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLIENT_UPDATE_SCHEMA,
  clientUpdateDigest,
  clientUpdateRolloutBucket,
  signClientUpdateManifest,
  type ClientUpdateManifest,
  type SignedClientUpdateMetadata,
} from "@longhub/pack-schema";
import {
  ClientUpdateVerifier,
  downloadTrustedClientUpdate,
  verifyDownloadedClientUpdate,
} from "../src/client-update.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function signed(
  key: ReturnType<typeof keyPair>,
  sequence: number,
  version = "0.5.0",
  content = Buffer.from(`installer-${version}`),
  rollout: ClientUpdateManifest["rollout"] = {
    status: "active",
    basis_points: 10_000,
    seed: "a".repeat(64),
    updated_at: "2026-07-29T12:00:00.000Z",
  },
): SignedClientUpdateMetadata {
  const manifest: ClientUpdateManifest = {
    schema_version: CLIENT_UPDATE_SCHEMA,
    sequence,
    version,
    channel: "stable",
    platform: "win32",
    arch: "x64",
    filename: `LongHub-Setup-${version}.exe`,
    size: content.length,
    sha256: clientUpdateDigest(content),
    url_path: `/downloads/LongHub-Setup-${version}.exe`,
    published_at: "2026-07-29T12:00:00.000Z",
    rollback_data_strategy: "snapshot_required",
    rollout,
  };
  return {
    manifest,
    signature_key_id: "update-2026",
    signature: signClientUpdateManifest(manifest, key.privateKey),
  };
}

function verifier(
  root: string,
  key: ReturnType<typeof keyPair>,
  release: SignedClientUpdateMetadata | null,
  rollbackRecordFile?: string,
) {
  mkdirSync(root, { recursive: true });
  return new ClientUpdateVerifier({
    cloudBaseUrl: "https://cloud.example",
    currentVersion: "0.4.0",
    channel: "stable",
    rolloutIdentity: "dev-test-client",
    trustedKeys: new Map([["update-2026", key.publicKey]]),
    stateFile: join(root, "update-state.json"),
    rollbackRecordFile,
    fetchImpl: async () => new Response(JSON.stringify({ release }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
}

describe("Desktop 客户端更新可信验证", () => {
  it("接受预置公钥签名并原子记录最高序列", async () => {
    const root = mkdtempSync(join(tmpdir(), "longhub-update-client-"));
    roots.push(root);
    const key = keyPair();
    const result = await verifier(root, key, signed(key, 8)).check();
    expect(result).toMatchObject({
      action: "update_available",
      artifactUrl: "https://cloud.example/downloads/LongHub-Setup-0.5.0.exe",
    });
    expect(JSON.parse(readFileSync(join(root, "update-state.json"), "utf8"))).toMatchObject({
      channels: { stable: { sequence: 8 } },
    });
  });

  it("拒绝重放旧序列和同序列不同元数据", async () => {
    const root = mkdtempSync(join(tmpdir(), "longhub-update-client-"));
    roots.push(root);
    const key = keyPair();
    await verifier(root, key, signed(key, 8)).check();
    await expect(verifier(root, key, signed(key, 7, "0.4.9")).check()).rejects.toThrow("序列回退");
    await expect(verifier(root, key, signed(key, 8, "0.5.1")).check()).rejects.toThrow("同一序列");
  });

  it("拒绝未知密钥、签名篡改、非 HTTPS 与损坏状态", async () => {
    const root = mkdtempSync(join(tmpdir(), "longhub-update-client-"));
    roots.push(root);
    const key = keyPair();
    const unknownKey = keyPair();
    await expect(verifier(root, key, signed(unknownKey, 1)).check()).rejects.toThrow("签名无效");
    const metadata = signed(key, 1);
    metadata.signature = `${metadata.signature.slice(0, -2)}aa`;
    await expect(verifier(root, key, metadata).check()).rejects.toThrow("签名无效");
    await expect(new ClientUpdateVerifier({
      cloudBaseUrl: "http://updates.example",
      currentVersion: "0.4.0",
      channel: "stable",
      rolloutIdentity: "dev-test-client",
      trustedKeys: new Map([["update-2026", key.publicKey]]),
      stateFile: join(root, "state.json"),
    }).check()).rejects.toThrow("HTTPS");
    writeFileSync(join(root, "update-state.json"), "{}", "utf8");
    await expect(verifier(root, key, signed(key, 2)).check()).rejects.toThrow("状态损坏");
  });

  it("验签后执行暂停与确定性灰度策略，并记录更高策略序列", async () => {
    const root = mkdtempSync(join(tmpdir(), "longhub-update-client-"));
    roots.push(root);
    const key = keyPair();
    const baseRollout = {
      basis_points: 10_000,
      seed: "b".repeat(64),
      updated_at: "2026-07-30T00:00:00.000Z",
    } as const;
    await expect(verifier(root, key, signed(key, 2, "0.5.0", undefined, {
      ...baseRollout,
      status: "paused",
    })).check()).resolves.toMatchObject({ action: "none", reason: "paused" });
    expect(clientUpdateRolloutBucket(baseRollout.seed, "dev-test-client")).not.toBe(0);
    await expect(verifier(root, key, signed(key, 3, "0.5.0", undefined, {
      ...baseRollout,
      status: "active",
      basis_points: 1,
    })).check()).resolves.toMatchObject({ action: "none", reason: "not_in_rollout" });
    expect(JSON.parse(readFileSync(join(root, "update-state.json"), "utf8"))).toMatchObject({
      channels: { stable: { sequence: 3 } },
    });
  });

  it("精确版本查询忽略灰度但仍严格验签，并抑制刚回滚的坏版本", async () => {
    const root = mkdtempSync(join(tmpdir(), "longhub-update-client-"));
    roots.push(root);
    const key = keyPair();
    const paused = signed(key, 8, "0.4.0", undefined, {
      status: "paused",
      basis_points: 0,
      seed: "c".repeat(64),
      updated_at: "2026-07-30T00:00:00.000Z",
    });
    await expect(verifier(root, key, paused).fetchVersion("0.4.0")).resolves.toMatchObject({
      metadata: { manifest: { version: "0.4.0" } },
      artifactUrl: "https://cloud.example/downloads/LongHub-Setup-0.4.0.exe",
    });

    const rollbackRecord = join(root, "last-rollback.json");
    writeFileSync(rollbackRecord, JSON.stringify({
      schema_version: "longhub/client-update-last-rollback/v1",
      previous_version: "0.4.0",
      target_version: "0.5.0",
      sequence: 7,
      attempts: 3,
      reason: "startup_failure_threshold",
      rolled_back_at: "2026-07-30T00:00:00.000Z",
      failed_state_path: join(root, "failed"),
      snapshot_path: join(root, "snapshot"),
    }), "utf8");
    await expect(verifier(root, key, signed(key, 9), rollbackRecord).check()).resolves.toMatchObject({
      action: "none",
      reason: "rollback_blocked",
    });
    await expect(verifier(root, key, signed(key, 10, "0.5.1"), rollbackRecord).check()).resolves.toMatchObject({
      action: "update_available",
    });
  });

  it("安装前流式校验文件大小和 SHA-256", async () => {
    const root = mkdtempSync(join(tmpdir(), "longhub-update-client-"));
    roots.push(root);
    const key = keyPair();
    const content = Buffer.from("installer-0.5.0");
    const metadata = signed(key, 1, "0.5.0", content);
    const file = join(root, metadata.manifest.filename);
    writeFileSync(file, content);
    await expect(verifyDownloadedClientUpdate(file, metadata.manifest)).resolves.toBeUndefined();
    writeFileSync(file, Buffer.from("tampered-0.5.0"));
    await expect(verifyDownloadedClientUpdate(file, metadata.manifest)).rejects.toThrow();
  });

  it("下载时拒绝错误长度、超长内容和摘要篡改，并清理临时文件", async () => {
    const root = mkdtempSync(join(tmpdir(), "longhub-update-download-"));
    roots.push(root);
    const key = keyPair();
    const content = Buffer.from("trusted-installer");
    const metadata = signed(key, 1, "0.5.0", content);
    const invoke = (body: Buffer, headers?: Record<string, string>) => downloadTrustedClientUpdate({
      metadata,
      artifactUrl: "https://cloud.example/downloads/LongHub-Setup-0.5.0.exe",
      directory: root,
      fetchImpl: async () => new Response(body, { status: 200, headers }),
    });
    await expect(invoke(content, { "content-length": "1" })).rejects.toThrow("Content-Length");
    await expect(invoke(Buffer.concat([content, Buffer.from("extra")]))).rejects.toThrow("超过");
    await expect(invoke(Buffer.alloc(content.length, 1))).rejects.toThrow("SHA-256");
    expect(readdirSync(root)).toEqual([]);
  });

  it("下载成功后复用已验证缓存，且不覆盖错误缓存", async () => {
    const root = mkdtempSync(join(tmpdir(), "longhub-update-download-"));
    roots.push(root);
    const key = keyPair();
    const content = Buffer.from("trusted-installer");
    const metadata = signed(key, 1, "0.5.0", content);
    let fetches = 0;
    const options = {
      metadata,
      artifactUrl: "https://cloud.example/downloads/LongHub-Setup-0.5.0.exe",
      directory: root,
      fetchImpl: async () => {
        fetches += 1;
        return new Response(content, { status: 200 });
      },
    };
    const path = await downloadTrustedClientUpdate(options);
    expect(await downloadTrustedClientUpdate(options)).toBe(path);
    expect(fetches).toBe(1);
    writeFileSync(path, "tampered", "utf8");
    await expect(downloadTrustedClientUpdate(options)).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toBe("tampered");
  });
});
