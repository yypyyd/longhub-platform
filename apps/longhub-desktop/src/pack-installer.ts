/**
 * 套装安装器（Updater 原型）：
 * 摘要校验 → 签名校验 → 兼容检查 → 暂存 → 自检 → 原子切换 → 激活。
 * 任一步失败保持旧版本可用；rollback 切回上一个已安装版本。
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  computePackDigest,
  packIdSchema,
  semverSchema,
  semverGte,
  validatePackContent,
  verifyPackSignature,
  type PackFile,
  type PackManifest,
} from "@longhub/pack-schema";

const PACK_SIGNATURE_FILE = ".longhub-signature";

export interface InstallContext {
  /** 已信任的发布公钥：keyId → Ed25519 公钥 PEM */
  trustedKeys: ReadonlyMap<string, string>;
  desktopVersion: string;
}

export interface InstalledPack {
  packId: string;
  activeVersion?: string;
  previousVersion?: string;
}

export interface ActivePackContent {
  manifest: PackManifest;
  files: Record<string, string>;
}

export type InstallResult =
  | { ok: true; packId: string; version: string; previousVersion?: string }
  | { ok: false; code: string; message: string };

interface PointerFile {
  active?: { version: string };
  previous?: { version: string };
}

function parsePointerFile(input: unknown): PointerFile {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Pack 指针不是对象");
  const pointer = input as Record<string, unknown>;
  if (Object.keys(pointer).some((key) => key !== "active" && key !== "previous")) {
    throw new Error("Pack 指针包含未知字段");
  }
  const parseVersionRef = (value: unknown, label: string): { version: string } | undefined => {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 指针无效`);
    const ref = value as Record<string, unknown>;
    if (Object.keys(ref).join("|") !== "version" || !semverSchema.safeParse(ref.version).success) {
      throw new Error(`${label} 版本无效`);
    }
    return { version: ref.version as string };
  };
  const active = parseVersionRef(pointer.active, "active");
  const previous = parseVersionRef(pointer.previous, "previous");
  return { ...(active ? { active } : {}), ...(previous ? { previous } : {}) };
}

export class PackInstaller {
  constructor(private readonly installRoot: string) {}

  install(pack: PackFile, ctx: InstallContext): InstallResult {
    // 1. Manifest、Agent Profile、引用文件与权限映射联合校验
    const validated = validatePackContent(pack.manifest, pack.files);
    if (!validated.ok) {
      return {
        ok: false,
        code: "PACK_CONTENT_INVALID",
        message: validated.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
      };
    }
    const manifest = validated.manifest;

    // 2. 摘要校验（同时覆盖 Manifest 与所有 Pack 文件）
    const digest = computePackDigest(manifest, pack.files);
    if (digest !== manifest.integrity.digest) {
      return { ok: false, code: "DIGEST_MISMATCH", message: "制品摘要与 manifest 不一致，疑似被篡改" };
    }

    // 3. 签名校验（防伪造）
    const publicKey = ctx.trustedKeys.get(manifest.integrity.signatureKeyId);
    if (!publicKey) {
      return { ok: false, code: "UNKNOWN_SIGNING_KEY", message: `不信任的签名密钥: ${manifest.integrity.signatureKeyId}` };
    }
    if (!verifyPackSignature(digest, pack.signature, publicKey)) {
      return { ok: false, code: "SIGNATURE_INVALID", message: "签名校验失败" };
    }

    // 4. 兼容检查
    if (!semverGte(ctx.desktopVersion, manifest.pack.minDesktopVersion)) {
      return {
        ok: false,
        code: "DESKTOP_INCOMPATIBLE",
        message: `需要 Desktop >= ${manifest.pack.minDesktopVersion}，当前 ${ctx.desktopVersion}`,
      };
    }

    const packDir = join(this.installRoot, manifest.pack.id);
    const versionDir = join(packDir, `v${manifest.pack.version}`);
    const stagingDir = join(packDir, `.staging-${manifest.pack.version}`);

    try {
      // 5. 暂存目录写入
      rmSync(stagingDir, { recursive: true, force: true });
      mkdirSync(stagingDir, { recursive: true });
      for (const [relPath, content] of Object.entries(pack.files)) {
        const target = join(stagingDir, relPath);
        mkdirSync(join(target, ".."), { recursive: true });
        writeFileSync(target, content, "utf-8");
      }
      writeFileSync(join(stagingDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
      writeFileSync(join(stagingDir, PACK_SIGNATURE_FILE), pack.signature, { encoding: "utf-8", mode: 0o600 });

      // 6. 自检：暂存内容摘要复核
      const staged: Record<string, string> = {};
      for (const relPath of Object.keys(pack.files)) {
        staged[relPath] = readFileSync(join(stagingDir, relPath), "utf-8");
      }
      if (computePackDigest(manifest, staged) !== digest) {
        throw new Error("暂存自检失败");
      }

      // 7. 原子切换：目录 rename + 指针更新
      rmSync(versionDir, { recursive: true, force: true });
      renameSync(stagingDir, versionDir);
      const pointer = this.readPointer(packDir);
      const previousVersion = pointer.active?.version;
      this.writePointer(packDir, {
        active: { version: manifest.pack.version },
        ...(previousVersion && previousVersion !== manifest.pack.version
          ? { previous: { version: previousVersion } }
          : {}),
      });
      return { ok: true, packId: manifest.pack.id, version: manifest.pack.version, previousVersion };
    } catch (err) {
      rmSync(stagingDir, { recursive: true, force: true });
      return { ok: false, code: "INSTALL_FAILED", message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 回滚到上一个已安装版本；旧版本目录始终保留 */
  rollback(packId: string): InstallResult {
    if (!packIdSchema.safeParse(packId).success) {
      return { ok: false, code: "PACK_ID_INVALID", message: `Pack ID 无效: ${packId}` };
    }
    const packDir = join(this.installRoot, packId);
    const pointer = this.readPointer(packDir);
    if (!pointer.previous) {
      return { ok: false, code: "NO_PREVIOUS_VERSION", message: "没有可回滚的版本" };
    }
    if (!existsSync(join(packDir, `v${pointer.previous.version}`))) {
      return { ok: false, code: "PREVIOUS_VERSION_MISSING", message: "上一版本制品缺失" };
    }
    const current = pointer.active;
    this.writePointer(packDir, {
      active: pointer.previous,
      ...(current ? { previous: current } : {}),
    });
    return { ok: true, packId, version: pointer.previous.version, previousVersion: current?.version };
  }

  listInstalled(): InstalledPack[] {
    if (!existsSync(this.installRoot)) return [];
    return readdirSync(this.installRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && packIdSchema.safeParse(entry.name).success)
      .map((entry) => {
        const pointer = this.readPointer(join(this.installRoot, entry.name));
        return {
          packId: entry.name,
          activeVersion: pointer.active?.version,
          previousVersion: pointer.previous?.version,
        };
      });
  }

  activeVersion(packId: string): string | undefined {
    if (!packIdSchema.safeParse(packId).success) return undefined;
    return this.readPointer(join(this.installRoot, packId)).active?.version;
  }

  /**
   * 全新制品已落盘但运行时激活失败时，清除仅属于该版本的 active 指针以允许安全重试。
   * 版本目录保留用于诊断；有 previous 的升级由调用方使用 rollback 恢复旧 active。
   */
  clearActiveVersion(packId: string, expectedVersion: string): void {
    if (!packIdSchema.safeParse(packId).success || !semverSchema.safeParse(expectedVersion).success) {
      throw new Error("Pack ID 或版本无效");
    }
    const packDir = join(this.installRoot, packId);
    const pointer = this.readPointer(packDir);
    if (pointer.active?.version !== expectedVersion) {
      throw new Error(`Pack active 已变化，拒绝清除: ${packId}@${expectedVersion}`);
    }
    this.writePointer(packDir, {});
  }

  /**
   * 从原子 active 指针读取当前制品，并重新校验 Manifest/Profile/引用文件和摘要。
   * 运行时不会直接信任 userData 下可被篡改的 Profile 或 workspace 模板。
   */
  readActivePack(packId: string): ActivePackContent | undefined {
    if (!packIdSchema.safeParse(packId).success) throw new Error(`Pack ID 无效: ${packId}`);
    const packDir = join(this.installRoot, packId);
    const activeVersion = this.readPointer(packDir).active?.version;
    if (!activeVersion) return undefined;
    if (!semverSchema.safeParse(activeVersion).success) throw new Error(`Pack active 版本无效: ${packId}`);

    const versionDir = join(packDir, `v${activeVersion}`);
    const manifestPath = join(versionDir, "manifest.json");
    if (!existsSync(manifestPath)) throw new Error(`Pack active Manifest 缺失: ${packId}@${activeVersion}`);

    const files: Record<string, string> = {};
    let fileCount = 0;
    let totalBytes = 0;
    const readDirectory = (directory: string, prefix = ""): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error(`Pack active 制品包含符号链接: ${packId}`);
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const absolutePath = join(directory, entry.name);
        if (entry.isDirectory()) {
          readDirectory(absolutePath, relativePath);
          continue;
        }
        if (!entry.isFile()) throw new Error(`Pack active 制品包含不支持的文件类型: ${relativePath}`);
        if (relativePath === "manifest.json" || relativePath === PACK_SIGNATURE_FILE) continue;
        fileCount += 1;
        if (fileCount > 4096) throw new Error(`Pack active 文件数量超限: ${packId}`);
        const content = readFileSync(absolutePath, "utf8");
        totalBytes += Buffer.byteLength(content, "utf8");
        if (totalBytes > 32 * 1024 * 1024) throw new Error(`Pack active 文件总大小超限: ${packId}`);
        files[relativePath] = content;
      }
    };
    readDirectory(versionDir);

    let manifestInput: unknown;
    try {
      manifestInput = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      throw new Error(`Pack active Manifest 无法读取: ${error instanceof Error ? error.message : String(error)}`);
    }
    const validated = validatePackContent(manifestInput, files);
    if (!validated.ok) {
      throw new Error(
        `Pack active 内容无效: ${validated.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
      );
    }
    if (validated.manifest.pack.id !== packId || validated.manifest.pack.version !== activeVersion) {
      throw new Error(`Pack active 指针与 Manifest 不一致: ${packId}@${activeVersion}`);
    }
    if (computePackDigest(validated.manifest, files) !== validated.manifest.integrity.digest) {
      throw new Error(`Pack active 摘要不一致: ${packId}@${activeVersion}`);
    }
    return { manifest: validated.manifest, files };
  }

  /**
   * 手工重新启用前从安装目录重新读取内容，并复验安装时保存的 Ed25519 签名。
   * 旧版未保存签名的安装会安全失败，必须从云端重新下载安装后才能启用。
   */
  verifyActivePack(packId: string, ctx: InstallContext): ActivePackContent {
    const active = this.readActivePack(packId);
    if (!active) throw new Error(`Pack 尚未安装或没有 active 版本: ${packId}`);
    if (!semverGte(ctx.desktopVersion, active.manifest.pack.minDesktopVersion)) {
      throw new Error(`Pack ${packId} 与当前 Desktop ${ctx.desktopVersion} 不兼容`);
    }
    const publicKey = ctx.trustedKeys.get(active.manifest.integrity.signatureKeyId);
    if (!publicKey) throw new Error(`不信任的签名密钥: ${active.manifest.integrity.signatureKeyId}`);
    const versionDir = join(this.installRoot, packId, `v${active.manifest.pack.version}`);
    const signaturePath = join(versionDir, PACK_SIGNATURE_FILE);
    if (!existsSync(signaturePath)) throw new Error(`Pack ${packId} 缺少可复验签名，请重新安装`);
    const signature = readFileSync(signaturePath, "utf8").trim();
    if (!verifyPackSignature(active.manifest.integrity.digest, signature, publicKey)) {
      throw new Error(`Pack ${packId}@${active.manifest.pack.version} 签名复验失败`);
    }
    return active;
  }

  private readPointer(packDir: string): PointerFile {
    const file = join(packDir, "current.json");
    if (!existsSync(file)) return {};
    return parsePointerFile(JSON.parse(readFileSync(file, "utf-8")) as unknown);
  }

  private writePointer(packDir: string, pointer: PointerFile): void {
    mkdirSync(packDir, { recursive: true });
    const tmp = join(packDir, "current.json.tmp");
    writeFileSync(tmp, JSON.stringify(pointer, null, 2), "utf-8");
    renameSync(tmp, join(packDir, "current.json"));
  }
}
