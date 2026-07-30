/**
 * 云端分发客户端与 DesktopApp.installPackFromCloud 测试。
 * 用最小 HTTP 桩实现云台契约（注册/签名公钥/下载），不依赖云端实现。
 */
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  computePackDigest,
  signPackDigest,
  type PackFile,
  type PackManifest,
} from "@longhub/pack-schema";
import { CoreClient } from "../src/core-client.js";
import { DesktopApp } from "../src/desktop-app.js";
import { CloudPackClient } from "../src/pack-distribution.js";
import { PackInstaller } from "../src/pack-installer.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const KEY_ID = "longhub-cloud-2026";
const DEVICE_TOKEN = "dt-stub-token";

function buildSignedPack(version: string, inputFiles: Record<string, string>): PackFile {
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
      minDesktopVersion: "1.0.0",
      openclawVersion: "2026.7.1-2",
      profileMigrationVersion: 1,
    },
  };
  const files = {
    "agent-profile.json": JSON.stringify(profile),
    "workspace/IDENTITY.md": "# HR 助理",
    ...inputFiles,
  };
  const manifest: PackManifest = {
    schemaVersion: "longhub/v1",
    pack: { id: "longhub.hr-suite", version, minDesktopVersion: "1.0.0" },
    agentTemplate: { id: "longhub.agent.hr", version: "1.0.0", profilePath: "agent-profile.json" },
    capabilities: [
      { id: "longhub.capability.recruitment", version: "1.0.0", required: true, permissions: [] },
    ],
    runtime: { sdkVersion: "1.0", executionMode: "hybrid" },
    limits: { maxConcurrentSkills: 3, maxTaskDepth: 3 },
    integrity: { algorithm: "sha256", digest: "pending", signatureKeyId: KEY_ID },
  };
  const digest = computePackDigest(manifest, files);
  manifest.integrity.digest = digest;
  return { manifest, files, signature: signPackDigest(digest, privatePem) };
}

const signedPack = buildSignedPack("1.2.0", { "agent.yaml": "id: hr" });
let entitled = true;
let activated = false;

/** 云台契约桩：register / signing-key / download */
function createStubCloud(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && url.pathname === "/v1/devices/register") {
      json(201, { device_id: "dev-stub", device_token: DEVICE_TOKEN });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/packs/signing-key") {
      json(200, { key_id: KEY_ID, public_key_pem: publicPem });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/devices/activation") {
      json(200, { activated, ...(activated ? { expires_at: "2099-01-01T00:00:00.000Z" } : { reason: "ACTIVATION_REQUIRED" }) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/devices/activate") {
      let raw = "";
      req.on("data", (chunk) => { raw += String(chunk); });
      req.on("end", () => {
        const body = JSON.parse(raw) as { code?: string };
        if (body.code !== "LH-ABCD-1234-EF56-7890") {
          json(403, { code: "ACTIVATION_CODE_INVALID", message: "授权码无效" });
          return;
        }
        activated = true;
        json(200, { activated: true });
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/packs/longhub.hr-suite/download") {
      if (req.headers.authorization !== `Bearer ${DEVICE_TOKEN}`) {
        json(401, { code: "UNAUTHORIZED", message: "缺少或无效的设备凭据", request_id: "r", retryable: false });
        return;
      }
      if (!entitled) {
        json(403, { code: "NOT_ENTITLED", message: "设备未获得授权", request_id: "r", retryable: false });
        return;
      }
      json(200, {
        pack: signedPack,
        digest: signedPack.manifest.integrity.digest,
        signature_key_id: KEY_ID,
      });
      return;
    }
    json(404, { code: "NOT_FOUND", message: "未知路由", request_id: "r", retryable: false });
  });
}

let cloud: Server;
let baseUrl: string;
const installRoot = mkdtempSync(join(tmpdir(), "lh-cloud-install-"));

beforeAll(async () => {
  cloud = createStubCloud().listen(0);
  await once(cloud, "listening");
  baseUrl = `http://127.0.0.1:${(cloud.address() as AddressInfo).port}`;
});

afterAll(() => {
  cloud.close();
  rmSync(installRoot, { recursive: true, force: true });
});

function createApp(): DesktopApp {
  const core = new CoreClient({ corePath: "unused.js" });
  return new DesktopApp(core, new PackInstaller(installRoot), {
    trustedKeys: new Map(),
    desktopVersion: "1.0.0",
  });
}

describe("CloudPackClient", () => {
  it("注册设备并获得凭据", async () => {
    const client = new CloudPackClient(baseUrl);
    const credentials = await client.registerDevice({ appVersion: "1.0.0", deviceFingerprint: "fp-1" });
    expect(credentials).toEqual({ deviceId: "dev-stub", deviceToken: DEVICE_TOKEN });
  });

  it("获取签名公钥", async () => {
    const key = await new CloudPackClient(baseUrl).fetchSigningKey();
    expect(key).toEqual({ keyId: KEY_ID, publicKeyPem: publicPem });
  });

  it("查询并核销首次授权码", async () => {
    activated = false;
    const client = new CloudPackClient(baseUrl);
    expect(await client.getActivationStatus(DEVICE_TOKEN)).toMatchObject({ activated: false, reason: "ACTIVATION_REQUIRED" });
    await expect(client.activateDevice(DEVICE_TOKEN, "bad-code")).rejects.toThrow("授权码无效");
    expect(await client.activateDevice(DEVICE_TOKEN, "LH-ABCD-1234-EF56-7890")).toEqual({ activated: true });
    expect(await client.getActivationStatus(DEVICE_TOKEN)).toMatchObject({ activated: true });
  });
});

describe("DesktopApp.installPackFromCloud", () => {
  it("下载→验签→安装成功，云端公钥自动入信任集", async () => {
    entitled = true;
    const result = await createApp().installPackFromCloud({
      baseUrl,
      packId: "longhub.hr-suite",
      deviceToken: DEVICE_TOKEN,
    });
    expect(result).toMatchObject({ ok: true, packId: "longhub.hr-suite", version: "1.2.0" });
  });

  it("未授权时返回 NOT_ENTITLED，不落盘", async () => {
    entitled = false;
    const result = await createApp().installPackFromCloud({
      baseUrl,
      packId: "longhub.hr-suite",
      deviceToken: DEVICE_TOKEN,
    });
    expect(result).toMatchObject({ ok: false, code: "NOT_ENTITLED" });
  });

  it("云端不可达时返回 CLOUD_UNREACHABLE", async () => {
    const result = await createApp().installPackFromCloud({
      baseUrl: "http://127.0.0.1:1",
      packId: "longhub.hr-suite",
      deviceToken: DEVICE_TOKEN,
    });
    expect(result).toMatchObject({ ok: false, code: "CLOUD_UNREACHABLE" });
  });
});
