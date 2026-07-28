/** HTTP 处理公共工具：JSON 响应、错误、请求体读取、Bearer 凭据。 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function sendError(res: ServerResponse, status: number, code: string, message: string, retryable = false): void {
  sendJson(res, status, { code, message, request_id: randomUUID(), retryable });
}

export async function readBody(req: NodeJS.ReadableStream): Promise<string> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

export async function readJson<T>(req: IncomingMessage, res: ServerResponse): Promise<T | undefined> {
  try {
    return JSON.parse(await readBody(req)) as T;
  } catch {
    sendError(res, 400, "INVALID_JSON", "请求体不是合法 JSON");
    return undefined;
  }
}

export function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
}
