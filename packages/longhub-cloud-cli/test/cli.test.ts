import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { c as createTar } from "tar";
import { describe, expect, it, vi } from "vitest";
import {
  installOrUpdate,
  logout,
  openClawInvocation,
  pair,
  verifyPluginRelease,
  type CloudPluginReleaseManifest,
  type DeviceMetadata,
} from "../src/cli.js";
import type { DeviceCredentials, DeviceCredentialVault } from "@longhub/windows-credential";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + canonical(record[key])).join(",") + "}";
}

function manifest(
  bytes: Uint8Array,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  version = "0.2.0",
): CloudPluginReleaseManifest {
  const base = {
    schema_version: "longhub/cloud-plugin-release/v1" as const,
    product_surface: "longhub-cloud-plugin" as const,
    sequence: 1,
    version,
    channel: "stable" as const,
    platform: "win32" as const,
    arch: "x64" as const,
    filename: `longhub-openclaw-cloud-plugin-${version}.tgz`,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    url_path: `/downloads/cloud-plugin/longhub-openclaw-cloud-plugin-${version}.tgz`,
    published_at: new Date().toISOString(),
    compatibility: { openclaw_version: "2026.7.1-2", node: ">=20" },
    rollout: {
      status: "active" as const,
      basis_points: 10_000,
      seed: "b".repeat(64),
      updated_at: new Date().toISOString(),
    },
    signature_key_id: "fixture",
  };
  const signature = sign(null, Buffer.from(canonical(base)), privateKey).toString("base64");
  return { ...base, signature };
}

function runtimeInspect(version: string): string {
  return JSON.stringify({
    plugin: {
      id: "longhub-cloud-skill",
      version,
      status: "loaded",
      origin: "global",
      packageName: "@longhub/openclaw-cloud-plugin",
    },
    install: {
      source: "npm",
      version,
      resolvedName: "@longhub/openclaw-cloud-plugin",
      resolvedVersion: version,
      artifactKind: "npm-pack",
      artifactFormat: "tgz",
      npmTarballName: `longhub-openclaw-cloud-plugin-${version}.tgz`,
    },
    tools: [{ names: ["longhub_cloud_skill"], optional: true }],
    diagnostics: [],
  });
}

async function createPluginTgz(root: string, version: string): Promise<Buffer> {
  const versionRoot = join(root, version);
  const packageDirectory = join(versionRoot, "package");
  const artifactPath = join(root, `longhub-openclaw-cloud-plugin-${version}.tgz`);
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({
    name: "@longhub/openclaw-cloud-plugin",
    version,
  }));
  await createTar({ cwd: versionRoot, file: artifactPath, gzip: true, portable: true, noMtime: true }, ["package"]);
  return readFileSync(artifactPath);
}

describe("Cloud CLI release verification", () => {
  it("uses the Windows command processor without enabling shell parsing", () => {
    expect(openClawInvocation(
      ["plugins", "inspect", "longhub-cloud-skill", "--runtime", "--json"],
      "win32",
      "C:\\Windows\\System32\\cmd.exe",
    )).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "openclaw.cmd", "plugins", "inspect", "longhub-cloud-skill", "--runtime", "--json"],
    });
    expect(() => openClawInvocation(
      ["plugins", "install", "npm-pack:C:\\safe&unexpected.tgz"],
      "win32",
      "C:\\Windows\\System32\\cmd.exe",
    )).toThrow("OPENCLAW_CLI_ARGUMENT_INVALID");
  });

  it("accepts a signed, byte-matched plugin artifact", () => {
    const keys = generateKeyPairSync("ed25519");
    const bytes = new TextEncoder().encode("fixture tgz");
    const signed = manifest(bytes, keys.privateKey);
    const publicPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(() => verifyPluginRelease(signed, bytes, new Map([["fixture", publicPem]]))).not.toThrow();
  });

  it("rejects tampered bytes and unknown signing keys", () => {
    const keys = generateKeyPairSync("ed25519");
    const bytes = new TextEncoder().encode("fixture tgz");
    const signed = manifest(bytes, keys.privateKey);
    const publicPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(() => verifyPluginRelease(signed, new TextEncoder().encode("fixturX tgz"), new Map([["fixture", publicPem]]))).toThrow(/SHA-256/);
    expect(() => verifyPluginRelease(signed, bytes, new Map())).toThrow(/trusted/);
  });

  it("pairs through register/challenge without exposing the device token", async () => {
    let stored: DeviceCredentials | undefined;
    let metadata: DeviceMetadata | undefined;
    const vault: DeviceCredentialVault = {
      read: vi.fn(async () => stored),
      write: vi.fn(async (_url, value) => { stored = { ...value }; }),
      delete: vi.fn(async () => { stored = undefined; }),
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/devices/register")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ platform: "openclaw-plugin-windows" });
        return new Response(JSON.stringify({ device_id: "device-cli", device_token: "secret-device-token" }), { status: 201 });
      }
      expect(init?.headers).toMatchObject({ Authorization: "Bearer secret-device-token" });
      return new Response(JSON.stringify({ pairing_code: "ABCDEFGHJKLM", expires_at: "2026-08-17T04:00:00Z" }), { status: 201 });
    });
    const result = await pair("http://127.0.0.1:41080", {
      vault,
      fetchImpl: fetchImpl as typeof fetch,
      metadata: {
        read: () => metadata,
        save: (value) => { metadata = value; },
      },
    });
    expect(result).toMatchObject({ device_id: "device-cli", pairing_code: "ABCDEFGHJKLM" });
    expect(JSON.stringify(result)).not.toContain("secret-device-token");
    expect(metadata).toMatchObject({ device_id: "device-cli" });
  });

  it("keeps the local credential when server-side revoke fails", async () => {
    const credentials = { deviceId: "device-cli", deviceToken: "secret-device-token" };
    const deleteCredential = vi.fn(async () => undefined);
    const vault: DeviceCredentialVault = {
      read: vi.fn(async () => credentials),
      write: vi.fn(async () => undefined),
      delete: deleteCredential,
    };
    await expect(logout("http://127.0.0.1:41080", {
      vault,
      fetchImpl: vi.fn(async () => { throw new Error("offline"); }) as typeof fetch,
      metadata: { read: () => undefined, save: vi.fn() },
    })).rejects.toThrow("offline");
    expect(deleteCredential).not.toHaveBeenCalled();
  });

  it("checks the packed package and runtime contract after install", async () => {
    const root = join(tmpdir(), `longhub-cloud-cli-test-${randomUUID()}`);
    const packageDirectory = join(root, "package");
    const artifactPath = join(root, "fixture.tgz");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({
      name: "@longhub/openclaw-cloud-plugin",
      version: "0.2.0",
    }));
    try {
      await createTar({ cwd: root, file: artifactPath, gzip: true, portable: true, noMtime: true }, ["package"]);
      const bytes = readFileSync(artifactPath);
      const keys = generateKeyPairSync("ed25519");
      const signed = manifest(bytes, keys.privateKey);
      const publicPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
      const runOpenClaw = vi.fn(async (args: readonly string[]) => {
        if (args[1] === "inspect") {
          return runtimeInspect("0.2.0");
        }
        return "";
      });
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/latest?")) return new Response(JSON.stringify({ release: signed }), { status: 200 });
        return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.byteLength) } });
      });
      await expect(installOrUpdate("http://127.0.0.1:41080", false, {
        fetchImpl: fetchImpl as typeof fetch,
        runOpenClaw,
        trustedPluginKeys: new Map([["fixture", publicPem]]),
      })).resolves.toMatchObject({ installed: true, version: "0.2.0" });
      expect(runOpenClaw).toHaveBeenCalledTimes(2);
      expect(runOpenClaw.mock.calls[0]?.[0]).toEqual(expect.arrayContaining([
        "plugins",
        "install",
        expect.stringMatching(/^npm-pack:.*longhub-openclaw-cloud-plugin-0\.2\.0\.tgz$/u),
      ]));
      expect(runOpenClaw.mock.calls[1]?.[0]).toEqual([
        "plugins", "inspect", "longhub-cloud-skill", "--runtime", "--json",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { rollbackFails: false, expectedCode: "PLUGIN_UPDATE_FAILED_ROLLED_BACK", expectedInstalls: 2 },
    { rollbackFails: true, expectedCode: "PLUGIN_UPDATE_ROLLBACK_FAILED", expectedInstalls: 2 },
  ])("reports the transactional update result when rollback failure is $rollbackFails", async ({
    rollbackFails,
    expectedCode,
    expectedInstalls,
  }) => {
    const root = join(tmpdir(), `longhub-cloud-cli-update-${randomUUID()}`);
    mkdirSync(root, { recursive: true });
    try {
      const [oldBytes, targetBytes] = await Promise.all([
        createPluginTgz(root, "0.1.0"),
        createPluginTgz(root, "0.2.0"),
      ]);
      const keys = generateKeyPairSync("ed25519");
      const oldManifest = manifest(oldBytes, keys.privateKey, "0.1.0");
      const targetManifest = manifest(targetBytes, keys.privateKey, "0.2.0");
      const publicPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/latest?")) {
          return new Response(JSON.stringify({ release: targetManifest }), { status: 200 });
        }
        if (url.includes("/versions/0.1.0")) {
          return new Response(JSON.stringify({ release: oldManifest }), { status: 200 });
        }
        const bytes = url.endsWith(targetManifest.filename) ? targetBytes : oldBytes;
        return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.byteLength) } });
      });
      const installCalls: (readonly string[])[] = [];
      const runOpenClaw = vi.fn(async (args: readonly string[]) => {
        if (args[1] === "inspect") return runtimeInspect("0.1.0");
        installCalls.push(args);
        if (String(args[2]).includes("0.2.0") || rollbackFails) throw new Error("fixture install failure");
        return "";
      });

      await expect(installOrUpdate("http://127.0.0.1:41080", true, {
        fetchImpl: fetchImpl as typeof fetch,
        runOpenClaw,
        trustedPluginKeys: new Map([["fixture", publicPem]]),
      })).rejects.toThrow(expectedCode);
      expect(installCalls).toHaveLength(expectedInstalls);
      expect(installCalls[0]).toEqual(expect.arrayContaining(["--force"]));
      expect(installCalls[1]).toEqual(expect.arrayContaining(["--force"]));
      expect(String(installCalls[1]?.[2])).toContain("longhub-openclaw-cloud-plugin-0.1.0.tgz");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
