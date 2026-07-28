/**
 * Pack 分发闭环测试：上传→云端签名→目录可见→授权下载（验签通过）→吊销后 410。
 */
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  computePackDigest,
  verifyPackSignature,
  type PackFile,
  type PackManifest,
} from "@longhub/pack-schema";
import { createCloudApiServer } from "../src/server.js";

const ADMIN_TOKEN = "test-admin";

function buildUnsignedPack(version: string, files: Record<string, string>) {
  const manifest: PackManifest = {
    schemaVersion: "longhub/v1",
    pack: { id: "longhub.hr-suite", version, minDesktopVersion: "1.0.0" },
    agentTemplate: { id: "longhub.agent.hr", version: "1.0.0" },
    capabilities: [
      { id: "longhub.capability.recruitment", version: "1.0.0", required: true, permissions: [] },
    ],
    runtime: { sdkVersion: "1.0", executionMode: "hybrid" },
    limits: { maxConcurrentSkills: 3, maxTaskDepth: 3 },
    integrity: { algorithm: "sha256", digest: "placeholder", signatureKeyId: "placeholder" },
  };
  return { manifest, files };
}

let api: ReturnType<typeof createCloudApiServer>;
let baseUrl: string;
let deviceToken: string;
let deviceId: string;

beforeAll(async () => {
  api = createCloudApiServer({ executorUrl: "http://127.0.0.1:1", adminToken: ADMIN_TOKEN }).listen(0);
  await once(api, "listening");
  baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  const registered = await fetch(`${baseUrl}/v1/devices/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform: "windows", app_version: "1.0.0", device_fingerprint: "fp-dist-test" }),
  });
  const device = (await registered.json()) as { device_id: string; device_token: string };
  deviceToken = device.device_token;
  deviceId = device.device_id;
});

afterAll(() => {
  api.close();
});

const admin = (path: string, body?: unknown) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("Pack 分发闭环：上传→签名→授权下载→吊销", () => {
  it("无管理凭据上传被拒绝（401）", async () => {
    const res = await fetch(`${baseUrl}/v1/admin/packs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildUnsignedPack("1.0.0", { "agent.yaml": "id: hr" })),
    });
    expect(res.status).toBe(401);
  });

  it("上传后云端重算摘要并签名发布（201）；同版本重发 409", async () => {
    const created = await admin("/v1/admin/packs", buildUnsignedPack("1.0.0", { "agent.yaml": "id: hr" }));
    expect(created.status).toBe(201);
    const release = (await created.json()) as { pack_id: string; version: string; signature_key_id: string };
    expect(release).toMatchObject({ pack_id: "longhub.hr-suite", version: "1.0.0" });
    expect(release.signature_key_id.length).toBeGreaterThan(0);

    const duplicated = await admin("/v1/admin/packs", buildUnsignedPack("1.0.0", { "agent.yaml": "id: hr" }));
    expect(duplicated.status).toBe(409);
  });

  it("非法 manifest 被拒绝（422）", async () => {
    const bad = buildUnsignedPack("1.0.1", { "agent.yaml": "id: hr" });
    (bad.manifest.pack as { id: string }).id = "INVALID ID";
    const res = await admin("/v1/admin/packs", bad);
    expect(res.status).toBe(422);
  });

  it("已发布套装在设备目录可见", async () => {
    const res = await fetch(`${baseUrl}/v1/catalog/packs`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { packs: { pack_id: string; latest_version: string }[] };
    expect(body.packs).toContainEqual(
      expect.objectContaining({ pack_id: "longhub.hr-suite", latest_version: "1.0.0" }),
    );
  });

  it("未授权设备下载被拒绝（403 NOT_ENTITLED）", async () => {
    const res = await fetch(`${baseUrl}/v1/packs/longhub.hr-suite/download`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("NOT_ENTITLED");
  });

  it("授权后可下载，且签名可用云端公钥验证", async () => {
    const granted = await admin("/v1/admin/entitlements", { device_id: deviceId, pack_id: "longhub.hr-suite" });
    expect(granted.status).toBe(201);

    const res = await fetch(`${baseUrl}/v1/packs/longhub.hr-suite/download`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pack: PackFile; digest: string; signature_key_id: string };
    expect(computePackDigest(body.pack.files)).toBe(body.digest);
    expect(body.pack.manifest.integrity.digest).toBe(body.digest);

    const keyRes = await fetch(`${baseUrl}/v1/packs/signing-key`);
    const key = (await keyRes.json()) as { key_id: string; public_key_pem: string };
    expect(key.key_id).toBe(body.signature_key_id);
    expect(verifyPackSignature(body.digest, body.pack.signature, key.public_key_pem)).toBe(true);
  });

  it("releases/check 报告可用升级与吊销", async () => {
    await admin("/v1/admin/packs", buildUnsignedPack("1.1.0", { "agent.yaml": "id: hr-v2" }));
    const check = (body: unknown) =>
      fetch(`${baseUrl}/v1/releases/check`, {
        method: "POST",
        headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const upgraded = await check({
      desktop_version: "1.0.0",
      installed_packs: [{ pack_id: "longhub.hr-suite", version: "1.0.0" }],
    });
    const upgradeBody = (await upgraded.json()) as { packs: { action: string; target_version?: string }[] };
    expect(upgradeBody.packs[0]).toMatchObject({ action: "update_available", target_version: "1.1.0" });

    const revoked = await admin("/v1/admin/packs/longhub.hr-suite/1.0.0/revoke");
    expect(revoked.status).toBe(202);

    const afterRevoke = await check({
      desktop_version: "1.0.0",
      installed_packs: [{ pack_id: "longhub.hr-suite", version: "1.0.0" }],
    });
    const revokeBody = (await afterRevoke.json()) as { packs: { action: string }[] };
    expect(revokeBody.packs[0]).toMatchObject({ action: "revoked" });
  });

  it("吊销版本下载返回 410", async () => {
    const res = await fetch(`${baseUrl}/v1/packs/longhub.hr-suite/download?version=1.0.0`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(res.status).toBe(410);
    expect(((await res.json()) as { code: string }).code).toBe("RELEASE_REVOKED");
  });
});
