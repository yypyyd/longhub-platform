import { createHash, randomBytes } from "node:crypto";
import type { ActivationCodeRecord, CloudStore, DeviceRecord } from "./store.js";

const CODE_GROUPS = 4;
const CODE_GROUP_LENGTH = 4;

export interface DeviceActivationStatus {
  device_id: string;
  activated: boolean;
  reason?: "ACTIVATION_REQUIRED" | "ACTIVATION_REVOKED" | "ACTIVATION_EXPIRED";
  expires_at?: string;
  code_hint?: string;
}

export function normalizeActivationCode(value: string): string | undefined {
  const compact = value.trim().toUpperCase().replace(/[\s-]+/g, "");
  if (!/^LH[A-F0-9]{16}$/.test(compact)) return undefined;
  return compact;
}

export function hashActivationCode(value: string): string | undefined {
  const normalized = normalizeActivationCode(value);
  return normalized ? createHash("sha256").update(normalized, "utf8").digest("hex") : undefined;
}

export function generateActivationCode(): { code: string; codeHash: string; codeHint: string } {
  const payload = randomBytes((CODE_GROUPS * CODE_GROUP_LENGTH) / 2).toString("hex").toUpperCase();
  const groups = Array.from({ length: CODE_GROUPS }, (_, index) =>
    payload.slice(index * CODE_GROUP_LENGTH, (index + 1) * CODE_GROUP_LENGTH),
  );
  const code = `LH-${groups.join("-")}`;
  return { code, codeHash: hashActivationCode(code)!, codeHint: groups.at(-1)! };
}

export async function deviceActivationStatus(
  store: CloudStore,
  device: DeviceRecord,
  now = new Date().toISOString(),
): Promise<DeviceActivationStatus> {
  if (!device.activation_code_id) return { device_id: device.device_id, activated: false, reason: "ACTIVATION_REQUIRED" };
  const code = await store.getActivationCode(device.activation_code_id);
  if (!code || code.status !== "active") {
    return { device_id: device.device_id, activated: false, reason: "ACTIVATION_REVOKED" };
  }
  if (code.expires_at <= now) {
    return {
      device_id: device.device_id,
      activated: false,
      reason: "ACTIVATION_EXPIRED",
      expires_at: code.expires_at,
      code_hint: code.code_hint,
    };
  }
  return { device_id: device.device_id, activated: true, expires_at: code.expires_at, code_hint: code.code_hint };
}

export function publicActivationCode(record: ActivationCodeRecord): Omit<ActivationCodeRecord, "code_hash"> {
  const { code_hash: _secret, ...safe } = record;
  return safe;
}
