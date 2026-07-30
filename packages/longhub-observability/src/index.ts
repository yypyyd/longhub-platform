/** 结构化日志的统一安全出口。 */
export interface StructuredLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export * from "./client-telemetry.js";

export interface ConsoleLoggerOptions {
  sink?: (line: string) => void;
  now?: () => Date;
  sensitiveValues?: readonly string[] | (() => readonly string[]);
}

export interface RedactionOptions {
  maxDepth?: number;
  maxArrayLength?: number;
  maxStringLength?: number;
  sensitiveValues?: readonly string[];
}

export const REDACTED_LOG_VALUE = "[REDACTED]";
const TRUNCATED_LOG_VALUE = "[TRUNCATED]";
const CIRCULAR_LOG_VALUE = "[CIRCULAR]";
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_ARRAY_LENGTH = 50;
const DEFAULT_MAX_STRING_LENGTH = 4_096;

const EXACT_SECRET_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "token",
  "devicetoken",
  "gatewaytoken",
  "bridgetoken",
  "modeltoken",
  "admintoken",
  "accesstoken",
  "refreshtoken",
  "sessiontoken",
  "apikey",
  "encryptedapikey",
  "secret",
  "clientsecret",
  "password",
  "passphrase",
  "credential",
  "credentials",
  "privatekey",
  "signingkey",
  "modelconfigkey",
  "csckeypassword",
  "activationcode",
  "authorizationcode",
]);

const USER_CONTENT_KEYS = new Set([
  "content",
  "contents",
  "body",
  "input",
  "output",
  "text",
  "prompt",
  "messages",
  "filecontent",
  "filecontents",
  "filebody",
  "filetext",
  "userfilecontent",
  "attachmentcontent",
  "documenttext",
  "resumetext",
  "jdtext",
]);

const RESERVED_LOG_KEYS = new Set(["ts", "level", "component", "event"]);
const SENSITIVE_TEXT_KEYS = [
  "access[_-]?token",
  "api[_-]?key",
  "device[_-]?token",
  "gateway[_-]?token",
  "bridge[_-]?token",
  "token",
  "password",
  "secret",
  "authorization",
  "activation[_-]?code",
].join("|");
const SENSITIVE_ASSIGNMENT_PATTERN = new RegExp(
  `((?:--)?(?:${SENSITIVE_TEXT_KEYS})\\s*[:=]?\\s*)(["']?)(?:Bearer\\s+)?[^\\s,;}"']+`,
  "gi",
);
const SENSITIVE_URL_PARAMETER_PATTERN = new RegExp(
  `([?#&](?:access_token|api[_-]?key|device[_-]?token|gateway[_-]?token|token)=)[^&#\\s]+`,
  "gi",
);

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return EXACT_SECRET_KEYS.has(normalized) || USER_CONTENT_KEYS.has(normalized);
}

/**
 * 清理可能来自上游、子进程或异常对象的自由文本。
 * 结构化字段仍应优先依赖 redactLogValue；文本规则是防止错误消息二次夹带秘密的兜底。
 */
export function redactLogText(
  value: string,
  maxLength = DEFAULT_MAX_STRING_LENGTH,
  sensitiveValues: readonly string[] = [],
): string {
  let redacted = value;
  for (const secret of sensitiveValues) {
    if (secret.length >= 8) redacted = redacted.split(secret).join(REDACTED_LOG_VALUE);
  }
  redacted = redacted
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, `$1$2${REDACTED_LOG_VALUE}`)
    .replace(/\bBearer\s+[^\s,;"']+/gi, `Bearer ${REDACTED_LOG_VALUE}`)
    .replace(SENSITIVE_URL_PARAMETER_PATTERN, `$1${REDACTED_LOG_VALUE}`)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, REDACTED_LOG_VALUE)
    .replace(/\bdt-[A-Za-z0-9_-]{8,}\b/g, REDACTED_LOG_VALUE)
    .replace(/\bLH-(?:[A-Z0-9]{4}-){3}[A-Z0-9]{4}\b/gi, REDACTED_LOG_VALUE);
  if (redacted.length > maxLength) redacted = `${redacted.slice(0, maxLength)}${TRUNCATED_LOG_VALUE}`;
  return redacted;
}

function errorRecord(error: Error, options: Required<RedactionOptions>): Record<string, unknown> {
  const result: Record<string, unknown> = {
    name: error.name,
    message: redactLogText(error.message, options.maxStringLength, options.sensitiveValues),
  };
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") result.code = code;
  return result;
}

function redactValue(
  value: unknown,
  options: Required<RedactionOptions>,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (typeof value === "string") return redactLogText(value, options.maxStringLength, options.sensitiveValues);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return undefined;
  if (typeof value === "symbol" || typeof value === "function") return String(value);
  if (value instanceof Error) return errorRecord(value, options);
  if (value instanceof Date) return value.toISOString();
  if (depth >= options.maxDepth) return TRUNCATED_LOG_VALUE;
  if (seen.has(value)) return CIRCULAR_LOG_VALUE;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, options.maxArrayLength).map((item) => redactValue(item, options, seen, depth + 1));
      if (value.length > options.maxArrayLength) items.push(TRUNCATED_LOG_VALUE);
      return items;
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = isSensitiveKey(key) ? REDACTED_LOG_VALUE : redactValue(item, options, seen, depth + 1);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

/** 对日志字段和持久化审计详情执行递归、有限大小、循环安全的脱敏。 */
export function redactLogValue(value: unknown, options: RedactionOptions = {}): unknown {
  return redactValue(
    value,
    {
      maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
      maxArrayLength: options.maxArrayLength ?? DEFAULT_MAX_ARRAY_LENGTH,
      maxStringLength: options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH,
      sensitiveValues: options.sensitiveValues ?? [],
    },
    new WeakSet<object>(),
    0,
  );
}

export function createConsoleLogger(component: string, options: ConsoleLoggerOptions = {}): StructuredLogger {
  const sink = options.sink ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => new Date());
  const log = (level: string, event: string, fields?: Record<string, unknown>) => {
    const sensitiveValues = typeof options.sensitiveValues === "function"
      ? options.sensitiveValues()
      : options.sensitiveValues ?? [];
    const safeFields = redactLogValue(fields ?? {}, { sensitiveValues }) as Record<string, unknown>;
    for (const key of RESERVED_LOG_KEYS) delete safeFields[key];
    sink(JSON.stringify({
      ...safeFields,
      ts: now().toISOString(),
      level,
      component,
      event: redactLogText(event, 256, sensitiveValues),
    }));
  };
  return {
    info: (event, fields) => log("info", event, fields),
    warn: (event, fields) => log("warn", event, fields),
    error: (event, fields) => log("error", event, fields),
  };
}
