import { createHash } from "node:crypto";

/**
 * Versioned binding for a Cloud Task idempotency key.
 *
 * The value is deliberately kept out of the public `CloudTask` shape.  It is
 * an internal storage binding which prevents a caller from replaying a task
 * under the same key while changing the Skill or any of the protocol
 * metadata that gives the request its meaning.
 */
export const CLOUD_TASK_REQUEST_FINGERPRINT_VERSION = "v1" as const;
export const CLOUD_TASK_REQUEST_FINGERPRINT_DOMAIN = "longhub/cloud-task-request-fingerprint/v1" as const;
export const LEGACY_UNBOUND_TASK_REQUEST_FINGERPRINT = "legacy-unbound" as const;

const REQUEST_FINGERPRINT_PATTERN = /^v1:[a-f0-9]{64}$/;

/** Fields covered by the v1 task binding. Keep this as a fixed tuple below. */
export interface CloudTaskRequestFingerprintInput {
  /** Normalized protocol/schema marker (for example the strict v1 envelope). */
  schema_version: string;
  request_id: string;
  kind: string;
  tenant_id: string;
  device_id: string;
  agent_id: string;
  skill_id: string;
  skill_version: string;
  tool_call_id: string;
  session_key_hash: string;
  idempotency_key: string;
  /** The normalized client plan candidate; null means the request omitted it. */
  requested_plan_id: string | null;
  /** Existing executor input digest (canonical JSON, lower-case SHA-256). */
  input_digest: string;
}

/**
 * Return the canonical tuple covered by the digest.  Arrays are used instead
 * of an object so the serialization cannot be affected by object key order.
 */
export function cloudTaskRequestFingerprintTuple(
  input: CloudTaskRequestFingerprintInput,
): readonly [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string | null,
  string,
] {
  return [
    CLOUD_TASK_REQUEST_FINGERPRINT_DOMAIN,
    input.schema_version,
    input.request_id,
    input.kind,
    input.tenant_id,
    input.device_id,
    input.agent_id,
    input.skill_id,
    input.skill_version,
    input.tool_call_id,
    input.session_key_hash,
    input.idempotency_key,
    input.requested_plan_id,
    input.input_digest,
  ];
}

/** Stable UTF-8 JSON representation of the v1 tuple. */
export function canonicalCloudTaskRequestFingerprintPayload(
  input: CloudTaskRequestFingerprintInput,
): string {
  return JSON.stringify(cloudTaskRequestFingerprintTuple(input));
}

/**
 * Compute the persisted request binding (`v1:<lower-case sha256>`).
 */
export function computeCloudTaskRequestFingerprint(
  input: CloudTaskRequestFingerprintInput,
): string {
  return `${CLOUD_TASK_REQUEST_FINGERPRINT_VERSION}:${createHash("sha256")
    .update(canonicalCloudTaskRequestFingerprintPayload(input), "utf8")
    .digest("hex")}`;
}

/** Alias kept short for callers which already use the task terminology. */
export const computeTaskRequestFingerprint = computeCloudTaskRequestFingerprint;

export function isCloudTaskRequestFingerprint(value: unknown): value is string {
  return typeof value === "string" && REQUEST_FINGERPRINT_PATTERN.test(value);
}

export function isLegacyUnboundTaskRequestFingerprint(value: unknown): value is typeof LEGACY_UNBOUND_TASK_REQUEST_FINGERPRINT {
  return value === LEGACY_UNBOUND_TASK_REQUEST_FINGERPRINT;
}
