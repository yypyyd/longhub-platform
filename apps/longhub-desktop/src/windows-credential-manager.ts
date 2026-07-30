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

interface CredentialCommand {
  action: "read" | "write" | "delete";
  target: string;
  username?: string;
  value?: string;
}

interface CredentialCommandResult {
  found?: boolean;
  value?: string;
  ok?: boolean;
}

const MAX_OUTPUT_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 15_000;

// 固定脚本只封装 Win32 Credential API；目标名走参数、秘密只从 stdin 进入，不拼接命令行。
const WINDOWS_CREDENTIAL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class LongHubCredentialManager {
    private const uint CRED_TYPE_GENERIC = 1;
    private const uint CRED_PERSIST_LOCAL_MACHINE = 2;
    private const int ERROR_NOT_FOUND = 1168;
    private const int MAX_BLOB_BYTES = 5120;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct CREDENTIAL {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite([In] ref CREDENTIAL credential, uint flags);

    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredDelete(string target, uint type, uint flags);

    [DllImport("advapi32.dll", SetLastError = false)]
    private static extern void CredFree(IntPtr buffer);

    public static string Read(string target) {
        IntPtr pointer;
        if (!CredRead(target, CRED_TYPE_GENERIC, 0, out pointer)) {
            int error = Marshal.GetLastWin32Error();
            if (error == ERROR_NOT_FOUND) return null;
            throw new Win32Exception(error, "Credential Manager read failed");
        }
        try {
            CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL));
            if (credential.CredentialBlobSize == 0) return "";
            byte[] bytes = new byte[credential.CredentialBlobSize];
            Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
            try { return Encoding.UTF8.GetString(bytes); }
            finally { Array.Clear(bytes, 0, bytes.Length); }
        }
        finally { CredFree(pointer); }
    }

    public static void Write(string target, string username, string value) {
        byte[] bytes = Encoding.UTF8.GetBytes(value);
        if (bytes.Length > MAX_BLOB_BYTES) throw new ArgumentOutOfRangeException("value");
        IntPtr blob = IntPtr.Zero;
        try {
            blob = Marshal.AllocHGlobal(bytes.Length);
            Marshal.Copy(bytes, 0, blob, bytes.Length);
            CREDENTIAL credential = new CREDENTIAL {
                Type = CRED_TYPE_GENERIC,
                TargetName = target,
                CredentialBlobSize = (uint)bytes.Length,
                CredentialBlob = blob,
                Persist = CRED_PERSIST_LOCAL_MACHINE,
                UserName = username
            };
            if (!CredWrite(ref credential, 0)) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Credential Manager write failed");
            }
        }
        finally {
            Array.Clear(bytes, 0, bytes.Length);
            if (blob != IntPtr.Zero) {
                for (int i = 0; i < bytes.Length; i++) Marshal.WriteByte(blob, i, 0);
                Marshal.FreeHGlobal(blob);
            }
        }
    }

    public static void Delete(string target) {
        if (CredDelete(target, CRED_TYPE_GENERIC, 0)) return;
        int error = Marshal.GetLastWin32Error();
        if (error != ERROR_NOT_FOUND) throw new Win32Exception(error, "Credential Manager delete failed");
    }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
switch ($request.action) {
  'read' {
    $value = [LongHubCredentialManager]::Read([string]$request.target)
    if ($null -eq $value) { @{ found = $false } | ConvertTo-Json -Compress }
    else { @{ found = $true; value = $value } | ConvertTo-Json -Compress }
  }
  'write' {
    [LongHubCredentialManager]::Write([string]$request.target, [string]$request.username, [string]$request.value)
    @{ ok = $true } | ConvertTo-Json -Compress
  }
  'delete' {
    [LongHubCredentialManager]::Delete([string]$request.target)
    @{ ok = $true } | ConvertTo-Json -Compress
  }
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

export function credentialTargetFor(baseUrl: string): string {
  const digest = createHash("sha256").update(normalizedBaseUrl(baseUrl), "utf8").digest("hex");
  return `LongHub Desktop/device/${digest}`;
}

function powershellExecutable(): string {
  const systemRoot = process.env.SystemRoot;
  if (systemRoot) {
    const bundled = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (existsSync(bundled)) return bundled;
  }
  return "powershell.exe";
}

function executeCredentialCommand(command: CredentialCommand): Promise<CredentialCommandResult> {
  if (process.platform !== "win32") {
    return Promise.reject(new Error("龙枢设备凭据只支持 Windows Credential Manager"));
  }
  const encoded = Buffer.from(WINDOWS_CREDENTIAL_SCRIPT, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    const child = spawn(powershellExecutable(), [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encoded,
    ], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderrSize = 0;
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error("Windows Credential Manager 操作超时"));
    }, COMMAND_TIMEOUT_MS);
    child.on("error", () => fail(new Error("无法启动 Windows Credential Manager 适配器")));
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > MAX_OUTPUT_BYTES) {
        child.kill();
        fail(new Error("Windows Credential Manager 返回数据过大"));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize > MAX_OUTPUT_BYTES) {
        child.kill();
        fail(new Error("Windows Credential Manager 错误输出过大"));
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Windows Credential Manager 操作失败 (${code ?? "unknown"})`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.toString("utf8").trim()) as CredentialCommandResult);
      } catch {
        reject(new Error("Windows Credential Manager 返回格式无效"));
      } finally {
        stdout.fill(0);
      }
    });
    child.stdin.end(JSON.stringify(command), "utf8");
  });
}

function parseCredentials(value: string): DeviceCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Windows Credential Manager 中的设备凭据格式无效");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Windows Credential Manager 中的设备凭据格式无效");
  const candidate = parsed as Partial<DeviceCredentials>;
  if (
    typeof candidate.deviceId !== "string" || candidate.deviceId.length < 1 || candidate.deviceId.length > 512 ||
    typeof candidate.deviceToken !== "string" || candidate.deviceToken.length < 1 || candidate.deviceToken.length > 4096
  ) {
    throw new Error("Windows Credential Manager 中的设备凭据字段无效");
  }
  return { deviceId: candidate.deviceId, deviceToken: candidate.deviceToken };
}

export class WindowsCredentialManager implements DeviceCredentialVault {
  async read(baseUrl: string): Promise<DeviceCredentials | undefined> {
    const result = await executeCredentialCommand({ action: "read", target: credentialTargetFor(baseUrl) });
    if (!result.found) return undefined;
    if (typeof result.value !== "string") throw new Error("Windows Credential Manager 返回格式无效");
    return parseCredentials(result.value);
  }

  async write(baseUrl: string, credentials: DeviceCredentials): Promise<void> {
    parseCredentials(JSON.stringify(credentials));
    const result = await executeCredentialCommand({
      action: "write",
      target: credentialTargetFor(baseUrl),
      username: credentials.deviceId,
      value: JSON.stringify(credentials),
    });
    if (!result.ok) throw new Error("Windows Credential Manager 未确认写入");
  }

  async delete(baseUrl: string): Promise<void> {
    const result = await executeCredentialCommand({ action: "delete", target: credentialTargetFor(baseUrl) });
    if (!result.ok) throw new Error("Windows Credential Manager 未确认删除");
  }
}
