import { describe, expect, it, vi } from "vitest";
import { AgentManagementService } from "../src/agent-management-service.js";

describe("智能体管理服务", () => {
  it("单智能体也返回当前项，并只允许快照中的真实目标", async () => {
    const selectAgent = vi.fn(async () => undefined);
    const service = new AgentManagementService({
      currentAgentId: () => "main",
      agents: () => [{ agentId: "main", name: "龙枢助手", enabled: true, builtIn: true }],
      installableAgents: () => [],
      selectAgent,
      installAgent: async () => undefined,
      enableAgent: async () => undefined,
      disableAgent: async () => undefined,
    });
    expect(service.read()).toMatchObject({ currentAgentId: "main", agents: [{ agentId: "main" }] });
    await expect(service.perform({ action: "select", agentId: "unknown" })).rejects.toThrow("未启用");
    await service.perform({ action: "select", agentId: "main" });
    expect(selectAgent).toHaveBeenCalledWith("main");
  });

  it("安装与启停只接受目录或 Registry 中存在的 Pack", async () => {
    const installAgent = vi.fn(async () => undefined);
    const enableAgent = vi.fn(async () => undefined);
    const disableAgent = vi.fn(async () => undefined);
    const service = new AgentManagementService({
      currentAgentId: () => "main",
      agents: () => [
        { agentId: "main", name: "龙枢助手", enabled: true, builtIn: true },
        { agentId: "hr", name: "HR 助理", packId: "longhub.hr-suite", enabled: true, builtIn: false },
      ],
      installableAgents: () => [{
        packId: "longhub.finance-suite", version: "1.0.0", agentId: "finance",
        label: "财务助理", state: "ready",
      }],
      selectAgent: async () => undefined,
      installAgent,
      enableAgent,
      disableAgent,
    });
    await service.perform({ action: "install", packId: "longhub.finance-suite" });
    await service.perform({ action: "disable", packId: "longhub.hr-suite" });
    await service.perform({ action: "enable", packId: "longhub.hr-suite" });
    expect(installAgent).toHaveBeenCalledOnce();
    expect(disableAgent).toHaveBeenCalledOnce();
    expect(enableAgent).toHaveBeenCalledOnce();
    await expect(service.perform({ action: "disable", packId: "missing" })).rejects.toThrow("尚未安装");
  });
});
