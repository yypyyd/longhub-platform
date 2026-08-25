/** HTTP 处理公共工具：JSON 响应、错误、请求体读取、Bearer 凭据。 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Request bodies are read through one bounded implementation.  A surprising
 * number of routes are reachable before authentication (registration, login,
 * and preflight), so an unbounded async iterator here would be a process-wide
 * memory denial of service.
 */
export const DEFAULT_REQUEST_BODY_MAX_BYTES = 1 << 20;
export const DEFAULT_REQUEST_BODY_TIMEOUT_MS = 10_000;

export type RequestBodyErrorCode = "BODY_TOO_LARGE" | "BODY_TIMEOUT" | "BODY_READ_FAILED";

export class RequestBodyError extends Error {
  readonly code: RequestBodyErrorCode;
  readonly status: 400 | 408 | 413;
  readonly retryable: boolean;

  constructor(code: RequestBodyErrorCode) {
    const messages: Record<RequestBodyErrorCode, string> = {
      BODY_TOO_LARGE: "请求体超过大小限制",
      BODY_TIMEOUT: "读取请求超时",
      BODY_READ_FAILED: "请求体读取失败",
    };
    super(messages[code]);
    this.name = "RequestBodyError";
    this.code = code;
    this.status = code === "BODY_TOO_LARGE" ? 413 : code === "BODY_TIMEOUT" ? 408 : 400;
    this.retryable = code === "BODY_TIMEOUT";
  }
}

export interface ReadBodyOptions {
  maxBytes?: number;
  timeoutMs?: number;
}

export function hasJsonContentType(req: IncomingMessage): boolean {
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string") return false;
  return contentType.split(";", 1)[0]!.trim().toLowerCase() === "application/json";
}

export function requireJsonContentType(req: IncomingMessage, res: ServerResponse): boolean {
  if (hasJsonContentType(req)) return true;
  sendError(res, 415, "UNSUPPORTED_MEDIA_TYPE", "只接受 application/json 请求");
  return false;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function sendError(res: ServerResponse, status: number, code: string, message: string, retryable = false): void {
  sendJson(res, status, { code, message, request_id: randomUUID(), retryable });
}

export function readBody(
  req: NodeJS.ReadableStream,
  options: ReadBodyOptions = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? DEFAULT_REQUEST_BODY_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_BODY_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new TypeError("请求体限制配置无效"));
  }

  const incoming = req as IncomingMessage;
  const declared = incoming.headers?.["content-length"];
  if (
    Array.isArray(declared) ||
    (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maxBytes))
  ) {
    // Drain the stream after rejecting so Node can reuse/close the socket
    // without retaining an attacker-controlled unread body.
    incoming.resume?.();
    return Promise.reject(new RequestBodyError("BODY_TOO_LARGE"));
  }

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    };
    const finishError = (error: RequestBodyError) => {
      if (settled) return;
      settled = true;
      cleanup();
      incoming.resume?.();
      reject(error);
    };
    const onData = (chunk: Buffer | string | Uint8Array) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) {
        finishError(new RequestBodyError("BODY_TOO_LARGE"));
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
    const onError = () => finishError(new RequestBodyError("BODY_READ_FAILED"));
    const onAborted = () => finishError(new RequestBodyError("BODY_TIMEOUT"));
    const timer = setTimeout(() => finishError(new RequestBodyError("BODY_TIMEOUT")), timeoutMs);

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
  });
}

/** Explicit alias used by routes with a smaller protocol-specific limit. */
export function readBoundedBody(
  req: NodeJS.ReadableStream,
  maxBytes: number,
  timeoutMs = DEFAULT_REQUEST_BODY_TIMEOUT_MS,
): Promise<string> {
  return readBody(req, { maxBytes, timeoutMs });
}

export async function readJson<T>(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes = DEFAULT_REQUEST_BODY_MAX_BYTES,
): Promise<T | undefined> {
  if (!requireJsonContentType(req, res)) return undefined;
  try {
    const parsed: unknown = JSON.parse(await readBody(req, { maxBytes }));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      sendError(res, 400, "INVALID_JSON", "请求体必须是 JSON 对象");
      return undefined;
    }
    return parsed as T;
  } catch (error) {
    if (error instanceof RequestBodyError) {
      sendError(res, error.status, error.code, error.message, error.retryable);
      return undefined;
    }
    sendError(res, 400, "INVALID_JSON", "请求体不是合法 JSON");
    return undefined;
  }
}

export function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
}
