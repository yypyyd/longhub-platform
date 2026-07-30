import { describe, expect, it } from "vitest";
import {
  installOpenClawSelectorPolicy,
  OPENCLAW_SELECTOR_CONTRACT,
  openClawSelectorPolicyScript,
} from "../src/openclaw-selector-policy.js";

describe("OpenClaw Agent Selector 薄适配层", () => {
  it("只接受合法 agentId、固定保留 main，并安全编码显示名", () => {
    const script = openClawSelectorPolicyScript({
      allowedAgentIds: ["../bad", "MAIN", "longhub-agent-hr", "longhub-agent-hr"],
      agentLabels: { "longhub-agent-hr": "</script><img src=x>HR" },
    });
    expect(script).toContain('"allowedAgentIds":["main","longhub-agent-hr"]');
    expect(script).not.toContain("</script>");
    expect(script).toContain("\\u003c/script>");
    expect(script).toContain(JSON.stringify(OPENCLAW_SELECTOR_CONTRACT.selector));
    expect(script).toContain(JSON.stringify(OPENCLAW_SELECTOR_CONTRACT.activeRunButton));
  });

  it("通过受限 WebContents 接口注入，不要求 preload 或 IPC", async () => {
    const calls: string[] = [];
    await installOpenClawSelectorPolicy({
      async executeJavaScript(code) {
        calls.push(code);
        return undefined;
      },
    }, { allowedAgentIds: ["main", "hr"] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("MutationObserver");
    expect(calls[0]).toContain("selectAgent");
  });

  it("把已授权未安装 Agent 编码为唯一安装导航，不暴露设备凭据", () => {
    const script = openClawSelectorPolicyScript({
      allowedAgentIds: ["main"],
      installableAgents: [{
        packId: "longhub.hr-suite",
        agentId: "longhub-agent-hr",
        label: "HR 助理",
        state: "ready",
      }],
    });
    expect(script).toContain("longhub-agent://install/?packId=longhub.hr-suite");
    expect(script).toContain("HR 助理");
    expect(script).toContain("点击安装");
    expect(script).not.toContain("deviceToken");
  });
});
