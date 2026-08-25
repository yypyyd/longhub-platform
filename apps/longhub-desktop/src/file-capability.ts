import { createHash, randomUUID } from "node:crypto";
import {
  constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync,
  rmSync, statSync,
} from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";

const HANDLE = /^[0-9a-f-]{36}$/;
const CONTEXT_ID = /^[A-Za-z0-9._:@/-]{1,512}$/;
const ALLOWED_EXTENSIONS = new Set([".txt", ".md", ".json", ".csv"]);

export interface FileCapabilityContext {
  readonly agentId: string;
  readonly sessionId: string;
}

interface FileHandleRecord {
  readonly handleId: string;
  readonly agentId: string;
  readonly sessionId: string;
  readonly filename: string;
  readonly stagedPath: string;
  readonly size: number;
  readonly sha256: string;
  readonly expiresAt: string;
  consumed: boolean;
}

export interface FileCapabilityOptions {
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

function assertContext(context: FileCapabilityContext): void {
  if (!CONTEXT_ID.test(context.agentId) || !CONTEXT_ID.test(context.sessionId)) throw new Error("附件上下文无效");
}

function contained(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Electron Main 在原生选择器返回路径后立即复制，Renderer 之后只能持有一次性 opaque handle。 */
export class FileCapabilityStore {
  private readonly handles = new Map<string, FileHandleRecord>();
  private readonly maxFiles: number;
  private readonly maxFileBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly root: string, options: FileCapabilityOptions = {}) {
    this.maxFiles = options.maxFiles ?? 10;
    this.maxFileBytes = options.maxFileBytes ?? 10 * 1024 * 1024;
    this.ttlMs = options.ttlMs ?? 30 * 60_000;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.maxFiles) || this.maxFiles < 1 || this.maxFiles > 20 ||
      !Number.isSafeInteger(this.maxFileBytes) || this.maxFileBytes < 1_024 || this.maxFileBytes > 25 * 1024 * 1024 ||
      !Number.isSafeInteger(this.ttlMs) || this.ttlMs < 60_000 || this.ttlMs > 24 * 60 * 60_000) {
      throw new Error("附件策略无效");
    }
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("附件暂存根目录无效");
  }

  issueFromTrustedPicker(paths: readonly string[], context: FileCapabilityContext): readonly Omit<FileHandleRecord, "stagedPath">[] {
    assertContext(context);
    if (paths.length < 1 || paths.length > this.maxFiles) throw new Error("附件数量超过上限");
    const issued: FileHandleRecord[] = [];
    try {
      for (const source of paths) {
        if (!isAbsolute(source) || source.includes("\0")) throw new Error("附件路径无效");
        const sourceStat = lstatSync(source);
        if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size > this.maxFileBytes) {
          throw new Error("附件类型或大小无效");
        }
        if (resolve(realpathSync.native(source)).toLowerCase() !== resolve(source).toLowerCase()) {
          throw new Error("附件不能是链接或重解析路径");
        }
        const extension = extname(source).toLowerCase();
        if (!ALLOWED_EXTENSIONS.has(extension)) throw new Error("附件类型不受支持");
        const handleId = randomUUID();
        const directory = join(this.root, handleId);
        mkdirSync(directory, { mode: 0o700 });
        const filename = basename(source).replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 180) || `attachment${extension}`;
        const stagedPath = join(directory, filename);
        if (!contained(this.root, stagedPath)) throw new Error("附件暂存路径越界");
        copyFileSync(source, stagedPath, constants.COPYFILE_EXCL);
        const copied = statSync(stagedPath);
        if (!copied.isFile() || copied.size !== sourceStat.size || copied.size > this.maxFileBytes) throw new Error("附件复制不完整");
        const sha256 = createHash("sha256").update(readFileSync(stagedPath)).digest("hex");
        const record: FileHandleRecord = {
          handleId, agentId: context.agentId, sessionId: context.sessionId, filename, stagedPath,
          size: copied.size, sha256, expiresAt: new Date(this.now() + this.ttlMs).toISOString(), consumed: false,
        };
        this.handles.set(handleId, record);
        issued.push(record);
      }
      return issued.map(({ stagedPath: _hidden, ...record }) => ({ ...record }));
    } catch (error) {
      for (const item of issued) this.cancel(item.handleId, context);
      throw error;
    }
  }

  consume(handleId: string, context: FileCapabilityContext): Readonly<FileHandleRecord> {
    assertContext(context);
    if (!HANDLE.test(handleId)) throw new Error("附件句柄无效");
    const record = this.handles.get(handleId);
    if (!record || record.agentId !== context.agentId || record.sessionId !== context.sessionId ||
      record.consumed || Date.parse(record.expiresAt) < this.now()) throw new Error("附件句柄无效、已过期或已使用");
    const stat = lstatSync(record.stagedPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== record.size ||
      createHash("sha256").update(readFileSync(record.stagedPath)).digest("hex") !== record.sha256) {
      throw new Error("附件暂存内容已变化");
    }
    record.consumed = true;
    return { ...record };
  }

  cancel(handleId: string, context: FileCapabilityContext): void {
    assertContext(context);
    const record = this.handles.get(handleId);
    if (!record || record.agentId !== context.agentId || record.sessionId !== context.sessionId) return;
    this.handles.delete(handleId);
    const directory = resolve(this.root, record.handleId);
    if (contained(this.root, directory) && existsSync(directory) && !lstatSync(directory).isSymbolicLink()) {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  cleanupExpired(): number {
    let removed = 0;
    for (const record of [...this.handles.values()]) {
      if (Date.parse(record.expiresAt) >= this.now()) continue;
      this.cancel(record.handleId, { agentId: record.agentId, sessionId: record.sessionId });
      removed += 1;
    }
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!HANDLE.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink() || this.handles.has(entry.name)) continue;
      const path = join(this.root, entry.name);
      if (contained(this.root, path)) rmSync(path, { recursive: true, force: true });
    }
    return removed;
  }
}

export interface ParsedAttachment {
  readonly kind: "text" | "json" | "csv" | "markdown";
  readonly text: string;
  readonly truncated: boolean;
}

/** 隔离 worker 与单元测试共用的严格解析函数；压缩/二进制/伪扩展名一律拒绝。 */
export function parseStrictAttachment(path: string, maxBytes = 5 * 1024 * 1024, maxChars = 200_000): ParsedAttachment {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxChars) || maxChars < 1) {
    throw new Error("解析资源上限无效");
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error("解析文件类型或大小无效");
  const data = readFileSync(path);
  if (data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw new Error("不接受压缩容器或压缩炸弹");
  if (data.includes(0)) throw new Error("不接受二进制或伪装文本文件");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new Error("附件不是有效 UTF-8 文本");
  }
  const extension = extname(path).toLowerCase();
  const kind = extension === ".json" ? "json" : extension === ".csv" ? "csv" : extension === ".md" ? "markdown" : "text";
  if (kind === "json") {
    const value = JSON.parse(text) as unknown;
    if (value === null || typeof value !== "object") throw new Error("JSON 附件必须是对象或数组");
  }
  return { kind, text: text.slice(0, maxChars), truncated: text.length > maxChars };
}
