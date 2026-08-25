/**
 * LongHub Cloud Skill Executor.
 *
 * The only public surface is an internal POST /execute endpoint. Every request
 * must carry a short-lived Cloud API credential bound to exactly one tenant,
 * task, Skill, idempotency key and input digest. The executor does not trust
 * device credentials, caller-provided permissions, or arbitrary Skill code.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import { createConsoleLogger } from "@longhub/observability";
import {
  EXECUTOR_CREDENTIAL_HEADER,
  EXECUTOR_CREDENTIAL_MAX_TTL_MS,
  EXECUTOR_REQUEST_SCHEMA,
  ExecutorCredentialError,
  getDevelopmentExecutorCredentialKey,
  parseExecutorCredentialKey,
  parseExecutorCredentialTrustedKeys,
  issueExecutorCredential,
  computeExecutorInputDigest,
  verifyExecutorCredential,
  type ExecutorCredentialClaims,
  type ExecutorCredentialKey,
} from "./credential.js";

export interface CloudSkillContext {
  readonly signal: AbortSignal;
  readonly requestId: string;
  readonly taskId: string;
  readonly tenantId: string;
  readonly skillId: string;
  readonly idempotencyKey: string;
}

export type CloudSkill = (input: unknown, context: CloudSkillContext) => Promise<unknown>;

/** A caller can use this error for input validation without exposing details. */
export class SkillInputError extends Error {
  constructor() {
    super("skill input rejected");
    this.name = "SkillInputError";
  }
}

/** Controlled options keep resource limits explicit in tests and deployments. */
export interface ExecutorServerOptions {
  readonly credentialKey?: ExecutorCredentialKey;
  /** Additional key IDs accepted during a bounded rotation overlap. */
  readonly credentialVerificationKeys?: ReadonlyMap<string, ExecutorCredentialKey>;
  readonly skills?: ReadonlyMap<string, CloudSkill>;
  readonly maxBodyBytes?: number;
  readonly maxResponseBytes?: number;
  readonly bodyTimeoutMs?: number;
  readonly executionTimeoutMs?: number;
  readonly idempotencyTtlMs?: number;
  readonly maxIdempotencyEntries?: number;
  readonly now?: () => number;
}

interface ExecutorRequest {
  readonly schema_version: typeof EXECUTOR_REQUEST_SCHEMA;
  readonly task_id: string;
  readonly tenant_id: string;
  readonly skill_id: string;
  readonly idempotency_key: string;
  readonly input_digest: string;
  readonly input: unknown;
}

interface CachedResponse {
  readonly fingerprint: string;
  readonly expiresAt: number;
  readonly promise: Promise<ExecutionResponse>;
}

interface ExecutionResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "HttpProblem";
  }
}

const DEFAULT_MAX_BODY_BYTES = 1 * 1024 * 1024;
const DEFAULT_BODY_TIMEOUT_MS = 10_000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 30_000;
const DEFAULT_IDEMPOTENCY_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_IDEMPOTENCY_ENTRIES = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validText(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value) && !/[\u0000-\u001f\u007f]/.test(value);
}

const taskIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const tenantIdPattern = taskIdPattern;
const skillIdPattern = /^[a-z0-9][a-z0-9._-]{2,127}$/;
const idempotencyPattern = /^[A-Za-z0-9][A-Za-z0-9._~:-]{0,127}$/;
const digestPattern = /^[a-f0-9]{64}$/;

function parseRequest(value: unknown): ExecutorRequest {
  if (!isRecord(value)) throw new HttpProblem(422, "INVALID_REQUEST", false);
  const expected = [
    "schema_version",
    "task_id",
    "tenant_id",
    "skill_id",
    "idempotency_key",
    "input_digest",
    "input",
  ];
  if (Object.keys(value).sort().join("|") !== expected.slice().sort().join("|")) {
    throw new HttpProblem(422, "INVALID_REQUEST", false);
  }
  if (
    value.schema_version !== EXECUTOR_REQUEST_SCHEMA ||
    !validText(value.task_id, taskIdPattern) ||
    !validText(value.tenant_id, tenantIdPattern) ||
    !validText(value.skill_id, skillIdPattern) ||
    !validText(value.idempotency_key, idempotencyPattern) ||
    typeof value.input_digest !== "string" ||
    !digestPattern.test(value.input_digest)
  ) {
    throw new HttpProblem(422, "INVALID_REQUEST", false);
  }
  return value as unknown as ExecutorRequest;
}

function sendJson(res: ServerResponse, status: number, body: unknown, close = false): void {
  if (res.headersSent) return;
  const serialized = JSON.stringify(body);
  res.shouldKeepAlive = !close;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...(close ? { connection: "close" } : {}),
  });
  res.end(serialized);
}

function sendError(res: ServerResponse, problem: HttpProblem, requestId: string): void {
  // Messages are deliberately stable and contain no skill IDs, input, stack,
  // upstream URLs or implementation details.
  const messages: Record<string, string> = {
    NOT_FOUND: "未知路由",
    METHOD_NOT_ALLOWED: "不支持的请求方法",
    UNSUPPORTED_MEDIA_TYPE: "只接受 application/json 请求",
    IDEMPOTENCY_KEY_REQUIRED: "缺少幂等键",
    INVALID_JSON: "请求体不是合法 JSON",
    INVALID_REQUEST: "请求参数无效",
    REQUEST_TOO_LARGE: "请求体超过大小限制",
    REQUEST_TIMEOUT: "读取请求超时",
    CREDENTIAL_REQUIRED: "缺少内部执行凭据",
    CREDENTIAL_INVALID: "内部执行凭据无效",
    CREDENTIAL_EXPIRED: "内部执行凭据已过期",
    CREDENTIAL_BINDING_MISMATCH: "内部执行凭据与请求不匹配",
    IDEMPOTENCY_CONFLICT: "幂等键已绑定其他请求",
    EXECUTOR_BUSY: "执行器暂时繁忙",
    SKILL_NOT_FOUND: "技能不可用",
    SKILL_INPUT_INVALID: "技能输入无效",
    SKILL_EXECUTION_FAILED: "技能执行失败",
    EXECUTION_TIMEOUT: "技能执行超时",
    OUTPUT_TOO_LARGE: "技能输出超过大小限制",
    INTERNAL: "执行器内部错误",
  };
  sendJson(
    res,
    problem.status,
    {
      code: problem.code,
      message: messages[problem.code] ?? "请求失败",
      request_id: requestId,
      retryable: problem.retryable,
    },
    problem.status >= 500 || problem.code === "REQUEST_TIMEOUT" || problem.code === "REQUEST_TOO_LARGE",
  );
}

function executionResponseBody(code: string, retryable: boolean): Record<string, unknown> {
  const messages: Record<string, string> = {
    SKILL_NOT_FOUND: "技能不可用",
    SKILL_INPUT_INVALID: "技能输入无效",
    SKILL_EXECUTION_FAILED: "技能执行失败",
    EXECUTION_TIMEOUT: "技能执行超时",
    OUTPUT_TOO_LARGE: "技能输出超过大小限制",
  };
  return {
    code,
    message: messages[code] ?? "技能执行失败",
    retryable,
  };
}

function internalCredential(req: IncomingMessage): string | undefined {
  const custom = req.headers[EXECUTOR_CREDENTIAL_HEADER];
  const customToken = typeof custom === "string" ? custom.trim() : undefined;
  // Deliberately do not accept Authorization: Bearer here. Device/account
  // Bearer tokens belong to Cloud API and must never be confused with the
  // service-to-service credential.
  return customToken;
}

function readBoundedBody(
  req: IncomingMessage,
  maxBytes: number,
  timeoutMs: number,
): Promise<string> {
  const declared = req.headers["content-length"];
  if (Array.isArray(declared) || (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maxBytes))) {
    return Promise.reject(new HttpProblem(413, "REQUEST_TOO_LARGE", false));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => fail(new HttpProblem(408, "REQUEST_TIMEOUT", true)), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Drain/discard the remainder so Node does not retain an unbounded body.
      req.resume();
      reject(error);
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) {
        fail(new HttpProblem(413, "REQUEST_TOO_LARGE", false));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onError = () => fail(new HttpProblem(400, "INVALID_REQUEST", false));
    const onAborted = () => fail(new HttpProblem(408, "REQUEST_TIMEOUT", true));
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
  });
}

function requestFingerprint(request: ExecutorRequest): string {
  // The digest itself is already canonicalized and signed; this string is only
  // an in-memory idempotency discriminator and is never sent to the client.
  return [request.task_id, request.tenant_id, request.skill_id, request.input_digest].join("\u0000");
}

async function runWithTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new HttpProblem(504, "EXECUTION_TIMEOUT", true));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function validateOptions(options: Required<Pick<ExecutorServerOptions,
  "maxBodyBytes" | "maxResponseBytes" | "bodyTimeoutMs" | "executionTimeoutMs" | "idempotencyTtlMs" | "maxIdempotencyEntries">>): void {
  for (const value of Object.values(options)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("执行器资源限制配置无效");
  }
}

/** Create a fail-closed executor server. */
export function createExecutorServer(options: ExecutorServerOptions = {}): Server {
  const logger = createConsoleLogger("executor");
  const credentialKey = options.credentialKey ?? getDevelopmentExecutorCredentialKey();
  const credentialVerificationKeys = new Map(options.credentialVerificationKeys ?? []);
  credentialVerificationKeys.set(credentialKey.keyId, credentialKey);
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxResponseBytes = options.maxResponseBytes ?? maxBodyBytes;
  const bodyTimeoutMs = options.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS;
  const executionTimeoutMs = options.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
  const idempotencyTtlMs = options.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
  const maxIdempotencyEntries = options.maxIdempotencyEntries ?? DEFAULT_MAX_IDEMPOTENCY_ENTRIES;
  const now = options.now ?? Date.now;
  validateOptions({ maxBodyBytes, maxResponseBytes, bodyTimeoutMs, executionTimeoutMs, idempotencyTtlMs, maxIdempotencyEntries });
  // There is deliberately no built-in/demo Skill registry.  Every production
  // process must receive an audited private registry explicitly; an omitted
  // registry remains an empty fail-closed map (SKILL_NOT_FOUND).
  const skills = options.skills ?? new Map<string, CloudSkill>();
  const idempotency = new Map<string, CachedResponse>();

  const runSkill = async (
    request: ExecutorRequest,
    claims: ExecutorCredentialClaims,
    requestId: string,
  ): Promise<ExecutionResponse> => {
    const skill = skills.get(request.skill_id);
    if (!skill) return { status: 404, body: executionResponseBody("SKILL_NOT_FOUND", false) };
    const controller = new AbortController();
    const context: CloudSkillContext = {
      signal: controller.signal,
      requestId,
      taskId: claims.task_id,
      tenantId: claims.tenant_id,
      skillId: claims.skill_id,
      idempotencyKey: claims.idempotency_key,
    };
    try {
      const output = await runWithTimeout(skill(request.input, context), executionTimeoutMs, controller);
      const body = { output };
      const serialized = JSON.stringify(body);
      if (Buffer.byteLength(serialized, "utf8") > maxResponseBytes) {
        return { status: 502, body: executionResponseBody("OUTPUT_TOO_LARGE", false) };
      }
      logger.info("skill.executed", {
        task_id: claims.task_id,
        tenant_id: claims.tenant_id,
        skill_id: claims.skill_id,
      });
      return { status: 200, body };
    } catch (error) {
      if (error instanceof HttpProblem && error.code === "EXECUTION_TIMEOUT") {
        return { status: 504, body: executionResponseBody("EXECUTION_TIMEOUT", true) };
      }
      if (error instanceof SkillInputError) {
        return { status: 422, body: executionResponseBody("SKILL_INPUT_INVALID", false) };
      }
      logger.warn("skill.failed", {
        task_id: claims.task_id,
        tenant_id: claims.tenant_id,
        skill_id: claims.skill_id,
        code: "SKILL_EXECUTION_FAILED",
      });
      return { status: 500, body: executionResponseBody("SKILL_EXECUTION_FAILED", false) };
    }
  };

  const server = createServer((req, res) => {
    const requestId = randomUUID();
    void (async () => {
      if (req.method !== "POST" || req.url !== "/execute") {
        throw new HttpProblem(404, "NOT_FOUND", false);
      }
      const contentType = req.headers["content-type"];
      if (typeof contentType !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
        throw new HttpProblem(415, "UNSUPPORTED_MEDIA_TYPE", false);
      }
      const idempotencyKeyHeader = req.headers["idempotency-key"];
      if (typeof idempotencyKeyHeader !== "string" || !idempotencyPattern.test(idempotencyKeyHeader)) {
        throw new HttpProblem(400, "IDEMPOTENCY_KEY_REQUIRED", false);
      }
      const rawCredential = internalCredential(req);
      if (!rawCredential) throw new HttpProblem(401, "CREDENTIAL_REQUIRED", false);
      let claims: ExecutorCredentialClaims;
      try {
        claims = verifyExecutorCredential(rawCredential, {
          key: credentialKey,
          trustedKeys: credentialVerificationKeys,
          nowMs: now(),
        });
      } catch (error) {
        if (error instanceof ExecutorCredentialError && error.code === "CREDENTIAL_EXPIRED") {
          throw new HttpProblem(401, "CREDENTIAL_EXPIRED", false);
        }
        throw new HttpProblem(401, "CREDENTIAL_INVALID", false);
      }
      if (claims.idempotency_key !== idempotencyKeyHeader) {
        throw new HttpProblem(403, "CREDENTIAL_BINDING_MISMATCH", false);
      }
      const body = await readBoundedBody(req, maxBodyBytes, bodyTimeoutMs);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new HttpProblem(400, "INVALID_JSON", false);
      }
      const request = parseRequest(parsed);
      let computedDigest: string;
      try {
        computedDigest = computeExecutorInputDigest(request.input);
      } catch {
        throw new HttpProblem(422, "INVALID_REQUEST", false);
      }
      if (
        request.task_id !== claims.task_id ||
        request.tenant_id !== claims.tenant_id ||
        request.skill_id !== claims.skill_id ||
        request.idempotency_key !== claims.idempotency_key ||
        request.input_digest !== claims.input_digest ||
        computedDigest !== request.input_digest
      ) {
        throw new HttpProblem(403, "CREDENTIAL_BINDING_MISMATCH", false);
      }

      const cacheKey = `${request.tenant_id}\u0000${request.idempotency_key}`;
      const fingerprint = requestFingerprint(request);
      const current = now();
      for (const [key, entry] of idempotency) {
        if (entry.expiresAt <= current) idempotency.delete(key);
      }
      const existing = idempotency.get(cacheKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new HttpProblem(409, "IDEMPOTENCY_CONFLICT", false);
        const result = await existing.promise;
        sendJson(res, result.status, { ...result.body, request_id: requestId }, result.status >= 500);
        return;
      }
      if (idempotency.size >= maxIdempotencyEntries) {
        throw new HttpProblem(503, "EXECUTOR_BUSY", true);
      }
      const promise = runSkill(request, claims, requestId);
      idempotency.set(cacheKey, {
        fingerprint,
        expiresAt: current + idempotencyTtlMs,
        promise,
      });
      const result = await promise;
      sendJson(res, result.status, { ...result.body, request_id: requestId }, result.status >= 500);
    })().catch((error: unknown) => {
      const problem = error instanceof HttpProblem ? error : new HttpProblem(500, "INTERNAL", true);
      if (!(error instanceof HttpProblem)) {
        logger.error("request.failed", { request_id: requestId, code: "INTERNAL" });
      }
      sendError(res, problem, requestId);
    });
  });
  // Keep parser/header limits finite even before the manual body guard runs.
  server.requestTimeout = Math.max(bodyTimeoutMs + executionTimeoutMs + 5_000, 15_000);
  server.headersTimeout = Math.max(bodyTimeoutMs, 5_000);
  return server;
}

/** Parse a process or explicit TCP port without allowing an ephemeral port. */
export function parseExecutorPort(value: string | undefined, override?: number): number {
  if (override !== undefined) {
    if (!Number.isInteger(override) || override < 1 || override > 65_535) {
      throw new Error("PORT 必须是 1-65535 的十进制整数");
    }
    return override;
  }

  const rawPort = value ?? "8082";
  if (!/^[1-9]\d{0,4}$/u.test(rawPort)) {
    throw new Error("PORT 必须是 1-65535 的十进制整数");
  }
  const port = Number(rawPort);
  if (port > 65_535) throw new Error("PORT 必须是 1-65535 的十进制整数");
  return port;
}

/** Executor is a private same-host service and must never bind beyond loopback. */
export function parseExecutorBindHost(value: string | undefined): string {
  const host = value ?? "127.0.0.1";
  if (typeof host !== "string" || host.length === 0 || host.length > 255 ||
    /[\u0000-\u001f\u007f]/u.test(host)) {
    throw new Error("EXECUTOR_BIND_HOST 配置无效");
  }
  const version = isIP(host);
  if (!((version === 4 && host.split(".")[0] === "127") || (version === 6 && host === "::1"))) {
    throw new Error("EXECUTOR_BIND_HOST 必须是 loopback IP");
  }
  return host;
}

/** Production process entrypoint helper; bootstrap refuses an implicit key. */
export function bootstrapExecutorServer(
  port?: number,
  credentialKey = parseExecutorCredentialKey(),
  host = process.env.EXECUTOR_BIND_HOST,
  skills?: ReadonlyMap<string, CloudSkill>,
): Server {
  const validatedPort = parseExecutorPort(process.env.PORT, port);
  if (!credentialKey) throw new Error("执行器启动需要配置 EXECUTOR_CREDENTIAL_SECRET");
  if (!skills || skills.size === 0) {
    throw new Error("执行器启动需要显式注入受审计的 Cloud Skill registry");
  }
  const validatedHost = parseExecutorBindHost(host);
  const server = createExecutorServer({
    credentialKey,
    credentialVerificationKeys: parseExecutorCredentialTrustedKeys(),
    skills,
  });
  const logger = createConsoleLogger("executor");
  server.listen(validatedPort, validatedHost, () =>
    logger.info("listening", { port: validatedPort, host: validatedHost }));
  return server;
}

export {
  computeExecutorInputDigest,
  getDevelopmentExecutorCredentialKey,
  issueExecutorCredential,
  parseExecutorCredentialKey,
  parseExecutorCredentialTrustedKeys,
  verifyExecutorCredential,
  EXECUTOR_CREDENTIAL_HEADER,
  EXECUTOR_CREDENTIAL_MAX_TTL_MS,
  EXECUTOR_REQUEST_SCHEMA,
};

export type { ExecutorCredentialClaims, ExecutorCredentialKey } from "./credential.js";
