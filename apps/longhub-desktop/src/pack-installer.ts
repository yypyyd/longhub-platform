/**
 * 套装安装器（Updater 原型）：
 * 摘要校验 → 签名校验 → 兼容检查 → 暂存 → 自检 → 原子切换 → 激活。
 * 任一步失败保持旧版本可用；rollback 切回上一个已安装版本。
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  computePackDigest,
  semverGte,
  validatePackManifest,
  verifyPackSignature,
  type PackFile,
} from "@longhub/pack-schema";

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

export type InstallResult =
  | { ok: true; packId: string; version: string; previousVersion?: string }
  | { ok: false; code: string; message: string };

interface PointerFile {
  active?: { version: string };
  previous?: { version: string };
}

export class PackInstaller {
  constructor(private readonly installRoot: string) {}

  install(pack: PackFile, ctx: InstallContext): InstallResult {
    // 1. Manifest 契约校验
    const validated = validatePackManifest(pack.manifest);
    if (!validated.ok) {
      return { ok: false, code: "MANIFEST_INVALID", message: validated.issues.map((i) => `${i.path}: ${i.message}`).join("; ") };
    }
    const manifest = validated.manifest;

    // 2. 摘要校验（防篡改）
    const digest = computePackDigest(pack.files);
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
        if (relPath.includes("..")) throw new Error(`非法文件路径: ${relPath}`);
        const target = join(stagingDir, relPath);
        mkdirSync(join(target, ".."), { recursive: true });
        writeFileSync(target, content, "utf-8");
      }
      writeFileSync(join(stagingDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");

      // 6. 自检：暂存内容摘要复核
      const staged: Record<string, string> = {};
      for (const relPath of Object.keys(pack.files)) {
        staged[relPath] = readFileSync(join(stagingDir, relPath), "utf-8");
      }
      if (computePackDigest(staged) !== digest) {
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
      .filter((entry) => entry.isDirectory())
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
    return this.readPointer(join(this.installRoot, packId)).active?.version;
  }

  private readPointer(packDir: string): PointerFile {
    const file = join(packDir, "current.json");
    if (!existsSync(file)) return {};
    return JSON.parse(readFileSync(file, "utf-8")) as PointerFile;
  }

  private writePointer(packDir: string, pointer: PointerFile): void {
    mkdirSync(packDir, { recursive: true });
    const tmp = join(packDir, "current.json.tmp");
    writeFileSync(tmp, JSON.stringify(pointer, null, 2), "utf-8");
    renameSync(tmp, join(packDir, "current.json"));
  }
}
