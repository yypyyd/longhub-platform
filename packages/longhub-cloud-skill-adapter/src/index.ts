import {
  createHash,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { z } from "zod";

/** Wire-level schema identifier. Keep this value stable across all v1 adapters. */
export const CLOUD_SKILL_ADAPTER_SCHEMA = "longhub/cloud-skill-adapter/v1" as const;
/** Alias retained for callers that use the version-suffixed naming convention. */
export const CLOUD_SKILL_ADAPTER_SCHEMA_VERSION = CLOUD_SKILL_ADAPTER_SCHEMA;

const MAX_ID_LENGTH = 128;
const MAX_TEXT_LENGTH = 500;
const MAX_PATH_LENGTH = 240;
/** A thin adapter is intentionally tiny; this also bounds hashing/install IO. */
export const MAX_CLOUD_SKILL_ADAPTER_FILE_BYTES = 4 * 1024 * 1024;
export const CLOUD_SKILL_ADAPTER_REQUIRED_FILES = [
  "SKILL.md",
  "schemas/input.json",
  "schemas/output.json",
] as const;

const semverSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    "必须是语义化版本号，如 1.0.0",
  );

const apiVersionSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "必须是主次版本号，如 1.0");

const skillIdSchema = z
  .string()
  .min(1)
  .max(MAX_ID_LENGTH)
  .regex(
    /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*\.skill\.[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/,
    "Skill ID 格式为 <publisher>.skill.<name>",
  );

const serviceIdSchema = z
  .string()
  .min(1)
  .max(MAX_ID_LENGTH)
  .regex(
    /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/,
    "服务 ID 必须是点分逻辑标识，不能是 URL",
  );

const keyIdSchema = z
  .string()
  .min(1)
  .max(MAX_ID_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "签名密钥 ID 格式不合法");

const digestSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "摘要必须是 64 位小写 SHA-256");

/* An Ed25519 signature is exactly 64 bytes => 88 canonical Base64 chars. */
const signatureSchema = z
  .string()
  .regex(/^[A-Za-z0-9+/]{86}==$/, "签名必须是 64 字节 Ed25519 Base64");

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function isSafeSchemaPath(value: string): boolean {
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes(":") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      !segment.startsWith(" ") &&
      !segment.endsWith(".") &&
      !segment.endsWith(" ") &&
      !WINDOWS_RESERVED_NAME.test(segment),
  );
}

/** References are local JSON files only; a manifest can never carry a remote URL. */
export const schemaReferenceSchema = z
  .string()
  .min(1)
  .max(MAX_PATH_LENGTH)
  .refine(isSafeSchemaPath, "Schema 必须是安全的相对路径")
  .refine((value) => value.toLowerCase().endsWith(".json"), "输入输出 Schema 必须是 JSON 文件");

const adapterFilePathSchema = z
  .string()
  .min(1)
  .max(MAX_PATH_LENGTH)
  .refine(isSafeSchemaPath, "适配器文件必须是安全的相对路径")
  .refine(
    (value) => {
      // v1 is a pure-content adapter. Do not turn the native Skill directory
      // into an executable/plugin/MCP delivery channel.
      const lower = value.toLowerCase();
      return lower === "skill.md" || lower.endsWith(".json");
    },
    "适配器只允许 SKILL.md 和 JSON 声明文件",
  );

const adapterFileSchema = z
  .object({
    path: adapterFilePathSchema,
    sha256: digestSchema,
    size: z.number().int().safe().positive().max(MAX_CLOUD_SKILL_ADAPTER_FILE_BYTES),
  })
  .strict();

export type CloudSkillAdapterFile = z.infer<typeof adapterFileSchema>;

const planIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/, "套餐 ID 格式不合法");

/** Public permission names use dotted or colon-separated logical segments. */
const permissionSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[a-z][a-z0-9_-]*(?:[.:][a-z0-9_.-]+)+$/,
    "权限格式不合法",
  );

const displaySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(MAX_TEXT_LENGTH),
    category: z.string().trim().min(1).max(40),
  })
  .strict();

const serviceSchema = z
  .object({
    service_id: serviceIdSchema,
    api_version: apiVersionSchema,
    entry: z.literal("local-longhub-bridge"),
  })
  .strict();

const schemasSchema = z
  .object({
    input: schemaReferenceSchema,
    output: schemaReferenceSchema,
  })
  .strict();

const filesSchema = z
  .array(adapterFileSchema)
  .length(CLOUD_SKILL_ADAPTER_REQUIRED_FILES.length, "v1 适配器必须恰好包含三个纯内容文件")
  .superRefine((files, context) => {
    const expected = [...CLOUD_SKILL_ADAPTER_REQUIRED_FILES];
    const paths = files.map((file) => file.path);
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: "适配器文件路径不能重复",
      });
    }
    if (paths.some((path) => !expected.includes(path as (typeof expected)[number]))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: "v1 适配器包含未声明的文件",
      });
    }
    if (paths.join("\u0000") !== expected.join("\u0000")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: "适配器文件必须按固定路径顺序排列",
      });
    }
  });

const subscriptionSchema = z
  .object({
    plan_ids: z.array(planIdSchema).min(1).max(32).refine(
      (values) => new Set(values).size === values.length,
      "套餐 ID 不能重复",
    ),
  })
  .strict();

const permissionsSchema = z
  .object({
    requested: z.array(permissionSchema).max(64).refine(
      (values) => new Set(values).size === values.length,
      "权限不能重复",
    ),
    confirmation_class: z.enum(["none", "per_execution"]),
  })
  .strict();

const compatibilitySchema = z
  .object({
    manager_min_version: semverSchema,
    openclaw_version: semverSchema,
  })
  .strict();

const integritySchema = z
  .object({
    algorithm: z.literal("sha256"),
    digest: digestSchema,
    signature_key_id: keyIdSchema,
    signature: signatureSchema,
  })
  .strict();

const URL_PATTERN = /(?:https?|ftp|file):\/\/|(?:javascript|data):/i;

/**
 * Manifest fields intentionally contain only public metadata and logical IDs.
 * `.strict()` is applied at every object level so private implementation fields
 * cannot be smuggled into a signed adapter.
 */
const cloudSkillAdapterManifestBaseSchema = z
  .object({
    schema_version: z.literal(CLOUD_SKILL_ADAPTER_SCHEMA),
    skill_id: skillIdSchema,
    version: semverSchema,
    display: displaySchema,
    service: serviceSchema,
    schemas: schemasSchema,
    files: filesSchema,
    subscription: subscriptionSchema,
    permissions: permissionsSchema,
    compatibility: compatibilitySchema,
    integrity: integritySchema,
  })
  .strict();

/** Return the final path segment of a logical permission name. */
function permissionAction(permission: string): string {
  return permission.split(/[.:]/).at(-1) ?? "";
}

function requiresExecutionConfirmation(permission: string): boolean {
  return !new Set(["read", "list", "search"]).has(permissionAction(permission));
}

/**
 * Strict v1 manifest schema. In addition to rejecting unknown keys, it rejects
 * URL-shaped values so a service endpoint cannot be user-controlled metadata.
 */
export const cloudSkillAdapterManifestSchema = cloudSkillAdapterManifestBaseSchema.superRefine(
  (manifest, context) => {
    const filePaths = new Set(manifest.files.map((file) => file.path));
    if (manifest.files[0]?.path !== "SKILL.md") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["files", 0, "path"],
        message: "第一个适配器文件必须是 SKILL.md",
      });
    }
    if (manifest.schemas.input !== "schemas/input.json" || !filePaths.has(manifest.schemas.input)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["schemas", "input"],
        message: "输入 Schema 必须绑定 schemas/input.json",
      });
    }
    if (manifest.schemas.output !== "schemas/output.json" || !filePaths.has(manifest.schemas.output)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["schemas", "output"],
        message: "输出 Schema 必须绑定 schemas/output.json",
      });
    }
    if (
      manifest.permissions.confirmation_class === "none" &&
      manifest.permissions.requested.some(requiresExecutionConfirmation)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["permissions", "confirmation_class"],
        message: "写入、发送、删除、支付及未知动作必须逐次确认",
      });
    }

    // URL-like values are not valid public references. The only strings in v1
    // that may look path-like are local JSON schema references, which are
    // checked separately and cannot contain a colon or slash prefix.
    const visit = (value: unknown, path: (string | number)[]): void => {
      if (typeof value === "string" && URL_PATTERN.test(value)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: "云端适配器 manifest 不得包含 URL",
        });
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((entry, index) => visit(entry, [...path, index]));
      } else if (value !== null && typeof value === "object") {
        Object.entries(value as Record<string, unknown>).forEach(([key, entry]) =>
          visit(entry, [...path, key]),
        );
      }
    };
    visit(manifest, []);
  },
);

/** Alias with the shorter naming used by some Manager callers. */
export const cloudSkillAdapterSchema = cloudSkillAdapterManifestSchema;
export const manifestSchema = cloudSkillAdapterManifestSchema;
export const cloudSkillAdapterPublicManifestSchema = cloudSkillAdapterManifestSchema;
export const cloudSkillAdapterManifestPublicSchema = cloudSkillAdapterManifestSchema;

export type CloudSkillAdapterManifest = z.infer<typeof cloudSkillAdapterManifestSchema>;
export type CloudSkillAdapterPublicManifest = CloudSkillAdapterManifest;
export type CloudSkillAdapterFiles = CloudSkillAdapterFile[];
export type CloudSkillAdapterService = z.infer<typeof serviceSchema>;
export type CloudSkillAdapterPermissions = z.infer<typeof permissionsSchema>;
export type CloudSkillAdapterCompatibility = z.infer<typeof compatibilitySchema>;

export type CloudSkillAdapterValidationIssue = {
  path: string;
  message: string;
};

export type CloudSkillAdapterValidationResult =
  | { ok: true; manifest: CloudSkillAdapterManifest }
  | { ok: false; issues: CloudSkillAdapterValidationIssue[] };

/** Parse and validate an unknown wire payload without stripping unknown fields. */
export function validateCloudSkillAdapterManifest(input: unknown): CloudSkillAdapterValidationResult {
  const parsed = cloudSkillAdapterManifestSchema.safeParse(input);
  if (parsed.success) return { ok: true, manifest: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  };
}

export const validateCloudSkillAdapter = validateCloudSkillAdapterManifest;
export const parseCloudSkillAdapterManifest = (input: unknown): CloudSkillAdapterManifest =>
  cloudSkillAdapterManifestSchema.parse(input);

/**
 * Recursively sort object keys while preserving array order. This is the
 * canonical JSON representation used by the digest and signature functions.
 */
export function canonicalStringify(value: unknown): string {
  const normalize = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(normalize);
    if (current !== null && typeof current === "object") {
      return Object.fromEntries(
        Object.entries(current as Record<string, unknown>)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, entry]) => [key, normalize(entry)]),
      );
    }
    return current;
  };
  const serialized = JSON.stringify(normalize(value));
  if (serialized === undefined) throw new TypeError("无法将值规范化为 JSON");
  return serialized;
}

/** The manifest payload covered by the digest, excluding only self-reference. */
export function cloudSkillAdapterDigestPayload(manifest: CloudSkillAdapterManifest): string {
  const parsed = cloudSkillAdapterManifestSchema.parse(manifest);
  const { digest: _digest, signature: _signature, ...integrity } = parsed.integrity;
  // Keep the file list deterministic even if a caller constructed an object
  // through a cast. The schema itself requires this order, while sorting here
  // makes the cross-language canonicalization rule explicit.
  const files = [...parsed.files].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return canonicalStringify({ ...parsed, files, integrity });
}

/** Compute a lower-case SHA-256 digest over the canonical public manifest. */
export function computeCloudSkillAdapterDigest(manifest: CloudSkillAdapterManifest): string {
  return createHash("sha256")
    .update(cloudSkillAdapterDigestPayload(manifest), "utf8")
    .digest("hex");
}

export const cloudSkillAdapterDigest = computeCloudSkillAdapterDigest;
export const computeManifestDigest = computeCloudSkillAdapterDigest;

export type CloudSkillAdapterFileContent = Uint8Array | string;

function fileContentBytes(content: CloudSkillAdapterFileContent): Uint8Array {
  return typeof content === "string" ? Buffer.from(content, "utf8") : content;
}

/** Compute the digest bound to one declared adapter file. */
export function computeCloudSkillAdapterFileDigest(content: CloudSkillAdapterFileContent): string {
  return createHash("sha256").update(fileContentBytes(content)).digest("hex");
}

/** Build a manifest file record from bytes, rather than trusting caller metadata. */
export function createCloudSkillAdapterFile(
  path: string,
  content: CloudSkillAdapterFileContent,
): CloudSkillAdapterFile {
  const bytes = fileContentBytes(content);
  return adapterFileSchema.parse({
    path,
    sha256: computeCloudSkillAdapterFileDigest(bytes),
    size: bytes.byteLength,
  });
}

function fileContentLookup(
  files: ReadonlyMap<string, CloudSkillAdapterFileContent> |
    Readonly<Record<string, CloudSkillAdapterFileContent>>,
  path: string,
): CloudSkillAdapterFileContent | undefined {
  if (files instanceof Map) return files.get(path);
  return (files as Readonly<Record<string, CloudSkillAdapterFileContent>>)[path];
}

/** Verify every declared file against bytes supplied by a local installer. */
export function verifyCloudSkillAdapterFileDigests(
  manifest: CloudSkillAdapterManifest,
  files: ReadonlyMap<string, CloudSkillAdapterFileContent> |
    Readonly<Record<string, CloudSkillAdapterFileContent>>,
): boolean {
  try {
    const parsed = cloudSkillAdapterManifestSchema.parse(manifest);
    for (const declaration of parsed.files) {
      const content = fileContentLookup(files, declaration.path);
      if (content === undefined) return false;
      const bytes = fileContentBytes(content);
      if (bytes.byteLength !== declaration.size) return false;
      if (computeCloudSkillAdapterFileDigest(bytes) !== declaration.sha256) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export const verifyCloudSkillAdapterFiles = verifyCloudSkillAdapterFileDigests;
export const verifyManifestFiles = verifyCloudSkillAdapterFileDigests;

/** Sign the digest with an Ed25519 private key in PEM/KeyObject format. */
export function signCloudSkillAdapterDigest(
  digest: string,
  privateKey: string | Parameters<typeof cryptoSign>[2],
): string {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("云端适配器摘要无效");
  return cryptoSign(null, Buffer.from(digest, "utf8"), privateKey).toString("base64");
}

/** Sign a manifest after recomputing its digest, returning a new immutable-by-convention value. */
export function signCloudSkillAdapterManifest(
  manifest: CloudSkillAdapterManifest,
  privateKey: string | Parameters<typeof cryptoSign>[2],
): CloudSkillAdapterManifest {
  const parsed = cloudSkillAdapterManifestSchema.parse(manifest);
  const digest = computeCloudSkillAdapterDigest(parsed);
  return {
    ...parsed,
    integrity: {
      ...parsed.integrity,
      digest,
      signature: signCloudSkillAdapterDigest(digest, privateKey),
    },
  };
}

export const createSignedCloudSkillAdapterManifest = signCloudSkillAdapterManifest;

function verifySignature(
  digest: string,
  signature: string,
  publicKey: string | Parameters<typeof cryptoVerify>[2],
): boolean {
  try {
    return cryptoVerify(
      null,
      Buffer.from(digest, "utf8"),
      publicKey,
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

/** Verify digest integrity and an Ed25519 signature against a single public key. */
export function verifyCloudSkillAdapterSignature(
  manifest: CloudSkillAdapterManifest,
  publicKey: string | Parameters<typeof cryptoVerify>[2],
): boolean {
  try {
    const parsed = cloudSkillAdapterManifestSchema.parse(manifest);
    const digest = computeCloudSkillAdapterDigest(parsed);
    return digest === parsed.integrity.digest &&
      verifySignature(digest, parsed.integrity.signature, publicKey);
  } catch {
    return false;
  }
}

export const verifyCloudSkillAdapterManifest = verifyCloudSkillAdapterSignature;
export const verifyManifestSignature = verifyCloudSkillAdapterSignature;

export type TrustedCloudSkillAdapterKeys =
  | ReadonlyMap<string, string | Parameters<typeof cryptoVerify>[2]>
  | Readonly<Record<string, string | Parameters<typeof cryptoVerify>[2]>>;

function trustedKeyLookup(
  keys: TrustedCloudSkillAdapterKeys,
  keyId: string,
): string | Parameters<typeof cryptoVerify>[2] | undefined {
  if (keys instanceof Map) return keys.get(keyId);
  return (keys as Readonly<Record<string, string | Parameters<typeof cryptoVerify>[2]>>)[keyId];
}

/** Verify a wire payload using the key selected by the manifest's key ID. */
export function verifyCloudSkillAdapterWithTrustedKeys(
  input: unknown,
  trustedKeys: TrustedCloudSkillAdapterKeys,
): input is CloudSkillAdapterManifest {
  const parsed = cloudSkillAdapterManifestSchema.safeParse(input);
  if (!parsed.success) return false;
  const publicKey = trustedKeyLookup(trustedKeys, parsed.data.integrity.signature_key_id);
  return publicKey !== undefined && verifyCloudSkillAdapterSignature(parsed.data, publicKey);
}

export const verifyCloudSkillAdapter = verifyCloudSkillAdapterWithTrustedKeys;

/**
 * Names that are never allowed in a local thin adapter. The list is intentionally
 * broader than the current manifest fields so future callers can use this helper
 * before serializing a private catalog object.
 */
export const CLOUD_SKILL_ADAPTER_PRIVATE_FIELD_NAMES = [
  "implementation",
  "implementation_code",
  "source",
  "source_code",
  "prompt",
  "system_prompt",
  "full_prompt",
  "business_rules",
  "workflow",
  "model",
  "model_route",
  "internal_model",
  "connector",
  "connector_credentials",
  "credentials",
  "secret",
  "secrets",
  "token",
  "access_token",
  "api_key",
  "private_key",
  "executor",
  "executor_url",
  "service_url",
  "base_url",
  "endpoint",
  "url",
  "risk_threshold",
  "risk_rules",
  "evaluation_set",
  "eval_set",
] as const;

const privateFieldNames = new Set<string>(CLOUD_SKILL_ADAPTER_PRIVATE_FIELD_NAMES);

function normalizePrivateFieldName(value: string): string {
  return value.replace(/[_.-]/g, "").toLowerCase();
}

const normalizedPrivateFieldNames = new Set(
  CLOUD_SKILL_ADAPTER_PRIVATE_FIELD_NAMES.map(normalizePrivateFieldName),
);

/** A path to the first private key found in an arbitrary catalog value. */
export function findCloudSkillAdapterPrivateField(
  value: unknown,
  path = "",
): string | undefined {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findCloudSkillAdapterPrivateField(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const keyPath = path ? `${path}.${key}` : key;
    if (privateFieldNames.has(key.toLowerCase()) || normalizedPrivateFieldNames.has(normalizePrivateFieldName(key))) {
      return keyPath;
    }
    const found = findCloudSkillAdapterPrivateField(nested, keyPath);
    if (found) return found;
  }
  return undefined;
}

export function containsCloudSkillAdapterPrivateFields(value: unknown): boolean {
  return findCloudSkillAdapterPrivateField(value) !== undefined;
}

export const containsPrivateCloudSkillAdapterFields = containsCloudSkillAdapterPrivateFields;

/** Throw if an object contains a known private implementation/credential field. */
export function assertNoCloudSkillAdapterPrivateFields(value: unknown): void {
  const path = findCloudSkillAdapterPrivateField(value);
  if (path) throw new Error(`CLOUD_SKILL_ADAPTER_PRIVATE_FIELD:${path}`);
}

export const assertNoPrivateCloudSkillAdapterFields = assertNoCloudSkillAdapterPrivateFields;

/**
 * Validate and return the only representation that may cross the local adapter
 * boundary. Unknown/private fields are rejected rather than silently stripped.
 */
export function toPublicCloudSkillAdapterManifest(input: unknown): CloudSkillAdapterManifest {
  assertNoCloudSkillAdapterPrivateFields(input);
  return cloudSkillAdapterManifestSchema.parse(input);
}

export const projectPublicCloudSkillAdapterManifest = toPublicCloudSkillAdapterManifest;
export const assertPublicCloudSkillAdapterManifest = toPublicCloudSkillAdapterManifest;

export function isPublicCloudSkillAdapterManifest(input: unknown): input is CloudSkillAdapterManifest {
  try {
    toPublicCloudSkillAdapterManifest(input);
    return true;
  } catch {
    return false;
  }
}

export const isCloudSkillAdapterPublicManifest = isPublicCloudSkillAdapterManifest;

/** Top-level keys intentionally exposed by a v1 adapter. */
export const CLOUD_SKILL_ADAPTER_PUBLIC_FIELDS = [
  "schema_version",
  "skill_id",
  "version",
  "display",
  "service",
  "schemas",
  "subscription",
  "permissions",
  "compatibility",
  "integrity",
] as const;
