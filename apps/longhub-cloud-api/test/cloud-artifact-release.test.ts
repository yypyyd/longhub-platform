import { createPublicKey, verify as verifySignature } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/memory-store.js";
import { createCloudApiServer, generateSigningKey } from "../src/server.js";

const ADMIN_TOKEN = "cloud-artifact-release-admin";
const root = mkdtempSync(join(tmpdir(), "longhub-cloud-artifact-release-"));
const pluginDir = join(root, "plugin");
const cliDir = join(root, "cli");
const pluginKey = generateSigningKey("cloud-plugin-test");
const cliKey = generateSigningKey("cloud-cli-test");
const store = new MemoryStore();
let server: ReturnType<typeof createCloudApiServer>;
let baseUrl: string;

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + canonicalize(record[key])).join(",") + "}";
}

function verifyManifest(manifest: Record<string, unknown>, publicKeyPem: string): boolean {
  const unsigned = { ...manifest };
  const signature = unsigned.signature;
  delete unsigned.signature;
  return typeof signature === "string" && verifySignature(
    null,
    Buffer.from(canonicalize(unsigned), "utf8"),
    createPublicKey(publicKeyPem),
    Buffer.from(signature, "base64"),
  );
}

function upload(surface: "cloud-plugin" | "cloud-cli", version: string, filename: string, bytes: Buffer) {
  return fetch(`${baseUrl}/v1/admin/${surface}-releases?version=${version}&filename=${filename}&channel=stable`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/octet-stream" },
    body: bytes,
  });
}

beforeAll(async () => {
  server = createCloudApiServer({
    executorUrl: "http://127.0.0.1:1",
    adminToken: ADMIN_TOKEN,
    store,
    cloudPluginSigningKey: pluginKey,
    cloudCliSigningKey: cliKey,
    cloudPluginReleaseDir: pluginDir,
    cloudCliReleaseDir: cliDir,
  }).listen(0);
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  rmSync(root, { recursive: true, force: true });
});

describe("Cloud Plugin and CLI signed release surfaces", () => {
  const pluginBytes = Buffer.from("signed-plugin-tgz-fixture");
  const cliBytes = Buffer.from("signed-cli-tgz-fixture");

  it("publishes immutable paused versions with separate product surfaces and keys", async () => {
    const pluginUpload = await upload("cloud-plugin", "0.2.0", "longhub-openclaw-cloud-plugin-0.2.0.tgz", pluginBytes);
    const cliUpload = await upload("cloud-cli", "0.1.0", "longhub-cloud-cli-0.1.0.tgz", cliBytes);
    expect(pluginUpload.status).toBe(201);
    expect(cliUpload.status).toBe(201);
    const plugin = (await pluginUpload.json() as { release: { manifest: Record<string, unknown> } }).release.manifest;
    const cli = (await cliUpload.json() as { release: { manifest: Record<string, unknown> } }).release.manifest;
    expect(plugin).toMatchObject({
      schema_version: "longhub/cloud-plugin-release/v1",
      product_surface: "longhub-cloud-plugin",
      version: "0.2.0",
      rollout: { status: "paused", basis_points: 0 },
      signature_key_id: pluginKey.keyId,
    });
    expect(cli).toMatchObject({
      schema_version: "longhub/cloud-cli-release/v1",
      product_surface: "longhub-cloud-cli",
      version: "0.1.0",
      signature_key_id: cliKey.keyId,
    });
    expect(verifyManifest(plugin, pluginKey.publicKeyPem)).toBe(true);
    expect(verifyManifest(cli, cliKey.publicKeyPem)).toBe(true);
    expect(verifyManifest(plugin, cliKey.publicKeyPem)).toBe(false);
    expect((await upload("cloud-plugin", "0.2.0", "longhub-openclaw-cloud-plugin-0.2.0.tgz", Buffer.from("replacement"))).status).toBe(409);
    expect(await (await fetch(`${baseUrl}/v1/cloud-plugin-releases/latest`)).json()).toEqual({ release: null });
  });

  it("activates only the selected surface and serves the signed bytes", async () => {
    const activated = await fetch(`${baseUrl}/v1/admin/cloud-plugin-releases/0.2.0/rollout`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "active", basis_points: 10_000 }),
    });
    expect(activated.status).toBe(200);
    const latest = await fetch(`${baseUrl}/v1/cloud-plugin-releases/latest?channel=stable`);
    const manifest = (await latest.json() as { release: Record<string, unknown> }).release;
    expect(manifest).toMatchObject({ product_surface: "longhub-cloud-plugin", sequence: 2 });
    expect(verifyManifest(manifest, pluginKey.publicKeyPem)).toBe(true);
    expect(await (await fetch(`${baseUrl}/v1/cloud-cli-releases/latest`)).json()).toEqual({ release: null });
    const download = await fetch(`${baseUrl}${String(manifest.url_path)}`);
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(pluginBytes);
  });

  it("withdraws without deleting history and records an audit", async () => {
    const withdrawn = await fetch(`${baseUrl}/v1/admin/cloud-plugin-releases/0.2.0`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(withdrawn.status).toBe(200);
    expect(await (await fetch(`${baseUrl}/v1/cloud-plugin-releases/latest`)).json()).toEqual({ release: null });
    expect((await fetch(`${baseUrl}/v1/cloud-plugin-releases/versions/0.2.0`)).status).toBe(410);
    expect((await fetch(`${baseUrl}/downloads/cloud-plugin/longhub-openclaw-cloud-plugin-0.2.0.tgz`)).status).toBe(410);
    expect((await fetch(`${baseUrl}/v1/admin/cloud-plugin-releases/0.2.0`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    })).status).toBe(409);
    expect((await store.listAudits()).map((audit) => audit.action)).toContain("cloud-plugin.release.withdraw");
  });
});
