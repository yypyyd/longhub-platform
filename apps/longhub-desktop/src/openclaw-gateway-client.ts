import { execFile } from "node:child_process";
import { OPENCLAW_COMPAT_CONTRACT } from "@longhub/openclaw-compat";
import { redactLogText } from "@longhub/observability";

const RPC = OPENCLAW_COMPAT_CONTRACT.gatewayRpc;

export interface GatewayConfigSnapshot {
  hash: string;
  config: Record<string, unknown>;
}

export interface GatewayAgentsResult {
  defaultId: string;
  agents: Array<{ id: string }>;
}

export interface OpenClawGatewayClient {
  getConfig(): Promise<GatewayConfigSnapshot>;
  replaceAgents(agents: readonly unknown[], baseHash: string): Promise<void>;
  listAgents(): Promise<GatewayAgentsResult>;
}

export interface GatewayRpcTransport {
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface OpenClawCliGatewayTransportOptions {
  nodeExecutable: string;
  entryScript: string;
  wsUrl: string;
  token?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 不是对象`);
  }
  return value as Record<string, unknown>;
}

/** 通过锁定 OpenClaw CLI 建立真实 Gateway RPC，避免复制其设备握手协议。 */
export class OpenClawCliGatewayTransport implements GatewayRpcTransport {
  constructor(private readonly options: OpenClawCliGatewayTransportOptions) {}

  private sensitiveValues(): string[] {
    return [
      this.options.token,
      this.options.env?.OPENCLAW_GATEWAY_TOKEN,
      this.options.env?.LONGHUB_MODEL_TOKEN,
      this.options.env?.LONGHUB_BRIDGE_TOKEN,
    ].filter((value): value is string => typeof value === "string" && value.length >= 8);
  }

  call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const args = [
      this.options.entryScript,
      "gateway",
      "call",
      method,
      "--params",
      JSON.stringify(params),
      "--url",
      this.options.wsUrl,
      "--timeout",
      String(this.options.timeoutMs ?? 15_000),
      "--json",
      ...(this.options.token ? ["--token", this.options.token] : []),
    ];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.options.env,
      NODE_DISABLE_COMPILE_CACHE: "1",
      OPENCLAW_COMPILE_CACHE_DISABLED_RESPAWNED: "1",
    };
    // Vitest worker markers make OpenClaw's one-shot CLI exit early; this child is a real
    // packaged-CLI contract invocation, not an in-process OpenClaw unit test.
    for (const key of Object.keys(env)) {
      if (key === "VITEST" || key.startsWith("VITEST_") || key.startsWith("OPENCLAW_VITEST_")) delete env[key];
    }
    if (env.NODE_ENV === "test") delete env.NODE_ENV;
    return new Promise((resolve, reject) => {
      execFile(
        this.options.nodeExecutable,
        args,
        {
          encoding: "utf8",
          // OpenClaw launcher 的 compile-cache wrapper 使用 stdio:inherit；短命 RPC 子进程
          // 禁用该次 respawn，确保 execFile 能可靠捕获结构化 JSON 响应。
          env,
          timeout: this.options.timeoutMs ?? 15_000,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(
              `OpenClaw RPC ${method} 失败: ${redactLogText(
                (stderr || stdout || error.message).trim(),
                4_096,
                this.sensitiveValues(),
              )}`,
            ));
            return;
          }
          const output = stdout.trim() || stderr.trim();
          try {
            resolve(JSON.parse(output) as unknown);
          } catch (parseError) {
            reject(
              new Error(
                `OpenClaw RPC ${method} 返回非 JSON: ${
                  parseError instanceof Error ? parseError.message : String(parseError)
                }; output=${JSON.stringify(redactLogText(output.slice(0, 500), 500, this.sensitiveValues()))}`,
              ),
            );
          }
        },
      );
    });
  }
}

export class OpenClawGatewayConfigClient implements OpenClawGatewayClient {
  constructor(private readonly transport: GatewayRpcTransport) {}

  async getConfig(): Promise<GatewayConfigSnapshot> {
    const result = asRecord(await this.transport.call(RPC.configGet, {}), `${RPC.configGet} 响应`);
    if (result.valid === false) throw new Error("Gateway 当前配置无效，拒绝执行热更新");
    if (typeof result.hash !== "string" || result.hash.length === 0) {
      throw new Error("config.get 响应缺少 baseHash");
    }
    return { hash: result.hash, config: asRecord(result.config, "config.get.config") };
  }

  async replaceAgents(agents: readonly unknown[], baseHash: string): Promise<void> {
    if (!baseHash) throw new Error("替换 agents.list 必须提供 baseHash");
    await this.transport.call(RPC.configPatch, {
      raw: JSON.stringify({ agents: { list: agents } }),
      baseHash,
      replacePaths: [...RPC.replacePaths],
      note: RPC.patchNote,
    });
  }

  async listAgents(): Promise<GatewayAgentsResult> {
    const result = asRecord(await this.transport.call(RPC.agentsList, {}), `${RPC.agentsList} 响应`);
    if (typeof result.defaultId !== "string" || !Array.isArray(result.agents)) {
      throw new Error("agents.list 响应格式无效");
    }
    const agents = result.agents.map((value) => {
      const agent = asRecord(value, "agents.list agent");
      if (typeof agent.id !== "string") throw new Error("agents.list agent 缺少 id");
      return { id: agent.id };
    });
    return { defaultId: result.defaultId, agents };
  }
}
