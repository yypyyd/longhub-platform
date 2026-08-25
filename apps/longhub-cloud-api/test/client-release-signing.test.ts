import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clientUpdateDigest, verifyClientUpdateMetadata, type SignedClientUpdateMetadata } from "@longhub/pack-schema";
import { createCloudApiServer, generateSigningKey } from "../src/server.js";

const ADMIN_TOKEN = "client-release-admin";
const releaseDir = mkdtempSync(join(tmpdir(), "longhub-client-release-"));
const updateKey = generateSigningKey("longhub-update-test-2026");
let server: ReturnType<typeof createCloudApiServer>;
let baseUrl: string;

beforeAll(async () => {
  writeFileSync(join(releaseDir, "releases.json"), JSON.stringify([{
    version: "0.3.7",
    filename: "LongHub-Setup-0.3.7.exe",
    size: 10,
    uploaded_by: "legacy",
    uploaded_at: "2026-07-01T00:00:00.000Z",
  }]), "utf8");
  server = createCloudApiServer({
    executorUrl: "http://127.0.0.1:1",
    adminToken: ADMIN_TOKEN,
    signingKey: generateSigningKey("longhub-pack-test-2026"),
    updateSigningKey: updateKey,
    clientReleaseDir: releaseDir,
  }).listen(0);
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  rmSync(releaseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function upload(version: string, content: Buffer, filename = `LongHub-Manager-Setup-${version}.exe`) {
  return fetch(
    `${baseUrl}/v1/admin/client-releases?version=${encodeURIComponent(version)}&filename=${encodeURIComponent(filename)}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/octet-stream" },
      body: content,
    },
  );
}

function updateRollout(
  version: string,
  body: unknown,
  token = ADMIN_TOKEN,
) {
  return fetch(`${baseUrl}/v1/admin/client-releases/${encodeURIComponent(version)}/rollout`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("客户端安装包签名发布", () => {
  it("旧未签名元数据不会被公开或自动重签", async () => {
    const response = await fetch(`${baseUrl}/v1/client-releases/latest`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ release: null });
  });

  it("拒绝旧制品名、任意文件名和缺失管理凭据", async () => {
    expect((await upload("0.4.0", Buffer.from("installer"), "LongHub-Setup-0.4.0.exe")).status).toBe(422);
    expect((await upload("0.4.0", Buffer.from("installer"), "renamed.exe")).status).toBe(422);
    const unauthorized = await fetch(
      `${baseUrl}/v1/admin/client-releases?version=0.4.0&filename=LongHub-Manager-Setup-0.4.0.exe`,
      { method: "POST", body: Buffer.from("installer") },
    );
    expect(unauthorized.status).toBe(401);
  });

  it("计算安装包摘要并返回可由独立更新公钥验证的元数据", async () => {
    const content = Buffer.from("longhub-0.4.0-signed-installer");
    const uploaded = await upload("0.4.0", content);
    expect(uploaded.status).toBe(201);
    const body = (await uploaded.json()) as { release: SignedClientUpdateMetadata & { url: string } };
    expect(body.release.manifest).toMatchObject({
      product_surface: "longhub-manager",
      sequence: 1,
      version: "0.4.0",
      channel: "stable",
      size: content.length,
      sha256: clientUpdateDigest(content),
      filename: "LongHub-Manager-Setup-0.4.0.exe",
      url_path: "/downloads/LongHub-Manager-Setup-0.4.0.exe",
      rollout: { status: "paused", basis_points: 0 },
    });
    expect(body.release.url).toBe(body.release.manifest.url_path);
    expect(verifyClientUpdateMetadata(
      body.release,
      new Map([[updateKey.keyId, updateKey.publicKeyPem]]),
    )).toBe(false); // Admin view 含额外字段，严格 envelope 不应误验。

    const latest = (await (await fetch(`${baseUrl}/v1/client-releases/latest`)).json()) as {
      release: SignedClientUpdateMetadata;
    };
    expect(verifyClientUpdateMetadata(
      latest.release,
      new Map([[updateKey.keyId, updateKey.publicKeyPem]]),
    )).toBe(true);
    expect(readFileSync(join(releaseDir, "LongHub-Manager-Setup-0.4.0.exe"))).toEqual(content);
    if (process.platform !== "win32") {
      expect(statSync(join(releaseDir, "LongHub-Manager-Setup-0.4.0.exe")).mode & 0o777).toBe(0o644);
    }
  });

  it("灰度与暂停都重新签名并递增 sequence，固定 seed 保持 cohort 单调", async () => {
    expect((await updateRollout("0.4.0", { status: "active", basis_points: 0 })).status).toBe(422);
    expect((await updateRollout("0.4.0", { status: "active", basis_points: 500 }, "wrong")).status).toBe(401);
    const active = await updateRollout("0.4.0", { status: "active", basis_points: 500 });
    expect(active.status).toBe(200);
    const activeRelease = (await active.json()) as { release: SignedClientUpdateMetadata };
    expect(activeRelease.release.manifest).toMatchObject({
      product_surface: "longhub-manager",
      sequence: 2,
      rollout: { status: "active", basis_points: 500 },
    });
    const seed = activeRelease.release.manifest.rollout.seed;
    const expanded = await updateRollout("0.4.0", { status: "active", basis_points: 2_500 });
    expect(expanded.status).toBe(200);
    const expandedRelease = (await expanded.json()) as { release: SignedClientUpdateMetadata };
    expect(expandedRelease.release.manifest.rollout.seed).toBe(seed);
    expect(expandedRelease.release.manifest.sequence).toBe(3);
    const paused = await updateRollout("0.4.0", { status: "paused", basis_points: 2_500 });
    expect(paused.status).toBe(200);
    const latest = (await (await fetch(`${baseUrl}/v1/client-releases/latest`)).json()) as {
      release: SignedClientUpdateMetadata;
    };
    expect(latest.release.manifest).toMatchObject({
      sequence: 4,
      rollout: { status: "paused", basis_points: 2_500, seed },
    });
    expect(verifyClientUpdateMetadata(
      latest.release,
      new Map([[updateKey.keyId, updateKey.publicKeyPem]]),
    )).toBe(true);
  });

  it("按精确版本返回签名元数据且不受灰度状态影响", async () => {
    const response = await fetch(`${baseUrl}/v1/client-releases/versions/0.4.0?channel=stable`);
    expect(response.status).toBe(200);
    const body = await response.json() as { release: SignedClientUpdateMetadata };
    expect(body.release.manifest).toMatchObject({
      product_surface: "longhub-manager",
      version: "0.4.0",
      channel: "stable",
      rollout: { status: "paused", basis_points: 2_500 },
      rollback_data_strategy: "snapshot_required",
    });
    expect(verifyClientUpdateMetadata(
      body.release,
      new Map([[updateKey.keyId, updateKey.publicKeyPem]]),
    )).toBe(true);
    expect((await fetch(`${baseUrl}/v1/client-releases/versions/0.4.0?channel=nightly`)).status).toBe(422);
    expect((await fetch(`${baseUrl}/v1/client-releases/versions/9.9.9?channel=stable`)).status).toBe(404);
  });

  it("禁止覆盖同版本和发布较低版本", async () => {
    expect((await upload("0.4.0", Buffer.from("replacement"))).status).toBe(409);
    expect((await upload("0.3.9", Buffer.from("rollback"))).status).toBe(409);
  });

  it("新版本使用单调序列，磁盘篡改后服务端停止公开", async () => {
    const uploaded = await upload("0.5.0", Buffer.from("longhub-0.5.0"));
    expect(uploaded.status).toBe(201);
    const latest = (await (await fetch(`${baseUrl}/v1/client-releases/latest`)).json()) as {
      release: SignedClientUpdateMetadata;
    };
    expect(latest.release.manifest.sequence).toBe(5);
    expect((await updateRollout("0.4.0", { status: "active", basis_points: 10_000 })).status).toBe(409);
    const indexPath = join(releaseDir, "releases.json");
    const index = JSON.parse(readFileSync(indexPath, "utf8")) as Array<{ manifest: { sha256: string } }>;
    index[0]!.manifest.sha256 = "0".repeat(64);
    writeFileSync(indexPath, JSON.stringify(index), "utf8");
    expect((await fetch(`${baseUrl}/v1/client-releases/latest`)).status).toBe(500);
  });
});
