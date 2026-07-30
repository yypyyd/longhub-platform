import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  parseBridgeExecuteRequest,
  type BridgeExecuteRequest,
  type BridgeExecuteResponse,
} from "@longhub/openclaw-bridge";

const MAX_REQUEST_BYTES = 1024 * 1024;

export interface ToolBridgeConnection {
  endpoint: string;
  token: string;
}

export interface ToolBridgeHostOptions {
  token: string;
  execute(request: BridgeExecuteRequest): Promise<unknown>;
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const actualBuffer = Buffer.from(header.slice(7), "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function sendJson(response: ServerResponse, status: number, body: BridgeExecuteResponse): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("Bridge 请求体超出 1 MiB 限制");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/** 只绑定回环地址、只暴露单一路由的 Gateway → Core 受限 RPC 宿主。 */
export class ToolBridgeHost {
  private readonly server = createServer((request, response) => void this.handle(request, response));

  constructor(private readonly options: ToolBridgeHostOptions) {
    if (options.token.length < 32) throw new Error("Tool Bridge 启动令牌长度不足");
  }

  async start(): Promise<ToolBridgeConnection> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    });
    const address = this.server.address() as AddressInfo;
    return {
      endpoint: `http://127.0.0.1:${address.port}/v1/execute`,
      token: this.options.token,
    };
  }

  async stop(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST" || request.url !== "/v1/execute") {
      sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "路由不存在" } });
      return;
    }
    if (!tokenMatches(request.headers.authorization, this.options.token)) {
      sendJson(response, 401, { ok: false, error: { code: "UNAUTHORIZED", message: "Bridge 认证失败" } });
      return;
    }
    if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
      sendJson(response, 415, { ok: false, error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "仅接受 JSON" } });
      return;
    }
    try {
      const parsed = parseBridgeExecuteRequest(await readJson(request));
      const result = await this.options.execute(parsed);
      sendJson(response, 200, { ok: true, result });
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "BRIDGE_EXECUTION_FAILED";
      const status = code === "BRIDGE_FORBIDDEN"
        ? 403
        : code === "BRIDGE_CONFIRMATION_REQUIRED" ? 409 : 400;
      sendJson(response, status, {
        ok: false,
        error: { code, message: error instanceof Error ? error.message : String(error) },
      });
    }
  }
}
