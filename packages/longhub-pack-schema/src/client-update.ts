import { createHash, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { z } from "zod";
import { canonicalStringify } from "./integrity.js";

export const CLIENT_UPDATE_SCHEMA = "longhub/client-update/v2" as const;
export const CLIENT_UPDATE_SIGNATURE_DOMAIN = "longhub-client-update-v2\n";
/** Signed product identity. Updates for any other LongHub surface must use a
 * different contract and trust domain instead of sharing the Manager channel. */
export const CLIENT_UPDATE_PRODUCT_SURFACE = "longhub-manager" as const;

const versionSchema = z.string().regex(/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const filenameSchema = z.string().regex(/^LongHub-Manager-Setup-\d+\.\d+\.\d+\.exe$/);

export const clientUpdateRolloutSchema = z.object({
  status: z.enum(["active", "paused"]),
  basis_points: z.number().int().min(0).max(10_000),
  seed: z.string().regex(/^[a-f0-9]{64}$/),
  updated_at: z.string().datetime({ offset: true }),
}).strict().superRefine((rollout, ctx) => {
  if (rollout.status === "active" && rollout.basis_points === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["basis_points"],
      message: "启用灰度时比例必须大于 0",
    });
  }
});

export const clientUpdateManifestSchema = z.object({
  schema_version: z.literal(CLIENT_UPDATE_SCHEMA),
  product_surface: z.literal(CLIENT_UPDATE_PRODUCT_SURFACE),
  sequence: z.number().int().safe().positive(),
  version: versionSchema,
  channel: z.enum(["stable", "beta"]),
  platform: z.literal("win32"),
  arch: z.literal("x64"),
  filename: filenameSchema,
  size: z.number().int().safe().positive().max(1024 * 1024 * 1024),
  sha256: digestSchema,
  url_path: z.string().regex(/^\/downloads\/LongHub-Manager-Setup-\d+\.\d+\.\d+\.exe$/),
  published_at: z.string().datetime({ offset: true }),
  rollback_data_strategy: z.enum(["snapshot_required", "backward_compatible"]),
  rollout: clientUpdateRolloutSchema,
}).strict().superRefine((manifest, ctx) => {
  const expectedFilename = `LongHub-Manager-Setup-${manifest.version}.exe`;
  if (manifest.filename !== expectedFilename) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["filename"], message: "文件名与版本不一致" });
  }
  if (manifest.url_path !== `/downloads/${manifest.filename}`) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["url_path"], message: "下载路径与文件名不一致" });
  }
});

export const signedClientUpdateMetadataSchema = z.object({
  manifest: clientUpdateManifestSchema,
  signature_key_id: z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/),
  signature: z.string().min(40).max(512),
}).strict();

export type ClientUpdateManifest = z.infer<typeof clientUpdateManifestSchema>;
export type ClientUpdateRollout = z.infer<typeof clientUpdateRolloutSchema>;
export type SignedClientUpdateMetadata = z.infer<typeof signedClientUpdateMetadataSchema>;

export function clientUpdateSignaturePayload(manifest: ClientUpdateManifest): string {
  return `${CLIENT_UPDATE_SIGNATURE_DOMAIN}${canonicalStringify(clientUpdateManifestSchema.parse(manifest))}`;
}

export function signClientUpdateManifest(manifest: ClientUpdateManifest, privateKeyPem: string): string {
  const payload = Buffer.from(clientUpdateSignaturePayload(manifest), "utf8");
  return cryptoSign(null, payload, privateKeyPem).toString("base64");
}

export function verifyClientUpdateMetadata(
  metadata: unknown,
  trustedKeys: ReadonlyMap<string, string>,
): metadata is SignedClientUpdateMetadata {
  const parsed = signedClientUpdateMetadataSchema.safeParse(metadata);
  if (!parsed.success) return false;
  const publicKey = trustedKeys.get(parsed.data.signature_key_id);
  if (!publicKey) return false;
  try {
    return cryptoVerify(
      null,
      Buffer.from(clientUpdateSignaturePayload(parsed.data.manifest), "utf8"),
      publicKey,
      Buffer.from(parsed.data.signature, "base64"),
    );
  } catch {
    return false;
  }
}

export function compareClientVersions(left: string, right: string): number {
  const leftParts = versionSchema.parse(left).split(".").map(Number);
  const rightParts = versionSchema.parse(right).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

export function clientUpdateDigest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** 固定 seed + 稳定设备身份生成单调 cohort；扩大比例时已命中的设备不会退出灰度。 */
export function clientUpdateRolloutBucket(seed: string, identity: string): number {
  if (!/^[a-f0-9]{64}$/.test(seed)) throw new Error("客户端更新灰度 seed 无效");
  if (!/^[a-zA-Z0-9._:-]{1,256}$/.test(identity)) throw new Error("客户端更新灰度身份无效");
  const digest = createHash("sha256")
    .update("longhub-client-rollout-v1\n", "utf8")
    .update(seed, "ascii")
    .update("\n", "utf8")
    .update(identity, "utf8")
    .digest();
  return digest.readUInt32BE(0) % 10_000;
}

export function isClientUpdateRolloutEligible(
  rollout: ClientUpdateRollout,
  identity: string,
): boolean {
  const parsed = clientUpdateRolloutSchema.parse(rollout);
  if (parsed.status === "paused") return false;
  if (!/^[a-zA-Z0-9._:-]{1,256}$/.test(identity)) throw new Error("客户端更新灰度身份无效");
  if (parsed.basis_points === 10_000) return true;
  return clientUpdateRolloutBucket(parsed.seed, identity) < parsed.basis_points;
}
