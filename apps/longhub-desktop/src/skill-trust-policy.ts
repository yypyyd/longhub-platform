import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";

export interface SkillTrustPolicy {
  readonly schema_version: "longhub/skill-trust/v1";
  readonly status: "pending" | "approved";
  readonly approved_by: string | null;
  readonly approved_at: string | null;
  readonly trustedKeys: ReadonlyMap<string, string>;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("|") === [...expected].sort().join("|");
}

function parseTrustedKeyMap(input: unknown, label: string): ReadonlyMap<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length > 32) {
    throw new Error(`${label}必须是有界 key ID → Ed25519 公钥对象`);
  }
  const keys = new Map<string, string>();
  for (const [keyId, value] of Object.entries(input)) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(keyId) || typeof value !== "string" || value.includes("PRIVATE KEY")) {
      throw new Error(`${label}字段无效`);
    }
    const pem = value.includes("\\n") ? value.replaceAll("\\n", "\n") : value;
    let publicKey;
    try {
      publicKey = createPublicKey(pem);
    } catch {
      throw new Error(`${label} PEM 无效: ${keyId}`);
    }
    if (publicKey.asymmetricKeyType !== "ed25519") throw new Error(`${label}必须是 Ed25519 公钥`);
    keys.set(keyId, publicKey.export({ type: "spki", format: "pem" }).toString());
  }
  return keys;
}

/** 读取随安装包固定交付的 Skill 信任根；正式发布必须通过审批且至少包含一个 Ed25519 公钥。 */
export function loadSkillTrustPolicy(path: string, requireApproved = false): SkillTrustPolicy {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
    !exactKeys(parsed, ["schema_version", "status", "approved_by", "approved_at", "keys"])) {
    throw new Error("Skill 信任清单格式无效");
  }
  const raw = parsed as Record<string, unknown>;
  if (raw.schema_version !== "longhub/skill-trust/v1" ||
    (raw.status !== "pending" && raw.status !== "approved") || !Array.isArray(raw.keys) || raw.keys.length > 32) {
    throw new Error("Skill 信任清单字段无效");
  }
  const keyMap: Record<string, unknown> = {};
  for (const item of raw.keys) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
      !exactKeys(item, ["key_id", "public_key_pem"])) throw new Error("Skill 信任公钥记录无效");
    const entry = item as Record<string, unknown>;
    if (typeof entry.key_id !== "string" || Object.hasOwn(keyMap, entry.key_id)) {
      throw new Error("Skill 信任公钥记录无效");
    }
    keyMap[entry.key_id] = entry.public_key_pem;
  }
  const trustedKeys = parseTrustedKeyMap(keyMap, "Skill 信任锚");
  const approvedBy = raw.approved_by;
  const approvedAt = raw.approved_at;
  if ((approvedBy !== null && (typeof approvedBy !== "string" || !approvedBy.trim())) ||
    (approvedAt !== null && (typeof approvedAt !== "string" || !Number.isFinite(Date.parse(approvedAt))))) {
    throw new Error("Skill 信任清单审批字段无效");
  }
  const approvedComplete = trustedKeys.size > 0 && typeof approvedBy === "string" && typeof approvedAt === "string";
  if (raw.status === "approved" && !approvedComplete) throw new Error("已审批的 Skill 信任清单字段不完整");
  if (requireApproved && raw.status !== "approved") throw new Error("正式发布必须预置审批通过的 Skill 信任清单");
  return {
    schema_version: "longhub/skill-trust/v1",
    status: raw.status,
    approved_by: approvedBy as string | null,
    approved_at: approvedAt as string | null,
    trustedKeys,
  };
}

/** 开发态显式注入测试密钥；打包运行时不得调用。 */
export function loadDevelopmentSkillTrustedKeys(raw: string | undefined): ReadonlyMap<string, string> {
  if (!raw?.trim()) return new Map();
  return parseTrustedKeyMap(JSON.parse(raw) as unknown, "LONGHUB_SKILL_TRUSTED_KEYS_JSON");
}
