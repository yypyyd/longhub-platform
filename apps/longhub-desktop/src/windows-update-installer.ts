import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";

export interface WindowsInstallerSignature {
  status: string;
  signerSubject: string | null;
  signerThumbprint: string | null;
  timestampSubject: string | null;
}

function validWindowsInstallerFile(path: string): boolean {
  if (!existsSync(path) || !/^LongHub-Setup-\d+\.\d+\.\d+\.exe$/.test(basename(path))) return false;
  if (realpathSync.native(path).toLowerCase() !== resolve(path).toLowerCase()) return false;
  const stat = lstatSync(path);
  return stat.isFile() && !stat.isSymbolicLink();
}

/** 纯校验层，供运行时 PowerShell 结果和单元测试共同使用。 */
export function validateWindowsInstallerSignature(
  signature: WindowsInstallerSignature,
  expectedSignerSubject: string,
): WindowsInstallerSignature {
  if (!expectedSignerSubject.trim()) throw new Error("客户端更新安装器预期签名主体为空");
  if (signature.status !== "Valid") throw new Error(`客户端更新安装器签名状态无效: ${signature.status}`);
  if (
    !signature.signerSubject ||
    !signature.signerSubject.toLowerCase().includes(expectedSignerSubject.trim().toLowerCase())
  ) throw new Error("客户端更新安装器签名主体不匹配");
  if (!signature.timestampSubject) throw new Error("客户端更新安装器缺少可信时间戳");
  return signature;
}

/** 使用 Windows 原生 Authenticode 验证下载的安装器；路径通过环境变量传递，不拼入脚本。 */
export function verifyWindowsInstallerAuthenticode(
  path: string,
  expectedSignerSubject: string,
): WindowsInstallerSignature {
  if (process.platform !== "win32") throw new Error("客户端安装器 Authenticode 只能在 Windows 验证");
  if (!validWindowsInstallerFile(path)) {
    throw new Error("客户端更新安装器路径无效");
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    "$OutputEncoding=[System.Text.UTF8Encoding]::new()",
    "[Console]::OutputEncoding=$OutputEncoding",
    "$sig=Get-AuthenticodeSignature -LiteralPath $env:LONGHUB_UPDATE_INSTALLER",
    "[pscustomobject]@{status=[string]$sig.Status;signerSubject=$sig.SignerCertificate.Subject;" +
      "signerThumbprint=$sig.SignerCertificate.Thumbprint;timestampSubject=$sig.TimeStamperCertificate.Subject}" +
      "|ConvertTo-Json -Compress",
  ].join(";");
  const args = ["-NoProfile", "-NonInteractive", "-Command", script];
  const env = { ...process.env, LONGHUB_UPDATE_INSTALLER: resolve(path) };
  let result = spawnSync("pwsh.exe", args, { encoding: "utf8", windowsHide: true, env, timeout: 30_000 });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    result = spawnSync("powershell.exe", args, { encoding: "utf8", windowsHide: true, env, timeout: 30_000 });
  }
  if (result.status !== 0) throw new Error("客户端更新安装器 Authenticode 验证失败");
  let signature: WindowsInstallerSignature;
  try {
    signature = JSON.parse(result.stdout.trim()) as WindowsInstallerSignature;
  } catch {
    throw new Error("客户端更新安装器签名响应无效");
  }
  return validateWindowsInstallerSignature(signature, expectedSignerSubject);
}

/** 启动 electron-builder NSIS 静默安装器；调用方须先完成摘要、签名、快照与运行时停机。 */
export function launchWindowsUpdateInstaller(path: string): Promise<void> {
  if (process.platform !== "win32") throw new Error("客户端更新安装器只能在 Windows 启动");
  if (!validWindowsInstallerFile(path)) {
    throw new Error("客户端更新安装器路径无效");
  }
  return new Promise((resolveLaunch, reject) => {
    const child = spawn(resolve(path), ["/S"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => reject(new Error("客户端更新安装器启动失败")));
    child.once("spawn", () => {
      child.unref();
      resolveLaunch();
    });
  });
}
