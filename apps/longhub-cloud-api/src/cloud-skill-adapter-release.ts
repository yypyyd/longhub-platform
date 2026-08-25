import {
  CLOUD_SKILL_ADAPTER_REQUIRED_FILES,
  MAX_CLOUD_SKILL_ADAPTER_FILE_BYTES,
  computeCloudSkillAdapterFileDigest,
  containsCloudSkillAdapterPrivateFields,
  signCloudSkillAdapterManifest,
  toPublicCloudSkillAdapterManifest,
  verifyCloudSkillAdapterFileDigests,
  verifyCloudSkillAdapterSignature,
  type CloudSkillAdapterFileContent,
  type CloudSkillAdapterManifest,
} from "@longhub/cloud-skill-adapter";

/** The HTTP release envelope is intentionally bounded below the Manager limit. */
export const CLOUD_SKILL_ADAPTER_RELEASE_MAX_BYTES = 2 * 1024 * 1024;
/** A single public declaration must remain small even when the other files are empty. */
export const CLOUD_SKILL_ADAPTER_RELEASE_MAX_FILE_BYTES = Math.min(MAX_CLOUD_SKILL_ADAPTER_FILE_BYTES, 1 * 1024 * 1024);
const MAX_SCHEMA_BYTES = 256 * 1024;
const MAX_SCHEMA_DEPTH = 8;
const MAX_SCHEMA_NODES = 256;

const PUBLIC_SKILL_BODY = "This file is a thin declaration only. Runtime execution stays in LongHub Cloud.";
const PRIVATE_TEXT_PATTERN = /(?:prompt|system\s*message|business\s*rule|implementation|credential|secret|token|api[_-]?key|endpoint|executor|workflow|install|command|shell|script|mcp|plugin)/i;

export type CloudSkillAdapterReleaseFiles = Readonly<Record<string, string>>;

export interface PreparedCloudSkillAdapterRelease {
  manifest: CloudSkillAdapterManifest;
  /** Canonical standard Base64, keyed by the three manifest-declared paths. */
  files: Record<string, string>;
  digest: string;
  signature_key_id: string;
}

/**
 * Structural input for validating a record read from MemoryStore or
 * PostgreSQL. The runtime check must not trust the store's TypeScript cast.
 */
export interface StoredCloudSkillAdapterReleaseIntegrityInput {
  skill_id: unknown;
  version: unknown;
  manifest: unknown;
  files: unknown;
  digest: unknown;
  signature_key_id: unknown;
  min_manager_version: unknown;
  openclaw_version: unknown;
}

export class CloudSkillAdapterReleaseValidationError extends Error {
  readonly code = "CLOUD_SKILL_ADAPTER_RELEASE_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "CloudSkillAdapterReleaseValidationError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeCanonicalBase64(value: unknown, path: string): Uint8Array {
  if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(CLOUD_SKILL_ADAPTER_RELEASE_MAX_FILE_BYTES * 4 / 3) + 4) {
    throw new CloudSkillAdapterReleaseValidationError(`${path} 编码无效`);
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(value, "base64");
  } catch {
    throw new CloudSkillAdapterReleaseValidationError(`${path} 编码无效`);
  }
  if (bytes.length <= 0 || bytes.length > CLOUD_SKILL_ADAPTER_RELEASE_MAX_FILE_BYTES ||
    Buffer.from(bytes).toString("base64") !== value) {
    throw new CloudSkillAdapterReleaseValidationError(`${path} 大小或 Base64 编码无效`);
  }
  return bytes;
}

function validateSkillMarkdown(bytes: Uint8Array): void {
  if (bytes.byteLength > 16 * 1024) {
    throw new CloudSkillAdapterReleaseValidationError("SKILL.md 超过公开说明大小限制");
  }
  const text = Buffer.from(bytes).toString("utf8").replaceAll("\r\n", "\n");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(text);
  if (!match) throw new CloudSkillAdapterReleaseValidationError("SKILL.md 必须使用固定 YAML frontmatter 模板");
  const fields = new Map<string, string>();
  for (const line of match[1]!.split("\n")) {
    const field = /^(name|description):[ \t]*(.+)$/u.exec(line);
    if (!field || fields.has(field[1]!)) {
      throw new CloudSkillAdapterReleaseValidationError("SKILL.md 只允许 name 和 description frontmatter");
    }
    fields.set(field[1]!, field[2]!.trim());
  }
  const name = fields.get("name");
  const description = fields.get("description");
  if (!name || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(name)) {
    throw new CloudSkillAdapterReleaseValidationError("SKILL.md name 必须是安全短标识");
  }
  if (!description || description.length > 160 || PRIVATE_TEXT_PATTERN.test(description) ||
    /(?:https?|ftp|file):\/\/|(?:javascript|data):/iu.test(description)) {
    throw new CloudSkillAdapterReleaseValidationError("SKILL.md description 只能是无实现细节的短说明");
  }
  if (match[2]!.trim() !== PUBLIC_SKILL_BODY) {
    throw new CloudSkillAdapterReleaseValidationError("SKILL.md 必须使用 LongHub 公开说明模板");
  }
}

function validateJsonSchema(bytes: Uint8Array, path: string): void {
  if (bytes.byteLength > MAX_SCHEMA_BYTES) {
    throw new CloudSkillAdapterReleaseValidationError(`${path} 超过 Schema 大小限制`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new CloudSkillAdapterReleaseValidationError(`${path} 不是合法 JSON`);
  }
  if (!isPlainObject(parsed)) {
    throw new CloudSkillAdapterReleaseValidationError(`${path} 必须是 JSON Schema 对象`);
  }
  const serialized = JSON.stringify(parsed);
  if (/(?:https?|ftp|file):\/\/|(?:javascript|data):/iu.test(serialized)) {
    throw new CloudSkillAdapterReleaseValidationError(`${path} 不得包含 URL`);
  }
  const allowedKeys = new Set([
    "type", "properties", "required", "additionalProperties", "items",
    "minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum",
    "enum", "oneOf",
  ]);
  const primitiveTypes = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
  let nodes = 0;
  const visit = (value: unknown, currentPath: string, depth: number): void => {
    if (!isPlainObject(value)) throw new CloudSkillAdapterReleaseValidationError(`${currentPath} 必须是对象`);
    if (depth > MAX_SCHEMA_DEPTH || ++nodes > MAX_SCHEMA_NODES) {
      throw new CloudSkillAdapterReleaseValidationError(`${path} Schema 嵌套过深或节点过多`);
    }
    if (containsCloudSkillAdapterPrivateFields(value)) {
      throw new CloudSkillAdapterReleaseValidationError(`${currentPath} 包含私密字段`);
    }
    for (const key of Object.keys(value)) {
      if (!allowedKeys.has(key)) {
        throw new CloudSkillAdapterReleaseValidationError(`${currentPath}.${key} 不是允许的 Schema 字段`);
      }
    }
    if (value.type !== undefined && (typeof value.type !== "string" || !primitiveTypes.has(value.type))) {
      throw new CloudSkillAdapterReleaseValidationError(`${currentPath}.type 无效`);
    }
    const type = value.type as string | undefined;
    if (value.properties !== undefined) {
      if (!isPlainObject(value.properties)) {
        throw new CloudSkillAdapterReleaseValidationError(`${currentPath}.properties 必须是对象`);
      }
      const entries = Object.entries(value.properties);
      if (entries.length > 64) throw new CloudSkillAdapterReleaseValidationError(`${currentPath}.properties 过多`);
      for (const [property, child] of entries) {
        if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(property)) {
          throw new CloudSkillAdapterReleaseValidationError(`${currentPath}.properties 包含不安全字段名`);
        }
        visit(child, `${currentPath}.properties.${property}`, depth + 1);
      }
      if (type !== undefined && type !== "object") {
        throw new CloudSkillAdapterReleaseValidationError(`${currentPath}.properties 只能用于 object`);
      }
    }
    if (value.required !== undefined) {
      if (!Array.isArray(value.required) || value.required.length > 64 ||
        value.required.some((entry) => typeof entry !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(entry)) ||
        new Set(value.required).size !== value.required.length) {
        throw new CloudSkillAdapterReleaseValidationError(`${currentPath}.required 无效`);
      }
      const properties = isPlainObject(value.properties) ? new Set(Object.keys(value.properties)) : new Set<string>();
      if (value.required.some((entry) => !properties.has(entry as string))) {
        throw new CloudSkillAdapterReleaseValidationError(`${currentPath}.required 必须引用 properties 字段`);
      }
    }
    if (value.additionalProperties !== undefined && typeof value.additionalProperties !== "boolean") {
      throw new CloudSkillAdapterReleaseValidationError(`${currentPath}.additionalProperties 只能是布尔值`);
    }
    if (value.items !== undefined) visit(value.items, `${currentPath}.items`, depth + 1);
    if (value.oneOf !== undefined) {
      if (!Array.isArray(value.oneOf) || value.oneOf.length < 1 || value.oneOf.length > 8) {
        throw new CloudSkillAdapterReleaseValidationError(`${currentPath}.oneOf 无效`);
      }
      value.oneOf.forEach((entry, index) => visit(entry, `${currentPath}.oneOf[${index}]`, depth + 1));
    }
    for (const key of ["minItems", "maxItems", "minLength", "maxLength"]) {
      const bound = value[key];
      if (bound !== undefined && (!Number.isSafeInteger(bound) || (bound as number) < 0 || (bound as number) > 1_000_000)) {
        throw new CloudSkillAdapterReleaseValidationError(`${currentPath}.${key} 无效`);
      }
    }
    const minItems = value.minItems;
    const maxItems = value.maxItems;
    const minLength = value.minLength;
    const maxLength = value.maxLength;
    if (typeof minItems === "number" && typeof maxItems === "number" && minItems > maxItems) {
      throw new CloudSkillAdapterReleaseValidationError(`${currentPath}.items 范围无效`);
    }
    if (typeof minLength === "number" && typeof maxLength === "number" && minLength > maxLength) {
      throw new CloudSkillAdapterReleaseValidationError(`${currentPath}.length 范围无效`);
    }
    for (const key of ["minimum", "maximum"]) {
      const bound = value[key];
      if (bound !== undefined && (typeof bound !== "number" || !Number.isFinite(bound) || Math.abs(bound) > Number.MAX_SAFE_INTEGER)) {
        throw new CloudSkillAdapterReleaseValidationError(`${currentPath}.${key} 无效`);
      }
    }
    const minimum = value.minimum;
    const maximum = value.maximum;
    if (typeof minimum === "number" && typeof maximum === "number" && minimum > maximum) {
      throw new CloudSkillAdapterReleaseValidationError(`${currentPath}.number 范围无效`);
    }
    if (value.enum !== undefined) {
      if (!Array.isArray(value.enum) || value.enum.length === 0 || value.enum.length > 32 ||
        value.enum.some((entry) => entry !== null &&
          ((typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") ||
            (typeof entry === "string" && (entry.length > 128 || PRIVATE_TEXT_PATTERN.test(entry) ||
              /(?:https?|ftp|file):\/\/|(?:javascript|data):/iu.test(entry)))))) {
        throw new CloudSkillAdapterReleaseValidationError(`${currentPath}.enum 无效`);
      }
    }
  };
  visit(parsed, path, 0);
  if (parsed.type !== "object") throw new CloudSkillAdapterReleaseValidationError(`${path} 根 Schema 必须是 object`);
}

function fileContentMap(files: CloudSkillAdapterReleaseFiles): Map<string, CloudSkillAdapterFileContent> {
  const decoded = new Map<string, Uint8Array>();
  const expected = new Set<string>(CLOUD_SKILL_ADAPTER_REQUIRED_FILES);
  const keys = Object.keys(files);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    throw new CloudSkillAdapterReleaseValidationError("适配器必须恰好包含三个固定文件");
  }
  let total = 0;
  for (const path of CLOUD_SKILL_ADAPTER_REQUIRED_FILES) {
    const bytes = decodeCanonicalBase64(files[path], `files.${path}`);
    total += bytes.byteLength;
    if (total > CLOUD_SKILL_ADAPTER_RELEASE_MAX_BYTES) {
      throw new CloudSkillAdapterReleaseValidationError("适配器制品超过大小限制");
    }
    decoded.set(path, bytes);
  }
  const skill = decoded.get("SKILL.md");
  const input = decoded.get("schemas/input.json");
  const output = decoded.get("schemas/output.json");
  if (!skill || !input || !output) throw new CloudSkillAdapterReleaseValidationError("适配器文件不完整");
  validateSkillMarkdown(skill);
  validateJsonSchema(input, "schemas/input.json");
  validateJsonSchema(output, "schemas/output.json");
  return decoded;
}

/**
 * Validate a publisher payload, bind all file digests, and sign the public
 * manifest with the server-owned adapter key. No caller-provided integrity
 * field is trusted.
 */
export function prepareCloudSkillAdapterRelease(
  input: { manifest?: unknown; files?: unknown },
  signingKey: { keyId: string; privateKeyPem: string },
): PreparedCloudSkillAdapterRelease {
  if (!isPlainObject(input.manifest) || !isPlainObject(input.files)) {
    throw new CloudSkillAdapterReleaseValidationError("manifest 和 files 必填");
  }
  const decoded = fileContentMap(input.files as CloudSkillAdapterReleaseFiles);
  const candidate = {
    ...input.manifest,
    integrity: {
      algorithm: "sha256",
      digest: "0".repeat(64),
      signature_key_id: signingKey.keyId,
      signature: "A".repeat(86) + "==",
    },
  };
  let manifest: CloudSkillAdapterManifest;
  try {
    manifest = toPublicCloudSkillAdapterManifest(candidate);
  } catch (error) {
    throw new CloudSkillAdapterReleaseValidationError(error instanceof Error ? error.message : "manifest 无效");
  }
  if (!verifyCloudSkillAdapterFileDigests(manifest, decoded)) {
    throw new CloudSkillAdapterReleaseValidationError("适配器文件摘要或大小与 manifest 不匹配");
  }
  let signed: CloudSkillAdapterManifest;
  try {
    signed = signCloudSkillAdapterManifest(manifest, signingKey.privateKeyPem);
  } catch {
    throw new CloudSkillAdapterReleaseValidationError("适配器签名失败");
  }
  const outputFiles: Record<string, string> = {};
  for (const path of CLOUD_SKILL_ADAPTER_REQUIRED_FILES) {
    outputFiles[path] = Buffer.from(decoded.get(path)!).toString("base64");
  }
  return {
    manifest: signed,
    files: outputFiles,
    digest: signed.integrity.digest,
    signature_key_id: signed.integrity.signature_key_id,
  };
}

/**
 * Re-validate an immutable release at the distribution boundary. Publishing
 * validates the input once, but a read-time check is still required to turn a
 * corrupt or mismatched store row into a stable 503 instead of returning a
 * self-inconsistent adapter that the Manager must reject later.
 */
export function verifyStoredCloudSkillAdapterRelease(
  release: StoredCloudSkillAdapterReleaseIntegrityInput,
  signingKey: { keyId: string; publicKeyPem: string },
): boolean {
  try {
    const manifest = toPublicCloudSkillAdapterManifest(release.manifest);
    if (
      release.skill_id !== manifest.skill_id ||
      release.version !== manifest.version ||
      release.digest !== manifest.integrity.digest ||
      release.signature_key_id !== manifest.integrity.signature_key_id ||
      manifest.integrity.signature_key_id !== signingKey.keyId
    ) {
      return false;
    }
    if (release.min_manager_version !== manifest.compatibility.manager_min_version) {
      return false;
    }
    if (release.openclaw_version !== manifest.compatibility.openclaw_version) {
      return false;
    }
    const decoded = fileContentMap(release.files as CloudSkillAdapterReleaseFiles);
    return verifyCloudSkillAdapterFileDigests(manifest, decoded) &&
      verifyCloudSkillAdapterSignature(manifest, signingKey.publicKeyPem);
  } catch {
    return false;
  }
}

export function adapterReleaseFileBytes(record: { files: CloudSkillAdapterReleaseFiles }): Map<string, Uint8Array> {
  const decoded = fileContentMap(record.files);
  return new Map([...decoded.entries()].map(([path, content]) => [
    path,
    typeof content === "string" ? new Uint8Array(Buffer.from(content, "utf8")) : new Uint8Array(content),
  ]));
}

export function computeAdapterFileDigest(content: Uint8Array): string {
  return computeCloudSkillAdapterFileDigest(content);
}
