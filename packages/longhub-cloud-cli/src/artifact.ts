import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { readFileSync } from "node:fs";
import { t as readTar } from "tar";

export const PLUGIN_PACKAGE_NAME = "@longhub/openclaw-cloud-plugin" as const;
export const PLUGIN_ID = "longhub-cloud-skill" as const;
export const PLUGIN_TOOL_NAME = "longhub_cloud_skill" as const;
export const PLUGIN_RELEASE_SCHEMA = "longhub/cloud-plugin-release/v1" as const;

// This is the production build-time trust anchor. The online signing-key
// endpoint is never consulted by verification or allowed to replace it.
export const TRUSTED_PLUGIN_KEYS: ReadonlyMap<string, string> = new Map([
  ["cloud-plugin-2026-08", "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAqo68RyPSiCm0klaJPdPkPti99TH6TquXCbfVWV9Nsec=\n-----END PUBLIC KEY-----\n"],
]);

export interface CloudPluginReleaseManifest {
  schema_version: typeof PLUGIN_RELEASE_SCHEMA;
  product_surface: "longhub-cloud-plugin";
  sequence: number;
  version: string;
  channel: "stable" | "beta";
  platform: "win32";
  arch: "x64";
  filename: string;
  size: number;
  sha256: string;
  url_path: string;
  published_at: string;
  compatibility: { openclaw_version: string; node: string };
  rollout: { status: "active" | "paused"; basis_points: number; seed: string; updated_at: string };
  signature_key_id: string;
  signature: string;
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + canonicalize(record[key])).join(",") + "}";
}

export function verifyPluginRelease(
  manifest: CloudPluginReleaseManifest,
  artifact: Uint8Array,
  trustedKeys: ReadonlyMap<string, string> = TRUSTED_PLUGIN_KEYS,
): void {
  if (manifest.schema_version !== PLUGIN_RELEASE_SCHEMA || manifest.product_surface !== "longhub-cloud-plugin" ||
      manifest.platform !== "win32" || manifest.arch !== "x64") {
    throw new Error("Cloud Plugin release identity invalid");
  }
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(manifest.version) ||
      manifest.filename !== `longhub-openclaw-cloud-plugin-${manifest.version}.tgz`) {
    throw new Error("Cloud Plugin release filename/version invalid");
  }
  if (!Number.isSafeInteger(manifest.sequence) || manifest.sequence < 1 ||
      !Number.isSafeInteger(manifest.size) || manifest.size < 1 || manifest.size !== artifact.byteLength) {
    throw new Error("Cloud Plugin release size mismatch");
  }
  if (!/^\/downloads\/cloud-plugin\/longhub-openclaw-cloud-plugin-[^/]+\.tgz$/u.test(manifest.url_path)) {
    throw new Error("Cloud Plugin release download path invalid");
  }
  const digest = createHash("sha256").update(artifact).digest("hex");
  if (!/^[a-f0-9]{64}$/u.test(manifest.sha256) || digest !== manifest.sha256) {
    throw new Error("Cloud Plugin release SHA-256 mismatch");
  }
  if (!manifest.compatibility || typeof manifest.compatibility.openclaw_version !== "string" ||
      typeof manifest.compatibility.node !== "string") {
    throw new Error("Cloud Plugin compatibility invalid");
  }
  const publicPem = trustedKeys.get(manifest.signature_key_id);
  if (!publicPem || !/^[A-Za-z0-9+/]{86}==$/u.test(manifest.signature)) {
    throw new Error("Cloud Plugin release signature key is not trusted");
  }
  const unsigned = { ...manifest } as Record<string, unknown>;
  delete unsigned.signature;
  if (!verifySignature(
    null,
    Buffer.from(canonicalize(unsigned), "utf8"),
    createPublicKey(publicPem),
    Buffer.from(manifest.signature, "base64"),
  )) {
    throw new Error("Cloud Plugin release signature invalid");
  }
}

export async function verifyPackedPlugin(file: string, expectedVersion: string): Promise<void> {
  const chunks: Buffer[] = [];
  let packageJsonEntries = 0;
  await readTar({
    file,
    strict: true,
    onReadEntry(entry) {
      const normalized = entry.path.replaceAll("\\", "/");
      if (normalized !== "package/package.json") {
        entry.resume();
        return;
      }
      packageJsonEntries += 1;
      if (entry.size > 64 * 1024) throw new Error("Cloud Plugin package metadata too large");
      entry.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    },
  });
  if (packageJsonEntries !== 1) throw new Error("Cloud Plugin package metadata missing or duplicated");
  const bytes = Buffer.concat(chunks);
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } finally { bytes.fill(0); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Cloud Plugin package metadata invalid");
  const metadata = parsed as Record<string, unknown>;
  if (metadata.name !== PLUGIN_PACKAGE_NAME || metadata.version !== expectedVersion) {
    throw new Error("Cloud Plugin package name/version mismatch");
  }
}

export function verifyRuntimeInspect(output: string, expectedVersion: string): void {
  if (Buffer.byteLength(output, "utf8") > 1 << 20) throw new Error("OpenClaw runtime inspect response too large");
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { throw new Error("OpenClaw runtime inspect response invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("OpenClaw runtime inspect response invalid");
  const root = parsed as Record<string, unknown>;
  if (!root.plugin || typeof root.plugin !== "object" || Array.isArray(root.plugin)) throw new Error("OpenClaw plugin inspect contract invalid");
  const plugin = root.plugin as Record<string, unknown>;
  if (plugin.id !== PLUGIN_ID || plugin.version !== expectedVersion || plugin.status !== "loaded" ||
      plugin.origin !== "global" || plugin.packageName !== PLUGIN_PACKAGE_NAME) {
    throw new Error("OpenClaw plugin identity/version/runtime invalid");
  }
  if (!root.install || typeof root.install !== "object" || Array.isArray(root.install)) {
    throw new Error("OpenClaw plugin installation provenance missing");
  }
  const install = root.install as Record<string, unknown>;
  if (install.source !== "npm" || install.version !== expectedVersion ||
      install.resolvedName !== PLUGIN_PACKAGE_NAME || install.resolvedVersion !== expectedVersion ||
      install.artifactKind !== "npm-pack" || install.artifactFormat !== "tgz" ||
      install.npmTarballName !== `longhub-openclaw-cloud-plugin-${expectedVersion}.tgz`) {
    throw new Error("OpenClaw plugin installation provenance invalid");
  }
  if (!Array.isArray(root.tools) || root.tools.length !== 1 || !root.tools[0] ||
      typeof root.tools[0] !== "object" || Array.isArray(root.tools[0]) ||
      !Array.isArray((root.tools[0] as Record<string, unknown>).names) ||
      ((root.tools[0] as Record<string, unknown>).names as unknown[]).length !== 1 ||
      ((root.tools[0] as Record<string, unknown>).names as unknown[])[0] !== PLUGIN_TOOL_NAME) {
    throw new Error("OpenClaw plugin tool contract invalid");
  }
  if (Array.isArray(root.diagnostics) && root.diagnostics.length > 0) throw new Error("OpenClaw plugin runtime diagnostics are not clean");
}

export function artifactSha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
