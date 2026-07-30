import { createHash, createPublicKey } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { readExternalRuntimeManifest } from "./openclaw-runtime-manifest.mjs";

const REQUIRED_ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const BRAND_SCHEMA = "longhub/brand-assets/v1";
const UPDATE_TRUST_SCHEMA = "longhub/client-update-trust/v1";

function requiredFile(path, label) {
  if (!existsSync(path)) throw new Error(`${label}不存在: ${path}`);
  return path;
}

function packagedAsarApi() {
  const localRequire = createRequire(import.meta.url);
  const builderPackage = localRequire.resolve("electron-builder/package.json");
  return createRequire(builderPackage)("@electron/asar");
}

function walkFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else files.push(path);
    }
  };
  visit(root);
  return files;
}

function packageNameFromUnpackedPath(relativePath) {
  const segments = relativePath.replaceAll("\\", "/").split("/");
  const index = segments.indexOf("node_modules");
  if (index < 0 || !segments[index + 1]) return undefined;
  return segments[index + 1].startsWith("@")
    ? `${segments[index + 1]}/${segments[index + 2] ?? ""}`
    : segments[index + 1];
}

export function inspectPackagedLayout(packageRoot, resourcesDirectory) {
  const asarPath = requiredFile(join(resourcesDirectory, "app.asar"), "ASAR 应用资源");
  if (existsSync(join(resourcesDirectory, "app"))) throw new Error("启用 ASAR 后不得残留 resources/app 目录");
  const unpackedRoot = requiredFile(`${asarPath}.unpacked`, "ASAR 外置运行时目录");
  const asar = packagedAsarApi();
  const entries = new Set(asar.listPackage(asarPath).map((entry) => entry.replace(/^[/\\]/, "").replaceAll("\\", "/")));
  for (const required of [
    "assets/brand-manifest.json",
    "assets/activation.html",
    "assets/activation.css",
    "assets/activation.js",
    "assets/update-trusted-keys.json",
    "dist/main.js",
    "dist/activation-preload.cjs",
    "dist/activation-window.js",
    "dist/renderer/index.html",
  ]) {
    if (!entries.has(required)) throw new Error(`ASAR 缺少应用资源 ${required}`);
  }
  if (entries.has("dist/activation-preload.js")) {
    throw new Error("ASAR 不得包含会被 sandbox 当作 ESM 处理的旧 activation-preload.js");
  }

  const runtimeManifest = readExternalRuntimeManifest(packageRoot);
  const allowedPackages = new Set(runtimeManifest.packages);
  const unpackedFiles = walkFiles(unpackedRoot);
  let unpackedBytes = 0;
  const actualPackages = new Set();
  for (const path of unpackedFiles) {
    const rel = relative(unpackedRoot, path);
    const packageName = packageNameFromUnpackedPath(rel);
    if (!packageName || !allowedPackages.has(packageName)) {
      throw new Error(`ASAR 外置文件不在 OpenClaw 运行时白名单: ${rel}`);
    }
    actualPackages.add(packageName);
    unpackedBytes += statSync(path).size;
  }
  for (const required of [
    "node_modules/openclaw/openclaw.mjs",
    "node_modules/@longhub/openclaw-bridge/openclaw.plugin.json",
    "node_modules/@longhub/openclaw-bridge/dist/index.js",
  ]) requiredFile(join(unpackedRoot, required), `外置运行时 ${required}`);

  const sourceBrand = verifyBrandAssets(packageRoot);
  const packagedManifest = JSON.parse(asar.extractFile(asarPath, "assets/brand-manifest.json").toString("utf8"));
  if (packagedManifest.schema !== BRAND_SCHEMA || packagedManifest.status !== sourceBrand.status) {
    throw new Error("ASAR 内品牌清单与源码状态不一致");
  }
  for (const format of ["svg", "png", "ico"]) {
    const entry = packagedManifest.assets?.[format];
    const digest = createHash("sha256").update(asar.extractFile(asarPath, entry.path)).digest("hex");
    if (digest !== sourceBrand.assets[format].sha256) throw new Error(`ASAR 内 ${format} 图标与源码不一致`);
  }
  const sourceUpdateTrust = readFileSync(join(packageRoot, "assets", "update-trusted-keys.json"));
  const packagedUpdateTrust = asar.extractFile(asarPath, "assets/update-trusted-keys.json");
  if (!sourceUpdateTrust.equals(packagedUpdateTrust)) {
    throw new Error("ASAR 内更新信任清单与源码不一致");
  }
  return {
    asarPath,
    asarSize: statSync(asarPath).size,
    unpackedRoot,
    unpackedFiles: unpackedFiles.length,
    unpackedBytes,
    allowedPackages: allowedPackages.size,
    actualPackages: actualPackages.size,
  };
}

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("|") === [...expected].sort().join("|");
}

export function verifyClientUpdateTrust(packageRoot, {
  requireApproved = false,
  expectedSigner,
} = {}) {
  const path = requiredFile(join(packageRoot, "assets", "update-trusted-keys.json"), "客户端更新信任清单");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (!exactKeys(manifest, [
    "schema_version", "status", "channel", "expected_signer_subject", "approved_by", "approved_at", "keys",
  ])) throw new Error("客户端更新信任清单格式无效");
  if (
    manifest.schema_version !== UPDATE_TRUST_SCHEMA ||
    !["pending", "approved"].includes(manifest.status) ||
    !["stable", "beta"].includes(manifest.channel) ||
    !Array.isArray(manifest.keys) || manifest.keys.length > 32
  ) throw new Error("客户端更新信任清单字段无效");
  const keyIds = new Set();
  for (const key of manifest.keys) {
    if (!exactKeys(key, ["key_id", "public_key_pem"]) ||
      typeof key.key_id !== "string" || !/^[a-zA-Z0-9._-]{1,128}$/.test(key.key_id) ||
      keyIds.has(key.key_id) || typeof key.public_key_pem !== "string" ||
      !key.public_key_pem.includes("BEGIN PUBLIC KEY") || key.public_key_pem.includes("PRIVATE KEY")) {
      throw new Error("客户端更新信任公钥记录无效");
    }
    keyIds.add(key.key_id);
    let publicKey;
    try {
      publicKey = createPublicKey(key.public_key_pem);
    } catch {
      throw new Error(`客户端更新公钥 PEM 无效: ${key.key_id}`);
    }
    if (publicKey.asymmetricKeyType !== "ed25519") throw new Error(`客户端更新公钥必须是 Ed25519: ${key.key_id}`);
  }
  const validOptionalText = (value) => value === null || (typeof value === "string" && value.trim());
  if (!validOptionalText(manifest.expected_signer_subject) || !validOptionalText(manifest.approved_by) ||
    !(manifest.approved_at === null || (typeof manifest.approved_at === "string" && Number.isFinite(Date.parse(manifest.approved_at))))) {
    throw new Error("客户端更新信任清单审批字段无效");
  }
  const approvedComplete = manifest.keys.length > 0 && typeof manifest.expected_signer_subject === "string" &&
    typeof manifest.approved_by === "string" && typeof manifest.approved_at === "string";
  if (manifest.status === "approved" && !approvedComplete) throw new Error("已审批的客户端更新信任清单字段不完整");
  if (requireApproved && manifest.status !== "approved") throw new Error("正式发布必须预置审批通过的客户端更新信任清单");
  if (requireApproved && manifest.expected_signer_subject.trim().toLowerCase() !== expectedSigner?.trim().toLowerCase()) {
    throw new Error("客户端更新信任清单签名主体与正式发布主体不一致");
  }
  return manifest;
}

function verifyPackagedRuntime(packageRoot, layout, mainExecutable, nodeExecutable) {
  const result = spawnSync(process.execPath, [
    join(packageRoot, "scripts", "packaged-runtime-smoke.mjs"),
    "--node", nodeExecutable,
    "--electron", mainExecutable,
    "--asar", layout.asarPath,
    "--openclaw", join(layout.unpackedRoot, "node_modules", "openclaw", "openclaw.mjs"),
    "--bridge", join(layout.unpackedRoot, "node_modules", "@longhub", "openclaw-bridge"),
  ], { encoding: "utf8", windowsHide: true, timeout: 300_000 });
  if (result.status !== 0) throw new Error(`打包运行时冒烟失败: ${(result.stderr || result.stdout).trim()}`);
  return JSON.parse(result.stdout.trim());
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function resolveAssetPath(packageRoot, assetPath) {
  if (typeof assetPath !== "string" || isAbsolute(assetPath)) throw new Error("品牌资产路径必须是相对路径");
  const resolved = resolve(packageRoot, assetPath);
  const rel = relative(packageRoot, resolved);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`品牌资产路径越界: ${assetPath}`);
  return resolved;
}

function inspectPng(path) {
  const data = readFileSync(path);
  const signature = "89504e470d0a1a0a";
  if (data.length < 24 || data.subarray(0, 8).toString("hex") !== signature) throw new Error("PNG 图标格式无效");
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (width !== 256 || height !== 256) throw new Error(`PNG 图标必须为 256x256，当前为 ${width}x${height}`);
  return { width, height };
}

function inspectIco(path) {
  const data = readFileSync(path);
  if (data.length < 6 || data.readUInt16LE(0) !== 0 || data.readUInt16LE(2) !== 1) {
    throw new Error("ICO 图标格式无效");
  }
  const count = data.readUInt16LE(4);
  const sizes = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16;
    if (offset + 16 > data.length) throw new Error("ICO 图标目录损坏");
    const width = data[offset] === 0 ? 256 : data[offset];
    const height = data[offset + 1] === 0 ? 256 : data[offset + 1];
    if (width === height) sizes.push(width);
  }
  const uniqueSizes = [...new Set(sizes)].sort((a, b) => a - b);
  for (const size of REQUIRED_ICO_SIZES) {
    if (!uniqueSizes.includes(size)) throw new Error(`ICO 图标缺少 ${size}x${size} 图层`);
  }
  return { sizes: uniqueSizes };
}

function inspectSvg(path) {
  const source = readFileSync(path, "utf8");
  if (!/<svg\b/i.test(source) || !/viewBox\s*=\s*["'][^"']+["']/i.test(source)) {
    throw new Error("SVG 图标必须包含 svg 根节点和 viewBox");
  }
  return { hasViewBox: true };
}

export function verifyBrandAssets(packageRoot, { requireApproved = false } = {}) {
  const manifestPath = requiredFile(join(packageRoot, "assets", "brand-manifest.json"), "品牌清单");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.schema !== BRAND_SCHEMA) throw new Error(`不支持的品牌清单: ${manifest.schema ?? "missing"}`);
  if (manifest.display_name !== "龙枢") throw new Error("品牌清单 display_name 必须为龙枢");
  if (requireApproved) {
    if (manifest.status !== "approved") throw new Error("正式发布必须使用 status=approved 的正式图标");
    if (manifest.source === "scripts/build-icon.py") throw new Error("正式发布不能使用临时图标生成脚本作为资产来源");
    if (typeof manifest.approved_by !== "string" || !manifest.approved_by.trim()) throw new Error("正式图标缺少 approved_by");
    if (typeof manifest.approved_at !== "string" || !Number.isFinite(Date.parse(manifest.approved_at))) {
      throw new Error("正式图标缺少有效 approved_at");
    }
  } else if (!new Set(["temporary", "approved"]).has(manifest.status)) {
    throw new Error(`未知品牌资产状态: ${manifest.status}`);
  }

  const formats = ["svg", "png", "ico"];
  const assets = {};
  for (const format of formats) {
    const entry = manifest.assets?.[format];
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")) throw new Error(`品牌清单缺少 ${format} 摘要`);
    const path = requiredFile(resolveAssetPath(packageRoot, entry.path), `${format.toUpperCase()} 品牌资产`);
    const actualHash = sha256File(path);
    if (actualHash !== entry.sha256) throw new Error(`${basename(path)} 与品牌清单摘要不一致`);
    assets[format] = { path, sha256: actualHash };
  }
  inspectSvg(assets.svg.path);
  inspectPng(assets.png.path);
  const ico = inspectIco(assets.ico.path);
  return { status: manifest.status, approvedBy: manifest.approved_by, approvedAt: manifest.approved_at, assets, ico };
}

export function inspectAuthenticode(path) {
  requiredFile(path, "待验签文件");
  if (process.platform !== "win32") throw new Error("Authenticode 验签只能在 Windows 构建机执行");
  const script = [
    "$ErrorActionPreference='Stop'",
    "$OutputEncoding=[System.Text.UTF8Encoding]::new()",
    "[Console]::OutputEncoding=$OutputEncoding",
    "$sig=Get-AuthenticodeSignature -LiteralPath $env:LONGHUB_SIGNATURE_TARGET",
    "[pscustomobject]@{status=[string]$sig.Status;signerSubject=$sig.SignerCertificate.Subject;thumbprint=$sig.SignerCertificate.Thumbprint;timestampSubject=$sig.TimeStamperCertificate.Subject;timestampThumbprint=$sig.TimeStamperCertificate.Thumbprint}|ConvertTo-Json -Compress",
  ].join(";");
  const args = ["-NoProfile", "-NonInteractive", "-Command", script];
  const signatureEnv = { ...process.env, LONGHUB_SIGNATURE_TARGET: resolve(path) };
  let result = spawnSync("pwsh.exe", args, {
    encoding: "utf8",
    windowsHide: true,
    env: signatureEnv,
  });
  if (result.error?.code === "ENOENT") {
    const windowsDir = process.env.WINDIR ?? "C:\\Windows";
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    result = spawnSync("powershell.exe", args, {
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...signatureEnv,
        PSModulePath: [
          join(windowsDir, "System32", "WindowsPowerShell", "v1.0", "Modules"),
          join(programFiles, "WindowsPowerShell", "Modules"),
        ].join(";"),
      },
    });
  }
  if (result.status !== 0) throw new Error(`Authenticode 验签失败: ${(result.stderr || result.stdout).trim()}`);
  return JSON.parse(result.stdout.trim());
}

export function validateSignatureRecord(record, {
  allowUnsigned = false,
  expectedSigner,
  requireTimestamp = false,
  label = "文件",
} = {}) {
  if (allowUnsigned && record.status === "NotSigned") return { ...record, acceptedUnsigned: true };
  if (record.status !== "Valid") throw new Error(`${label} Authenticode 状态不是 Valid: ${record.status}`);
  if (expectedSigner && !String(record.signerSubject ?? "").toLowerCase().includes(expectedSigner.toLowerCase())) {
    throw new Error(`${label}签名主体不匹配，期望包含: ${expectedSigner}`);
  }
  if (requireTimestamp && !record.timestampSubject) throw new Error(`${label}签名缺少可信时间戳`);
  return { ...record, acceptedUnsigned: false };
}

export function isSupportedNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  const atLeast = (wantedMinor, wantedPatch) => minor > wantedMinor || (minor === wantedMinor && patch >= wantedPatch);
  return (major === 22 && atLeast(22, 3)) || (major === 24 && atLeast(15, 0)) ||
    (major === 25 && atLeast(9, 0)) || major > 25;
}

export function verifyRelease({
  packageRoot,
  releaseDir = join(packageRoot, "release"),
  mode = "public",
  expectedSigner = process.env.LONGHUB_EXPECTED_SIGNER_SUBJECT,
  signatureInspector = inspectAuthenticode,
} = {}) {
  if (!packageRoot) throw new Error("缺少 packageRoot");
  if (!new Set(["internal", "public"]).has(mode)) throw new Error(`未知发布模式: ${mode}`);
  if (mode === "public" && !expectedSigner?.trim()) {
    throw new Error("正式发布必须设置 LONGHUB_EXPECTED_SIGNER_SUBJECT");
  }
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const installer = requiredFile(join(releaseDir, `LongHub-Setup-${packageJson.version}.exe`), "安装包");
  const blockMap = requiredFile(`${installer}.blockmap`, "安装包 blockmap");
  const unpacked = requiredFile(join(releaseDir, "win-unpacked"), "解包目录");
  const mainExecutable = requiredFile(join(unpacked, "龙枢.exe"), "龙枢主程序");
  const nodeExecutable = requiredFile(join(unpacked, "resources", "node-runtime", "node.exe"), "内置 Node");
  const resourcesDirectory = requiredFile(join(unpacked, "resources"), "应用 resources 目录");
  const layout = inspectPackagedLayout(packageRoot, resourcesDirectory);

  const sourceBrand = verifyBrandAssets(packageRoot, { requireApproved: mode === "public" });
  const updateTrust = verifyClientUpdateTrust(packageRoot, {
    requireApproved: mode === "public",
    expectedSigner,
  });

  const nodeVersionResult = spawnSync(nodeExecutable, ["--version"], { encoding: "utf8", windowsHide: true });
  if (nodeVersionResult.status !== 0 || !isSupportedNodeVersion(nodeVersionResult.stdout)) {
    throw new Error(`内置 Node 版本不受支持: ${(nodeVersionResult.stdout || nodeVersionResult.stderr).trim()}`);
  }
  const runtimeSmoke = verifyPackagedRuntime(packageRoot, layout, mainExecutable, nodeExecutable);
  const allowUnsigned = mode === "internal";
  const installerSignature = validateSignatureRecord(signatureInspector(installer), {
    allowUnsigned, expectedSigner, requireTimestamp: mode === "public", label: "安装包",
  });
  const executableSignature = validateSignatureRecord(signatureInspector(mainExecutable), {
    allowUnsigned, expectedSigner, requireTimestamp: mode === "public", label: "龙枢主程序",
  });
  const nodeSignature = validateSignatureRecord(signatureInspector(nodeExecutable), {
    allowUnsigned: false, requireTimestamp: true, label: "内置 Node",
  });
  return {
    mode,
    version: packageJson.version,
    installer,
    installerSize: statSync(installer).size,
    installerSha256: sha256File(installer),
    blockMapSha256: sha256File(blockMap),
    nodeVersion: nodeVersionResult.stdout.trim(),
    asar: layout,
    runtimeSmoke,
    brandStatus: sourceBrand.status,
    updateTrustStatus: updateTrust.status,
    signatures: { installer: installerSignature, mainExecutable: executableSignature, node: nodeSignature },
  };
}

function parseCli(argv) {
  const options = { mode: "public" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mode") options.mode = argv[++index];
    else if (arg === "--release-dir") options.releaseDir = resolve(argv[++index]);
    else if (arg === "--expected-signer") options.expectedSigner = argv[++index];
    else throw new Error(`未知参数: ${arg}`);
  }
  return options;
}

function main() {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const options = parseCli(process.argv.slice(2));
  const result = verifyRelease({ packageRoot, ...options });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`发布校验失败: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
