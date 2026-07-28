/**
 * 适配层契约：龙枢内核只依赖这里的类型，不接触上游（OpenClaw）内部类型（ADR-LH-009）。
 */

export interface UpstreamSession {
  sessionId: string;
}

export type UpstreamEvent =
  | { type: "delta"; text: string }
  | { type: "done"; finalText: string }
  | { type: "error"; code: string; message: string; retryable: boolean };

export interface UpstreamRuntimeAdapter {
  /** 适配层协议版本 */
  readonly adapterVersion: string;
  /** 初始化底座运行时（连接/健康检查） */
  init(): Promise<void>;
  /** 创建智能体会话 */
  createSession(agentId: string): Promise<UpstreamSession>;
  /** 发送消息并流式接收输出 */
  sendMessage(session: UpstreamSession, text: string): AsyncIterable<UpstreamEvent>;
  /** 释放资源 */
  dispose(): Promise<void>;
}
