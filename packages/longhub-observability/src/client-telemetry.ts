/**
 * 客户端匿名遥测的唯一公开契约。
 *
 * 该契约刻意不提供自由文本、扩展标签或设备/用户标识字段。服务端仍会再次
 * 严格解析请求，不能把 TypeScript 类型当作隐私边界。
 */
export const CLIENT_TELEMETRY_SCHEMA = "longhub/client-telemetry/v1" as const;
export const CLIENT_TELEMETRY_MAX_EVENTS = 32;
export const CLIENT_TELEMETRY_MAX_BYTES = 16 * 1024;

export const CLIENT_TELEMETRY_PLATFORMS = ["win32"] as const;
export const CLIENT_TELEMETRY_ARCHITECTURES = ["x64", "arm64"] as const;
export const CLIENT_STARTUP_BUCKETS = ["lt_2s", "2_to_5s", "5_to_15s", "15_to_60s", "gte_60s"] as const;
export const CLIENT_AGENT_COUNT_BUCKETS = ["0", "1", "2_to_5", "gte_6"] as const;
export const CLIENT_GATEWAY_STATES = ["starting", "running", "restarting", "config_error", "failed", "stopped"] as const;
export const CLIENT_UPDATE_RESULTS = ["busy", "none", "declined", "downloaded", "withdrawn", "install_launched", "failed", "healthy", "rollback_launched", "rollback_completed"] as const;
export const CLIENT_EXIT_RESULTS = ["clean", "unclean"] as const;
export const CLIENT_PRODUCT_ERROR_CODES = [
  "LH-GW-001", "LH-CL-001", "LH-AU-001", "LH-AU-002", "LH-MD-001", "LH-UP-001", "LH-UP-002",
  "LH-GW-002", "LH-GW-003", "LH-GW-004", "LH-ST-001", "LH-ST-002", "LH-UI-001",
] as const;

export type ClientTelemetryPlatform = typeof CLIENT_TELEMETRY_PLATFORMS[number];
export type ClientTelemetryArchitecture = typeof CLIENT_TELEMETRY_ARCHITECTURES[number];
export type ClientStartupBucket = typeof CLIENT_STARTUP_BUCKETS[number];
export type ClientAgentCountBucket = typeof CLIENT_AGENT_COUNT_BUCKETS[number];
export type ClientGatewayState = typeof CLIENT_GATEWAY_STATES[number];
export type ClientUpdateResult = typeof CLIENT_UPDATE_RESULTS[number];
export type ClientExitResult = typeof CLIENT_EXIT_RESULTS[number];
export type ClientProductErrorCode = typeof CLIENT_PRODUCT_ERROR_CODES[number];

interface ClientTelemetryEventBase {
  occurred_at: string;
  desktop_version: string;
  openclaw_version: string;
  platform: ClientTelemetryPlatform;
  architecture: ClientTelemetryArchitecture;
}

export type ClientTelemetryEvent =
  | (ClientTelemetryEventBase & {
      event_type: "client_started";
      fields: { startup_duration: ClientStartupBucket; active_agent_count: ClientAgentCountBucket };
    })
  | (ClientTelemetryEventBase & {
      event_type: "gateway_state";
      fields: { state: ClientGatewayState };
    })
  | (ClientTelemetryEventBase & {
      event_type: "client_update_result";
      fields: { result: ClientUpdateResult };
    })
  | (ClientTelemetryEventBase & {
      event_type: "product_error";
      fields: { code: ClientProductErrorCode };
    })
  | (ClientTelemetryEventBase & {
      event_type: "previous_exit";
      fields: { result: ClientExitResult };
    });

export interface ClientTelemetryBatch {
  schema_version: typeof CLIENT_TELEMETRY_SCHEMA;
  events: ClientTelemetryEvent[];
}

export class ClientTelemetryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientTelemetryValidationError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new ClientTelemetryValidationError(`${label} 包含未知或缺失字段`);
  }
}

function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new ClientTelemetryValidationError(`${label} 不在允许枚举中`);
  }
  return value as T;
}

function version(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 64 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new ClientTelemetryValidationError(`${label} 必须是受限语义版本`);
  }
  return value;
}

function occurredAt(value: unknown, nowMs: number): string {
  if (typeof value !== "string" || value.length > 32) throw new ClientTelemetryValidationError("occurred_at 无效");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || Math.abs(nowMs - parsed) > 15 * 60_000) {
    throw new ClientTelemetryValidationError("occurred_at 超出十五分钟接收窗口");
  }
  return new Date(parsed).toISOString();
}

/** 严格解析并重建对象，保证返回值不保留请求中的未知属性。 */
export function parseClientTelemetryBatch(input: unknown, now = new Date()): ClientTelemetryBatch {
  if (!isPlainObject(input)) throw new ClientTelemetryValidationError("遥测批次必须是对象");
  assertExactKeys(input, ["schema_version", "events"], "遥测批次");
  if (input.schema_version !== CLIENT_TELEMETRY_SCHEMA) throw new ClientTelemetryValidationError("遥测契约版本不受支持");
  if (!Array.isArray(input.events) || input.events.length < 1 || input.events.length > CLIENT_TELEMETRY_MAX_EVENTS) {
    throw new ClientTelemetryValidationError(`events 必须包含 1-${CLIENT_TELEMETRY_MAX_EVENTS} 项`);
  }
  const nowMs = now.getTime();
  const events = input.events.map((raw, index): ClientTelemetryEvent => {
    if (!isPlainObject(raw)) throw new ClientTelemetryValidationError(`events[${index}] 必须是对象`);
    assertExactKeys(raw, ["event_type", "occurred_at", "desktop_version", "openclaw_version", "platform", "architecture", "fields"], `events[${index}]`);
    if (!isPlainObject(raw.fields)) throw new ClientTelemetryValidationError(`events[${index}].fields 必须是对象`);
    const common = {
      occurred_at: occurredAt(raw.occurred_at, nowMs),
      desktop_version: version(raw.desktop_version, "desktop_version"),
      openclaw_version: version(raw.openclaw_version, "openclaw_version"),
      platform: enumValue(raw.platform, CLIENT_TELEMETRY_PLATFORMS, "platform"),
      architecture: enumValue(raw.architecture, CLIENT_TELEMETRY_ARCHITECTURES, "architecture"),
    };
    switch (raw.event_type) {
      case "client_started":
        assertExactKeys(raw.fields, ["startup_duration", "active_agent_count"], "client_started.fields");
        return { ...common, event_type: raw.event_type, fields: {
          startup_duration: enumValue(raw.fields.startup_duration, CLIENT_STARTUP_BUCKETS, "startup_duration"),
          active_agent_count: enumValue(raw.fields.active_agent_count, CLIENT_AGENT_COUNT_BUCKETS, "active_agent_count"),
        } };
      case "gateway_state":
        assertExactKeys(raw.fields, ["state"], "gateway_state.fields");
        return { ...common, event_type: raw.event_type, fields: {
          state: enumValue(raw.fields.state, CLIENT_GATEWAY_STATES, "gateway_state"),
        } };
      case "client_update_result":
        assertExactKeys(raw.fields, ["result"], "client_update_result.fields");
        return { ...common, event_type: raw.event_type, fields: {
          result: enumValue(raw.fields.result, CLIENT_UPDATE_RESULTS, "client_update_result"),
        } };
      case "product_error":
        assertExactKeys(raw.fields, ["code"], "product_error.fields");
        return { ...common, event_type: raw.event_type, fields: {
          code: enumValue(raw.fields.code, CLIENT_PRODUCT_ERROR_CODES, "product_error.code"),
        } };
      case "previous_exit":
        assertExactKeys(raw.fields, ["result"], "previous_exit.fields");
        return { ...common, event_type: raw.event_type, fields: {
          result: enumValue(raw.fields.result, CLIENT_EXIT_RESULTS, "previous_exit.result"),
        } };
      default:
        throw new ClientTelemetryValidationError(`events[${index}].event_type 不受支持`);
    }
  });
  return { schema_version: CLIENT_TELEMETRY_SCHEMA, events };
}

export function clientStartupBucket(durationMs: number): ClientStartupBucket {
  if (durationMs < 2_000) return "lt_2s";
  if (durationMs < 5_000) return "2_to_5s";
  if (durationMs < 15_000) return "5_to_15s";
  if (durationMs < 60_000) return "15_to_60s";
  return "gte_60s";
}

export function clientAgentCountBucket(count: number): ClientAgentCountBucket {
  if (count <= 0) return "0";
  if (count === 1) return "1";
  if (count <= 5) return "2_to_5";
  return "gte_6";
}
