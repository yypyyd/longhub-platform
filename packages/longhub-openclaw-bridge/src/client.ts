import {
  parseBridgeExecuteRequest,
  type BridgeExecuteRequest,
  type BridgeExecuteResponse,
} from "./protocol.js";

export interface LongHubBridgeClientOptions {
  endpoint: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface LongHubBridgeClient {
  execute(request: BridgeExecuteRequest): Promise<unknown>;
}

export function createLongHubBridgeClient(options: LongHubBridgeClientOptions): LongHubBridgeClient {
  const endpoint = new URL(options.endpoint);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1") {
    throw new Error("LongHub Bridge 只允许使用 127.0.0.1 HTTP 端点");
  }
  if (!options.token || options.token.length < 32) throw new Error("LongHub Bridge 令牌无效");
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async execute(rawRequest) {
      const request = parseBridgeExecuteRequest(rawRequest);
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
        // 写操作的确认记录最长五分钟；本机 HTTP 超时必须略晚于确认 TTL。
        signal: AbortSignal.timeout(options.timeoutMs ?? 310_000),
      });
      const body = (await response.json()) as BridgeExecuteResponse;
      if (!response.ok || !body.ok) {
        const error = body.ok ? undefined : body.error;
        throw new Error(`LongHub Core 拒绝执行 [${error?.code ?? response.status}] ${error?.message ?? ""}`.trim());
      }
      return body.result;
    },
  };
}

export function createLongHubBridgeClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LongHubBridgeClient | undefined {
  const endpoint = env.LONGHUB_BRIDGE_URL;
  const token = env.LONGHUB_BRIDGE_TOKEN;
  if (!endpoint || !token) return undefined;
  return createLongHubBridgeClient({ endpoint, token });
}
