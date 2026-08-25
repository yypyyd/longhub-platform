#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  WindowsCredentialManager,
  type DeviceCredentials,
  type DeviceCredentialVault,
} from "@longhub/windows-credential";
import {
  PLUGIN_ID,
  TRUSTED_PLUGIN_KEYS,
  artifactSha256,
  verifyPackedPlugin,
  verifyPluginRelease,
  verifyRuntimeInspect,
  type CloudPluginReleaseManifest,
} from "./artifact.js";

export * from "./artifact.js";

export const DEFAULT_CLOUD_API_URL = "https://154-9-26-158.sslip.io" as const;
export const CLOUD_API_URL_ENV = "LONGHUB_CLOUD_API_URL" as const;
const CLI_VERSION = "0.1.2";
const MAX_HTTP_BYTES = 128 * 1024 * 1024;
const MAX_COMMAND_BYTES = 1 << 20;

export interface DeviceMetadata {
  schema_version: 1;
  fingerprint: string;
  device_id?: string;
}

export interface DeviceMetadataStore {
  read(): DeviceMetadata | undefined;
  save(metadata: DeviceMetadata): void;
}

export interface CliDependencies {
  vault: DeviceCredentialVault;
  fetchImpl: typeof fetch;
  metadata: DeviceMetadataStore;
  runOpenClaw(args: readonly string[]): Promise<string>;
  trustedPluginKeys: ReadonlyMap<string, string>;
}

type CliOverrides = Partial<CliDependencies>;

function cloudUrl(value?: string): string {
  const parsed = new URL(value?.trim() || process.env[CLOUD_API_URL_ENV]?.trim() || DEFAULT_CLOUD_API_URL);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Cloud API 地址无效");
  }
  if (parsed.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname)) {
    throw new Error("非回环 Cloud API 地址必须使用 HTTPS");
  }
  return parsed.toString().replace(/\/+$/u, "");
}

function metadataPath(): string {
  if (process.platform !== "win32") throw new Error("UNSUPPORTED_PLATFORM");
  const root = process.env.LOCALAPPDATA?.trim();
  if (!root) throw new Error("LOCALAPPDATA 不可用");
  return join(root, "LongHub", "CloudPlugin", "device.json");
}

function readMetadataFile(): DeviceMetadata | undefined {
  const path = metadataPath();
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("设备元数据格式无效，拒绝覆盖"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("设备元数据格式无效，拒绝覆盖");
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["schema_version", "fingerprint", "device_id"].includes(key)) ||
      value.schema_version !== 1 || typeof value.fingerprint !== "string" || value.fingerprint.length < 8 ||
      (value.device_id !== undefined && typeof value.device_id !== "string")) {
    throw new Error("设备元数据格式无效，拒绝覆盖");
  }
  return {
    schema_version: 1,
    fingerprint: value.fingerprint,
    ...(typeof value.device_id === "string" ? { device_id: value.device_id } : {}),
  };
}

function saveMetadataFile(metadata: DeviceMetadata): void {
  const path = metadataPath();
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(metadata) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

const fileMetadataStore: DeviceMetadataStore = {
  read: readMetadataFile,
  save: saveMetadataFile,
};

export function openClawInvocation(
  args: readonly string[],
  platform = process.platform,
  commandProcessor = process.env.ComSpec,
): { command: string; args: readonly string[] } {
  if (args.length === 0 || args.some((value) => !value || value.length > 32_768 || /[\u0000-\u001f"&|<>^%()]/u.test(value))) {
    throw new Error("OPENCLAW_CLI_ARGUMENT_INVALID");
  }
  if (platform !== "win32") return { command: "openclaw", args };
  const command = commandProcessor?.trim();
  if (!command || !/^[A-Za-z]:\\[^"&|<>^%]*\\cmd\.exe$/iu.test(command)) {
    throw new Error("OPENCLAW_COMMAND_PROCESSOR_INVALID");
  }
  return { command, args: ["/d", "/s", "/c", "openclaw.cmd", ...args] };
}

function defaultRunOpenClaw(args: readonly string[]): Promise<string> {
  const invocation = openClawInvocation(args);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, [...invocation.args], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let settled = false;
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(message));
    };
    child.on("error", () => fail("OPENCLAW_CLI_UNAVAILABLE"));
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutSize += chunk.length;
      if (stdoutSize > MAX_COMMAND_BYTES) fail("OPENCLAW_OUTPUT_TOO_LARGE");
      else stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize > MAX_COMMAND_BYTES) fail("OPENCLAW_OUTPUT_TOO_LARGE");
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error("OPENCLAW_CLI_FAILED"));
        return;
      }
      const output = Buffer.concat(stdout);
      try { resolve(output.toString("utf8").trim()); } finally { output.fill(0); }
    });
  });
}

function dependencies(overrides: CliOverrides = {}): CliDependencies {
  return {
    vault: overrides.vault ?? new WindowsCredentialManager(),
    fetchImpl: overrides.fetchImpl ?? fetch,
    metadata: overrides.metadata ?? fileMetadataStore,
    runOpenClaw: overrides.runOpenClaw ?? defaultRunOpenClaw,
    trustedPluginKeys: overrides.trustedPluginKeys ?? TRUSTED_PLUGIN_KEYS,
  };
}

async function readBoundedResponse(response: Response, maxBytes = MAX_HTTP_BYTES): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes)) throw new Error("Cloud API 响应过大");
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error("Cloud API 响应过大");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("Cloud API 响应过大");
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

async function apiFetch(
  deps: CliDependencies,
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: string }> {
  const response = await deps.fetchImpl(baseUrl + path, { ...init, redirect: "error" });
  const bytes = await readBoundedResponse(response, 1 << 20);
  return { response, body: new TextDecoder().decode(bytes) };
}

function parseJson(body: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new Error("Cloud API 响应格式无效"); }
}

function requireOk(response: Response, body: string): Record<string, unknown> {
  if (!response.ok) {
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(body) as Record<string, unknown>; } catch { /* stable fallback */ }
    const code = typeof parsed.code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/u.test(parsed.code)
      ? parsed.code
      : `CLOUD_API_${response.status}`;
    throw new Error(code);
  }
  return parseJson(body);
}

async function credentialsFor(baseUrl: string, deps: CliDependencies): Promise<DeviceCredentials> {
  const existing = await deps.vault.read(baseUrl);
  if (existing) return existing;
  const metadata = deps.metadata.read() ?? { schema_version: 1 as const, fingerprint: `fp-${randomUUID()}` };
  const registration = await apiFetch(deps, baseUrl, "/v1/devices/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      platform: "openclaw-plugin-windows",
      app_version: CLI_VERSION,
      device_fingerprint: metadata.fingerprint,
      display_name: "LongHub Cloud Plugin",
    }),
  });
  const registered = requireOk(registration.response, registration.body);
  if (typeof registered.device_id !== "string" || typeof registered.device_token !== "string") {
    throw new Error("设备注册响应无效");
  }
  const credentials = { deviceId: registered.device_id, deviceToken: registered.device_token };
  await deps.vault.write(baseUrl, credentials);
  const verified = await deps.vault.read(baseUrl);
  if (!verified || verified.deviceId !== credentials.deviceId || verified.deviceToken !== credentials.deviceToken) {
    throw new Error("设备凭据写入后回读不一致");
  }
  deps.metadata.save({ ...metadata, device_id: credentials.deviceId });
  return verified;
}

export async function pair(baseUrlValue = cloudUrl(), overrides: CliOverrides = {}): Promise<Record<string, unknown>> {
  const baseUrl = cloudUrl(baseUrlValue);
  const deps = dependencies(overrides);
  const credentials = await credentialsFor(baseUrl, deps);
  const challenge = await apiFetch(deps, baseUrl, "/v1/devices/pairing/challenge", {
    method: "POST",
    headers: { Authorization: `Bearer ${credentials.deviceToken}`, "Content-Type": "application/json", Accept: "application/json" },
    body: "{}",
  });
  const parsed = requireOk(challenge.response, challenge.body);
  if (typeof parsed.pairing_code !== "string" || typeof parsed.expires_at !== "string") throw new Error("配对响应无效");
  return {
    device_id: credentials.deviceId,
    pairing_code: parsed.pairing_code,
    expires_at: parsed.expires_at,
    portal_url: `${baseUrl}/`,
  };
}

export async function status(baseUrlValue = cloudUrl(), overrides: CliOverrides = {}): Promise<Record<string, unknown>> {
  const baseUrl = cloudUrl(baseUrlValue);
  const deps = dependencies(overrides);
  const credentials = await deps.vault.read(baseUrl);
  if (!credentials) return { configured: false, service_reachable: false, platform: process.platform };
  try {
    const result = await apiFetch(deps, baseUrl, "/v1/devices/self", {
      headers: { Authorization: `Bearer ${credentials.deviceToken}`, Accept: "application/json" },
    });
    return { configured: true, service_reachable: true, ...requireOk(result.response, result.body) };
  } catch {
    return {
      configured: true,
      service_reachable: false,
      device_id: credentials.deviceId,
      error_code: "CLOUD_API_UNREACHABLE",
    };
  }
}

export async function logout(baseUrlValue = cloudUrl(), overrides: CliOverrides = {}): Promise<void> {
  const baseUrl = cloudUrl(baseUrlValue);
  const deps = dependencies(overrides);
  const credentials = await deps.vault.read(baseUrl);
  if (!credentials) return;
  const result = await apiFetch(deps, baseUrl, "/v1/devices/self/revoke", {
    method: "POST",
    headers: { Authorization: `Bearer ${credentials.deviceToken}`, "Content-Type": "application/json", Accept: "application/json" },
    body: "{}",
  });
  requireOk(result.response, result.body);
  await deps.vault.delete(baseUrl);
  const metadata = deps.metadata.read();
  if (metadata) deps.metadata.save({ schema_version: 1, fingerprint: metadata.fingerprint });
}

function semverParts(version: string): [number, number, number] {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version);
  if (!match) throw new Error("插件版本无效");
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: string, right: string): number {
  const a = semverParts(left);
  const b = semverParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return 0;
}

function runtimeVersion(output: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { throw new Error("OpenClaw runtime inspect response invalid"); }
  const version = parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
    (parsed as Record<string, unknown>).plugin && typeof (parsed as Record<string, unknown>).plugin === "object"
    ? ((parsed as Record<string, unknown>).plugin as Record<string, unknown>).version
    : undefined;
  if (typeof version !== "string") throw new Error("OpenClaw plugin version unavailable");
  semverParts(version);
  verifyRuntimeInspect(output, version);
  return version;
}

interface StagedArtifact {
  directory: string;
  path: string;
  manifest: CloudPluginReleaseManifest;
}

async function fetchManifest(
  deps: CliDependencies,
  baseUrl: string,
  version?: string,
): Promise<CloudPluginReleaseManifest> {
  const endpoint = version === undefined
    ? "/v1/cloud-plugin-releases/latest?channel=stable"
    : `/v1/cloud-plugin-releases/versions/${encodeURIComponent(version)}`;
  const result = await apiFetch(deps, baseUrl, endpoint);
  const body = requireOk(result.response, result.body);
  if (!body.release || typeof body.release !== "object" || Array.isArray(body.release)) {
    throw new Error("当前没有可用的 Cloud Plugin release");
  }
  return body.release as CloudPluginReleaseManifest;
}

async function stageRelease(
  deps: CliDependencies,
  baseUrl: string,
  manifest: CloudPluginReleaseManifest,
): Promise<StagedArtifact> {
  const response = await deps.fetchImpl(baseUrl + manifest.url_path, { redirect: "error" });
  if (!response.ok) throw new Error(`CLOUD_PLUGIN_DOWNLOAD_${response.status}`);
  const bytes = await readBoundedResponse(response);
  verifyPluginRelease(manifest, bytes, deps.trustedPluginKeys);
  const directory = join(tmpdir(), `longhub-cloud-${randomUUID()}`);
  mkdirSync(directory, { recursive: false, mode: 0o700 });
  const temporary = join(directory, `${manifest.filename}.partial`);
  const target = join(directory, manifest.filename);
  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    if (artifactSha256(temporary) !== manifest.sha256 || readFileSync(temporary).byteLength !== manifest.size) {
      throw new Error("Cloud Plugin staged artifact verification failed");
    }
    renameSync(temporary, target);
    await verifyPackedPlugin(target, manifest.version);
    return { directory, path: target, manifest };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  } finally {
    bytes.fill(0);
  }
}

async function inspectPlugin(deps: CliDependencies): Promise<string> {
  return deps.runOpenClaw(["plugins", "inspect", PLUGIN_ID, "--runtime", "--json"]);
}

export async function installOrUpdate(
  baseUrlValue = cloudUrl(),
  force = false,
  overrides: CliOverrides = {},
): Promise<Record<string, unknown>> {
  const baseUrl = cloudUrl(baseUrlValue);
  const deps = dependencies(overrides);
  let currentVersion: string | undefined;
  let rollback: StagedArtifact | undefined;
  let target: StagedArtifact | undefined;

  if (force) {
    currentVersion = runtimeVersion(await inspectPlugin(deps));
  }
  try {
    const targetManifest = await fetchManifest(deps, baseUrl);
    if (targetManifest.rollout.status !== "active" || targetManifest.rollout.basis_points < 10_000) {
      throw new Error("Cloud Plugin release 尚未开放下载");
    }
    if (currentVersion !== undefined) {
      const comparison = compareVersions(targetManifest.version, currentVersion);
      if (comparison < 0) throw new Error("Cloud Plugin release 版本回退被拒绝");
      if (comparison === 0) return { installed: true, updated: false, version: currentVersion };
      rollback = await stageRelease(deps, baseUrl, await fetchManifest(deps, baseUrl, currentVersion));
    }
    target = await stageRelease(deps, baseUrl, targetManifest);
    try {
      await deps.runOpenClaw(["plugins", "install", `npm-pack:${target.path}`, ...(force ? ["--force"] : [])]);
      verifyRuntimeInspect(await inspectPlugin(deps), target.manifest.version);
    } catch (error) {
      if (!rollback) throw error;
      try {
        await deps.runOpenClaw(["plugins", "install", `npm-pack:${rollback.path}`, "--force"]);
        verifyRuntimeInspect(await inspectPlugin(deps), rollback.manifest.version);
      } catch {
        throw new Error("PLUGIN_UPDATE_ROLLBACK_FAILED");
      }
      throw new Error("PLUGIN_UPDATE_FAILED_ROLLED_BACK");
    }
    return {
      installed: true,
      updated: force,
      version: target.manifest.version,
      sha256: target.manifest.sha256,
    };
  } finally {
    if (target) rmSync(target.directory, { recursive: true, force: true });
    if (rollback) rmSync(rollback.directory, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0] ?? "status";
  const urlIndex = argv.indexOf("--cloud-url");
  if (urlIndex >= 0 && (!argv[urlIndex + 1] || argv[urlIndex + 1]!.startsWith("--"))) {
    throw new Error("--cloud-url 缺少 URL");
  }
  const baseUrl = urlIndex >= 0 ? cloudUrl(argv[urlIndex + 1]) : cloudUrl();
  const printJson = (value: unknown): void => {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  };
  if (command === "pair") printJson(await pair(baseUrl));
  else if (command === "status") printJson(await status(baseUrl));
  else if (command === "logout") { await logout(baseUrl); printJson({ logged_out: true }); }
  else if (command === "install") printJson(await installOrUpdate(baseUrl, false));
  else if (command === "update") printJson(await installOrUpdate(baseUrl, true));
  else throw new Error("用法: longhub-cloud pair|status|install|update|logout [--cloud-url URL]");
}

if (process.argv[1] && basename(process.argv[1]).includes("cli")) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "LongHub Cloud CLI 失败"}\n`);
    process.exitCode = 1;
  });
}
