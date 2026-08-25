import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface DeviceCredentials {
  deviceId: string;
  deviceToken: string;
}

export interface DeviceCredentialVault {
  read(baseUrl: string): Promise<DeviceCredentials | undefined>;
  write(baseUrl: string, credentials: DeviceCredentials): Promise<void>;
  delete(baseUrl: string): Promise<void>;
}

export interface WindowsCredentialManagerOptions {
  namespace?: string;
}

export const CLOUD_PLUGIN_CREDENTIAL_NAMESPACE = "LongHub Cloud Plugin" as const;
export const DESKTOP_CREDENTIAL_NAMESPACE = "LongHub Desktop" as const;

interface CredentialCommandResult {
  found?: boolean;
  value?: string;
  ok?: boolean;
}

const MAX_OUTPUT_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 15_000;

// The secret is sent through stdin; target names never become shell source.
const WINDOWS_CREDENTIAL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class LongHubCredentialManager {
  private const uint Generic = 1;
  private const uint PersistLocalMachine = 2;
  private const int NotFound = 1168;
  private const int MaxBlob = 5120;
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  private struct CREDENTIAL {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
    public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool CredWrite(ref CREDENTIAL credential, uint flags);
  [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern bool CredDelete(string target, uint type, uint flags);
  [DllImport("advapi32.dll", SetLastError=false)] private static extern void CredFree(IntPtr buffer);
  public static string Read(string target) {
    IntPtr pointer;
    if (!CredRead(target, Generic, 0, out pointer)) {
      var error = Marshal.GetLastWin32Error();
      if (error == NotFound) return null;
      throw new Win32Exception(error, "Credential Manager read failed");
    }
    try {
      var credential = (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL));
      if (credential.CredentialBlobSize == 0) return "";
      var bytes = new byte[credential.CredentialBlobSize];
      Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
      try { return Encoding.UTF8.GetString(bytes); } finally { Array.Clear(bytes, 0, bytes.Length); }
    } finally { CredFree(pointer); }
  }
  public static void Write(string target, string username, string value) {
    var bytes = Encoding.UTF8.GetBytes(value);
    if (bytes.Length > MaxBlob) throw new ArgumentOutOfRangeException("value");
    var blob = IntPtr.Zero;
    try {
      blob = Marshal.AllocHGlobal(bytes.Length); Marshal.Copy(bytes, 0, blob, bytes.Length);
      var credential = new CREDENTIAL { Type=Generic, TargetName=target, CredentialBlobSize=(uint)bytes.Length,
        CredentialBlob=blob, Persist=PersistLocalMachine, UserName=username };
      if (!CredWrite(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Credential Manager write failed");
    } finally {
      Array.Clear(bytes, 0, bytes.Length);
      if (blob != IntPtr.Zero) {
        for (int i = 0; i < bytes.Length; i++) Marshal.WriteByte(blob, i, 0);
        Marshal.FreeHGlobal(blob);
      }
    }
  }
  public static void Delete(string target) {
    if (CredDelete(target, Generic, 0)) return;
    var error = Marshal.GetLastWin32Error();
    if (error != NotFound) throw new Win32Exception(error, "Credential Manager delete failed");
  }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
switch ($request.action) {
  'read' { $value = [LongHubCredentialManager]::Read([string]$request.target); if ($null -eq $value) { @{ found=$false } | ConvertTo-Json -Compress } else { @{ found=$true; value=$value } | ConvertTo-Json -Compress } }
  'write' { [LongHubCredentialManager]::Write([string]$request.target, [string]$request.username, [string]$request.value); @{ ok=$true } | ConvertTo-Json -Compress }
  'delete' { [LongHubCredentialManager]::Delete([string]$request.target); @{ ok=$true } | ConvertTo-Json -Compress }
  default { throw 'Unknown Credential Manager action' }
}
`;

function normalizedBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("设备凭据服务地址无效");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function validNamespace(namespace: string): string {
  const value = namespace.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/u.test(value)) throw new Error("Credential Manager namespace invalid");
  return value;
}

export function credentialTargetFor(
  baseUrl: string,
  namespace: string = CLOUD_PLUGIN_CREDENTIAL_NAMESPACE,
): string {
  const digest = createHash("sha256").update(normalizedBaseUrl(baseUrl), "utf8").digest("hex");
  return `${validNamespace(namespace)}/device/${digest}`;
}

function powershellExecutable(): string {
  const root = process.env.SystemRoot;
  const bundled = root && join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return bundled && existsSync(bundled) ? bundled : "powershell.exe";
}

function execute(action: "read" | "write" | "delete", target: string, username?: string, value?: string): Promise<CredentialCommandResult> {
  if (process.platform !== "win32") return Promise.reject(new Error("UNSUPPORTED_PLATFORM"));
  const encoded = Buffer.from(WINDOWS_CREDENTIAL_SCRIPT, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    const child = spawn(powershellExecutable(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = Buffer.alloc(0); let stderrBytes = 0; let settled = false;
    const fail = (error: Error) => { if (settled) return; settled = true; clearTimeout(timer); reject(error); };
    const timer = setTimeout(() => { child.kill(); fail(new Error("Credential Manager operation timed out")); }, COMMAND_TIMEOUT_MS);
    child.on("error", () => fail(new Error("Credential Manager adapter unavailable")));
    child.stdout.on("data", (chunk: Buffer) => { stdout = Buffer.concat([stdout, chunk]); if (stdout.length > MAX_OUTPUT_BYTES) { child.kill(); fail(new Error("Credential Manager response too large")); } });
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > MAX_OUTPUT_BYTES) { child.kill(); fail(new Error("Credential Manager error too large")); } });
    child.on("close", (code) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (code !== 0) { reject(new Error(`Credential Manager operation failed (${code ?? "unknown"})`)); return; }
      try { resolve(JSON.parse(stdout.toString("utf8").trim()) as CredentialCommandResult); } catch { reject(new Error("Credential Manager response invalid")); } finally { stdout.fill(0); }
    });
    child.stdin.end(JSON.stringify({ action, target, ...(username === undefined ? {} : { username }), ...(value === undefined ? {} : { value }) }), "utf8");
  });
}

function parseCredentials(value: string): DeviceCredentials {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("Credential Manager device record invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Credential Manager device record invalid");
  const candidate = parsed as Partial<DeviceCredentials>;
  if (typeof candidate.deviceId !== "string" || candidate.deviceId.length < 1 || candidate.deviceId.length > 512 ||
      typeof candidate.deviceToken !== "string" || candidate.deviceToken.length < 1 || candidate.deviceToken.length > 4096) {
    throw new Error("Credential Manager device record invalid");
  }
  return { deviceId: candidate.deviceId, deviceToken: candidate.deviceToken };
}

export class WindowsCredentialManager implements DeviceCredentialVault {
  readonly namespace: string;

  constructor(options: WindowsCredentialManagerOptions = {}) {
    this.namespace = validNamespace(options.namespace ?? CLOUD_PLUGIN_CREDENTIAL_NAMESPACE);
  }

  async read(baseUrl: string): Promise<DeviceCredentials | undefined> {
    const result = await execute("read", credentialTargetFor(baseUrl, this.namespace));
    if (!result.found) return undefined;
    if (typeof result.value !== "string") throw new Error("Credential Manager response invalid");
    return parseCredentials(result.value);
  }
  async write(baseUrl: string, credentials: DeviceCredentials): Promise<void> {
    parseCredentials(JSON.stringify(credentials));
    const target = credentialTargetFor(baseUrl, this.namespace);
    const previous = await this.read(baseUrl);
    const result = await execute("write", target, credentials.deviceId, JSON.stringify(credentials));
    if (!result.ok) throw new Error("Credential Manager write was not confirmed");
    try {
      const verified = await this.read(baseUrl);
      if (!verified || verified.deviceId !== credentials.deviceId || verified.deviceToken !== credentials.deviceToken) {
        throw new Error("Credential Manager write verification failed");
      }
    } catch (error) {
      try {
        if (previous) {
          const restored = await execute("write", target, previous.deviceId, JSON.stringify(previous));
          if (!restored.ok) throw new Error("Credential Manager rollback failed");
        } else {
          const removed = await execute("delete", target);
          if (!removed.ok) throw new Error("Credential Manager rollback failed");
        }
      } finally {
        previous && (previous.deviceToken = "");
      }
      throw error;
    }
    previous && (previous.deviceToken = "");
  }
  async delete(baseUrl: string): Promise<void> {
    const result = await execute("delete", credentialTargetFor(baseUrl, this.namespace));
    if (!result.ok) throw new Error("Credential Manager delete was not confirmed");
  }
}
