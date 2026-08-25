import { describe, expect, it } from "vitest";
import { AgentHandoffCoordinator } from "../src/agent-handoff.js";
import { composeNoCodeAgentPrompt, createNoCodeAgentOverlay, parseNoCodeAgentOverlay } from "../src/nocode-agent-overlay.js";
import { importOpenClawContentSkill } from "../src/openclaw-content-importer.js";

describe("无代码 Agent、摘要转交与 OpenClaw 内容降权导入", () => {
  it("Agent 覆盖层不修改签名 Profile，也不能声明模型、权限或 plugin", () => {
    const profile = Object.freeze({ profileId: "longhub.agent.hr", modelPolicyId: "longhub.model.default", permissions: ["hr.read"] });
    const overlay = createNoCodeAgentOverlay({
      baseProfileId: profile.profileId,
      targetAgentId: "hr",
      name: "我的招聘助手",
      description: "偏好简洁回答",
      preferences: { language: "zh-CN", tone: "concise" },
      personalEntryIds: [],
      skillIds: ["longhub.skill.resume-screen"],
    });
    expect(composeNoCodeAgentPrompt(overlay)).toContain("我的招聘助手");
    expect(profile).toEqual({ profileId: "longhub.agent.hr", modelPolicyId: "longhub.model.default", permissions: ["hr.read"] });
    expect(() => parseNoCodeAgentOverlay({ ...overlay, plugin: "evil.js" })).toThrow("格式");
    expect(() => parseNoCodeAgentOverlay({ ...overlay, model: "attacker-model" })).toThrow("格式");
  });

  it("跨 Agent 只转交用户确认的摘要，不继承记忆、权限且 nonce 一次性", () => {
    const handoff = new AgentHandoffCoordinator();
    const preview = handoff.preview("hr", "main", "候选人有 8 年 TypeScript 经验。");
    const accepted = handoff.confirm(preview.handoffId, "main", preview.confirmationToken);
    expect(accepted).toMatchObject({ targetAgentId: "main", inheritedPermissions: [], inheritedMemory: [] });
    expect(accepted.message).toContain(preview.summary);
    expect(() => handoff.confirm(preview.handoffId, "main", preview.confirmationToken)).toThrow("已使用");
  });

  it("OpenClaw 只允许 Markdown/JSON/真实静态图片，导入后为 user 零权限", () => {
    const imported = importOpenClawContentSkill({
      "SKILL.md": "# 面试提纲\n根据岗位要求生成面试问题。",
      "examples/example.json": "{\"role\":\"frontend\"}",
    });
    expect(imported).toMatchObject({ source: "openclaw_import", permissions: [] });
    expect(imported.skill.id).toMatch(/^user\.skill\./);
    expect(() => importOpenClawContentSkill({ "SKILL.md": "# Bad\nhttps://evil.example/run" })).toThrow("远程");
    expect(() => importOpenClawContentSkill({ "SKILL.md": "# Bad", "openclaw.plugin.json": "{}" })).toThrow("插件");
    expect(() => importOpenClawContentSkill({ "SKILL.md": "# Bad", "image.png": "not a png" })).toThrow("扩展名");
  });
});
