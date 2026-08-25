import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLIENT_UPDATE_SCHEMA,
  signClientUpdateManifest,
  type ClientUpdateManifest,
} from "@longhub/pack-schema";
import { parseSkillSigningKey, parseUpdateSigningKey, parseUpdateTrustedPublicKeys } from "../src/index.js";
import { createCloudApiServer, generateSigningKey } from "../src/server.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("客户端更新签名密钥配置", () => {
  it("从 systemd 凭据目录读取两类签名密钥，并拒绝与环境 PEM 混用", () => {
    const root = mkdtempSync(join(tmpdir(), "longhub-signing-credentials-"));
    roots.push(root);
    const updateKey = generateSigningKey("update-systemd");
    const skillKey = generateSigningKey("skill-systemd");
    writeFileSync(join(root, "client-update-private.pem"), updateKey.privateKeyPem, "utf8");
    writeFileSync(join(root, "client-update-public.pem"), updateKey.publicKeyPem, "utf8");
    writeFileSync(join(root, "cloud-skill-private.pem"), skillKey.privateKeyPem, "utf8");
    writeFileSync(join(root, "cloud-skill-public.pem"), skillKey.publicKeyPem, "utf8");

    expect(parseUpdateSigningKey({
      CREDENTIALS_DIRECTORY: root,
      CLIENT_UPDATE_SIGNING_KEY_ID: updateKey.keyId,
    })).toEqual(updateKey);
    expect(parseSkillSigningKey({
      CREDENTIALS_DIRECTORY: root,
      SKILL_SIGNING_KEY_ID: skillKey.keyId,
    })).toEqual(skillKey);
    expect(() => parseUpdateSigningKey({
      CREDENTIALS_DIRECTORY: root,
      CLIENT_UPDATE_SIGNING_KEY_ID: updateKey.keyId,
      CLIENT_UPDATE_SIGNING_PRIVATE_KEY_PEM: updateKey.privateKeyPem,
    })).toThrow("不能同时使用环境 PEM 与 systemd 凭据");
    rmSync(join(root, "cloud-skill-public.pem"));
    expect(() => parseSkillSigningKey({
      CREDENTIALS_DIRECTORY: root,
      SKILL_SIGNING_KEY_ID: skillKey.keyId,
    })).toThrow("systemd 凭据缺失");
  });

  it("Skill 专用密钥必须完整配置，并拒绝与其他用途域复用", () => {
    const skillKey = generateSigningKey("skill-current");
    expect(parseSkillSigningKey({
      SKILL_SIGNING_KEY_ID: skillKey.keyId,
      SKILL_SIGNING_PRIVATE_KEY_PEM: skillKey.privateKeyPem.replaceAll("\n", "\\n"),
      SKILL_SIGNING_PUBLIC_KEY_PEM: skillKey.publicKeyPem.replaceAll("\n", "\\n"),
    })).toEqual(skillKey);
    expect(() => parseSkillSigningKey({ SKILL_SIGNING_KEY_ID: skillKey.keyId })).toThrow("必须同时配置");

    const updateKey = generateSigningKey("update-current");
    expect(() => createCloudApiServer({
      executorUrl: "http://127.0.0.1:1",
      signingKey: skillKey,
      skillSigningKey: skillKey,
      updateSigningKey: updateKey,
    })).toThrow("必须与 Agent Pack 和客户端更新密钥分离");
  });

  it("严格解析历史 Ed25519 公钥并拒绝私钥", () => {
    const oldKey = generateSigningKey("update-old");
    const parsed = parseUpdateTrustedPublicKeys(JSON.stringify({
      [oldKey.keyId]: oldKey.publicKeyPem,
    }));
    expect(parsed.get(oldKey.keyId)).toContain("BEGIN PUBLIC KEY");
    expect(() => parseUpdateTrustedPublicKeys(JSON.stringify({
      [oldKey.keyId]: oldKey.privateKeyPem,
    }))).toThrow("只能配置公钥");
    expect(() => parseUpdateTrustedPublicKeys("[]")).toThrow("对象");
  });

  it("轮换后仍验证历史元数据，并拒绝当前 key ID 绑定到不同公钥", async () => {
    const root = mkdtempSync(join(tmpdir(), "longhub-update-key-rotation-"));
    roots.push(root);
    const packKey = generateSigningKey("pack-current");
    const oldKey = generateSigningKey("update-old");
    const currentKey = generateSigningKey("update-current");
    const manifest: ClientUpdateManifest = {
      schema_version: CLIENT_UPDATE_SCHEMA,
      product_surface: "longhub-manager",
      sequence: 1,
      version: "0.4.0",
      channel: "stable",
      platform: "win32",
      arch: "x64",
      filename: "LongHub-Manager-Setup-0.4.0.exe",
      size: 10,
      sha256: "0".repeat(64),
      url_path: "/downloads/LongHub-Manager-Setup-0.4.0.exe",
      published_at: "2026-07-29T12:00:00.000Z",
      rollback_data_strategy: "snapshot_required",
      rollout: {
        status: "paused",
        basis_points: 0,
        seed: "a".repeat(64),
        updated_at: "2026-07-29T12:00:00.000Z",
      },
    };
    writeFileSync(join(root, "releases.json"), JSON.stringify([{
      manifest,
      signature_key_id: oldKey.keyId,
      signature: signClientUpdateManifest(manifest, oldKey.privateKeyPem),
      uploaded_by: "ops",
      uploaded_at: manifest.published_at,
      rollout_updated_by: "ops",
      rollout_updated_at: manifest.rollout.updated_at,
    }]), "utf8");

    const server = createCloudApiServer({
      executorUrl: "http://127.0.0.1:1",
      signingKey: packKey,
      updateSigningKey: currentKey,
      updateTrustedPublicKeys: new Map([[oldKey.keyId, oldKey.publicKeyPem]]),
      clientReleaseDir: root,
    }).listen(0);
    await once(server, "listening");
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response = await fetch(`${baseUrl}/v1/client-releases/latest`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ release: { signature_key_id: oldKey.keyId } });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

    expect(() => createCloudApiServer({
      executorUrl: "http://127.0.0.1:1",
      signingKey: packKey,
      updateSigningKey: currentKey,
      updateTrustedPublicKeys: new Map([[currentKey.keyId, oldKey.publicKeyPem]]),
      clientReleaseDir: root,
    })).toThrow("key ID 冲突");
  });
});
