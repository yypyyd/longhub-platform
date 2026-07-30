import { describe, expect, it } from "vitest";
import { agentPackInstallUrl, parseAgentPackInstallUrl } from "../src/agent-install-navigation.js";

describe("Agent Pack 窄权限导航", () => {
  it("只往返合法 packId", () => {
    const url = agentPackInstallUrl("longhub.hr-suite");
    expect(url).toBe("longhub-agent://install/?packId=longhub.hr-suite");
    expect(parseAgentPackInstallUrl(url)).toEqual({ packId: "longhub.hr-suite" });
    expect(() => agentPackInstallUrl("../escape")).toThrow("Pack ID 无效");
  });

  it("拒绝额外命令、凭据、路径、fragment 和其他协议", () => {
    for (const target of [
      "https://install/?packId=longhub.hr-suite",
      "longhub-agent://other/?packId=longhub.hr-suite",
      "longhub-agent://install/run?packId=longhub.hr-suite",
      "longhub-agent://install/?packId=longhub.hr-suite&command=exec",
      "longhub-agent://user:pass@install/?packId=longhub.hr-suite",
      "longhub-agent://install/?packId=longhub.hr-suite#secret",
      "not a url",
    ]) expect(parseAgentPackInstallUrl(target)).toBeUndefined();
  });
});

