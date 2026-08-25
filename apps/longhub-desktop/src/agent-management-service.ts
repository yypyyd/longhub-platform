import type { InstallableAgentPack } from "./agent-pack-catalog.js";

export interface ManagedAgentSummary {
  readonly agentId: string;
  readonly name: string;
  readonly packId?: string;
  readonly enabled: boolean;
  readonly builtIn: boolean;
}

export interface AgentManagementSnapshot {
  readonly currentAgentId: string;
  readonly agents: readonly ManagedAgentSummary[];
  readonly installableAgents: readonly InstallableAgentPack[];
}

export type AgentManagementAction =
  | { readonly action: "select"; readonly agentId: string }
  | { readonly action: "install"; readonly packId: string }
  | { readonly action: "enable"; readonly packId: string }
  | { readonly action: "disable"; readonly packId: string };

export interface AgentManagementServiceOptions {
  readonly currentAgentId: () => string;
  readonly agents: () => readonly ManagedAgentSummary[];
  readonly installableAgents: () => readonly InstallableAgentPack[];
  readonly selectAgent: (agentId: string) => Promise<void>;
  readonly installAgent: (packId: string) => Promise<void>;
  readonly enableAgent: (packId: string) => Promise<void>;
  readonly disableAgent: (packId: string) => Promise<void>;
}

const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PACK_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/**
 * “智能体”产品页的单一业务入口。它只接受当前快照里存在的 Agent/Pack，实际生命周期、
 * entitlement 与 Gateway 回读仍由注入的可信协调器执行。
 */
export class AgentManagementService {
  constructor(private readonly options: AgentManagementServiceOptions) {}

  read(): AgentManagementSnapshot {
    const agents = this.options.agents().map((agent) => ({ ...agent }));
    const installableAgents = this.options.installableAgents().map((agent) => ({ ...agent }));
    const current = this.options.currentAgentId().toLowerCase();
    return {
      currentAgentId: agents.some((agent) => agent.enabled && agent.agentId === current) ? current : "main",
      agents,
      installableAgents,
    };
  }

  async perform(request: AgentManagementAction): Promise<AgentManagementSnapshot> {
    if (request.action === "select") {
      if (!AGENT_ID.test(request.agentId)) throw new Error("智能体 ID 无效");
      const target = this.read().agents.find((agent) => agent.agentId === request.agentId && agent.enabled);
      if (!target) throw new Error("目标智能体未启用");
      await this.options.selectAgent(target.agentId);
      return this.read();
    }

    if (!PACK_ID.test(request.packId)) throw new Error("智能体 Pack ID 无效");
    if (request.action === "install") {
      const candidate = this.read().installableAgents.find((agent) => agent.packId === request.packId);
      if (!candidate || candidate.state === "installing") throw new Error("智能体当前不可安装");
      await this.options.installAgent(candidate.packId);
      return this.read();
    }

    const installed = this.read().agents.find((agent) => agent.packId === request.packId && !agent.builtIn);
    if (!installed) throw new Error("智能体 Pack 尚未安装");
    if (request.action === "enable") await this.options.enableAgent(request.packId);
    else await this.options.disableAgent(request.packId);
    return this.read();
  }
}
