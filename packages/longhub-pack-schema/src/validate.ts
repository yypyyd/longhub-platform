import { packManifestSchema, type PackManifest } from "./manifest.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; manifest: PackManifest }
  | { ok: false; issues: ValidationIssue[] };

/** 校验 Pack Manifest V1，返回结构化结果而不抛异常 */
export function validatePackManifest(input: unknown): ValidationResult {
  const parsed = packManifestSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, manifest: parsed.data };
  }
  return {
    ok: false,
    issues: parsed.error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    })),
  };
}
