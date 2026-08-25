/**
 * Desktop Main 侧的 Core 进程客户端：拉起 core-process，
 * 提供 request/response 调用与任务事件订阅（Core RPC V1，NDJSON）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  createLineChannel,
  isResponse,
  RPC_VERSION,
  type RpcChannel,
  type RpcMessage,
  type TaskEvent,
  type BridgeConfirmationRequest,
  parseBridgeConfirmationRequest,
} from "@longhub/core";

export class CoreRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "CoreRequestError";
  }
}

export interface CoreClientOptions {
  /** core-process.js 绝对路径 */
  corePath: string;
  /** Node 运行时；Electron Main 下配合 ELECTRON_RUN_AS_NODE 使用 process.execPath */
  nodeExecutable?: string;
  env?: NodeJS.ProcessEnv;
}

export class CoreClient {
  private child: ChildProcess | undefined;
  private channel: RpcChannel | undefined;
  private reqSeq = 0;
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  private readonly eventListeners = new Set<(event: TaskEvent) => void>();
  private readonly confirmationListeners = new Set<(request: BridgeConfirmationRequest) => void>();

  constructor(private readonly options: CoreClientOptions) {}

  start(): void {
    if (this.child) return;
    const child = spawn(
      this.options.nodeExecutable ?? process.execPath,
      [this.options.corePath],
      {
        stdio: ["pipe", "pipe", "inherit"],
        env: this.options.env ?? process.env,
      },
    );
    this.child = child;
    this.channel = createLineChannel(child.stdout!, child.stdin!, (msg: RpcMessage) => {
      if (isResponse(msg)) {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new CoreRequestError(msg.error.code, msg.error.message, msg.error.retryable));
        else pending.resolve(msg.result);
      } else if ("method" in msg && msg.method === "event.task") {
        const event = msg.params as unknown as TaskEvent;
        for (const listener of this.eventListeners) listener(event);
      } else if ("method" in msg && msg.method === "event.confirm.request") {
        try {
          const request = parseBridgeConfirmationRequest(msg.params);
          for (const listener of this.confirmationListeners) listener(request);
        } catch {
          // 子进程事件不符合严格契约时安全丢弃，不能把任意载荷交给确认 UI。
        }
      }
    });
  }

  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.channel) throw new Error("Core 进程尚未启动");
    const id = `m-${++this.reqSeq}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.channel!.send({ rpc: RPC_VERSION, id, method, params });
    });
  }

  onTaskEvent(listener: (event: TaskEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onConfirmationRequest(listener: (request: BridgeConfirmationRequest) => void): () => void {
    this.confirmationListeners.add(listener);
    return () => this.confirmationListeners.delete(listener);
  }

  stop(): void {
    this.channel?.close();
    this.child?.kill();
    this.child = undefined;
    this.channel = undefined;
    for (const { reject } of this.pending.values()) {
      reject(new Error("Core 进程已停止"));
    }
    this.pending.clear();
  }
}
