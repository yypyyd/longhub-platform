import type { Readable, Writable } from "node:stream";

/** Core RPC V1 消息格式，见 contracts/core-rpc/core-rpc-v1.md */
export const RPC_VERSION = "1.0";

export interface RpcError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface RpcRequest {
  rpc: typeof RPC_VERSION;
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcResponse {
  rpc: typeof RPC_VERSION;
  id: string;
  result?: unknown;
  error?: RpcError;
}

/** 通知：无 id，无响应 */
export interface RpcNotification {
  rpc: typeof RPC_VERSION;
  method: string;
  params?: Record<string, unknown>;
}

export type RpcMessage = RpcRequest | RpcResponse | RpcNotification;

export function isRequest(msg: RpcMessage): msg is RpcRequest {
  return "id" in msg && "method" in msg;
}

export function isResponse(msg: RpcMessage): msg is RpcResponse {
  return "id" in msg && !("method" in msg);
}

/** NDJSON 通道：一行一个 JSON 消息 */
export interface RpcChannel {
  send(message: RpcMessage): void;
  close(): void;
}

export function createLineChannel(
  input: Readable,
  output: Writable,
  onMessage: (message: RpcMessage) => void,
): RpcChannel {
  let buffer = "";
  const onData = (chunk: Buffer) => {
    buffer += chunk.toString("utf-8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.length === 0) continue;
      onMessage(JSON.parse(line) as RpcMessage);
    }
  };
  input.on("data", onData);
  return {
    send(message) {
      output.write(JSON.stringify(message) + "\n");
    },
    close() {
      input.off("data", onData);
    },
  };
}
