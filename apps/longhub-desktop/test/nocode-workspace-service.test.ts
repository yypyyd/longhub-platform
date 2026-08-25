import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NoCodeWorkspaceService } from "../src/nocode-workspace-service.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "longhub-nocode-workspace-"));
  roots.push(root);
  const runs: string[] = [];
  const service = new NoCodeWorkspaceService({
    stateFile: join(root, "workspace.json"),
    owner: "device/current-windows-user",
    agents: () => [
      { agentId: "hr", profileId: "longhub.profile.hr", name: "HR 助理" },
      { agentId: "finance", profileId: "longhub.profile.finance", name: "财务助理" },
    ],
    personalEntryIds: (agentId) => agentId === "hr" ? ["profile-hr"] : [],
    authorizedSkillIds: (agentId) => agentId === "hr" ? ["longhub.skill.resume-screen"] : [],
    async runWorkflow(workflow, agentId) {
      runs.push(`${workflow.workflowId}:${agentId}`);
      return { runId: "workflow-run-1", outputs: { first: "ok" }, costMicros: 0, executedSteps: 1 };
    },
  });
  return { root, runs, service };
}

describe("设备本地无代码工作台", () => {
  it("创建、导出和导入 Content Skill 时保持零权限并重建身份", async () => {
    const ctx = fixture();
    let snapshot = await ctx.service.perform({
      action: "content.create",
      name: "招聘写作规范",
      description: "统一语气",
      instructions: "只使用客观、可核验的候选人信息。",
    });
    const firstId = snapshot.contentSkills[0]!.skillId;
    snapshot = await ctx.service.perform({ action: "content.export", skillId: firstId });
    expect(snapshot.exportedContent?.serialized).toContain('"permissions": []');
    snapshot = await ctx.service.perform({ action: "content.import", serialized: snapshot.exportedContent!.serialized });
    expect(snapshot.contentSkills).toHaveLength(2);
    expect(snapshot.contentSkills[1]!.skillId).not.toBe(firstId);

    const reloaded = fixture();
    expect(reloaded.service.read().contentSkills).toEqual([]);
    expect(() => new NoCodeWorkspaceService({
      stateFile: join(ctx.root, "workspace.json"),
      owner: "different/device-owner",
      agents: () => [], personalEntryIds: () => [], authorizedSkillIds: () => [],
      runWorkflow: async () => ({ runId: "x", outputs: {}, costMicros: 0, executedSteps: 0 }),
    })).toThrow("owner");
  });

  it("只组合已授权 Skill，并持久化 Agent 覆盖层且不修改签名 Profile", async () => {
    const ctx = fixture();
    const content = await ctx.service.perform({
      action: "content.create", name: "本机内容", description: "", instructions: "保持简洁。",
    });
    const contentId = content.contentSkills[0]!.skillId;
    let snapshot = await ctx.service.perform({
      action: "workflow.create",
      name: "安全筛选",
      steps: [{ id: "first", kind: "skill", skillId: "longhub.skill.resume-screen", input: { limit: 10 } }],
    });
    snapshot = await ctx.service.perform({ action: "workflow.run", workflowId: snapshot.workflows[0]!.workflowId, agentId: "hr" });
    expect(snapshot.lastWorkflowRun).toMatchObject({ executedSteps: 1 });
    expect(ctx.runs).toHaveLength(1);
    await expect(ctx.service.perform({
      action: "workflow.create", name: "越权", steps: [{ id: "x", kind: "skill", skillId: "unknown.skill", input: {} }],
    })).rejects.toThrow("未知");

    snapshot = await ctx.service.perform({
      action: "agent.create",
      baseProfileId: "longhub.profile.hr",
      targetAgentId: "hr",
      name: "我的招聘助手",
      description: "只使用当前设备资料",
      language: "zh-CN",
      tone: "balanced",
      personalEntryIds: ["profile-hr"],
      skillIds: [contentId, "longhub.skill.resume-screen"],
    });
    expect(snapshot.overlays[0]).not.toHaveProperty("model");
    expect(snapshot.overlays[0]).not.toHaveProperty("permissions");
    await expect(ctx.service.perform({
      action: "agent.create", baseProfileId: "longhub.profile.hr", targetAgentId: "hr",
      name: "越界", description: "", language: "zh-CN", tone: "concise",
      personalEntryIds: ["finance-secret"], skillIds: [],
    })).rejects.toThrow("跨 Agent");
  });

  it("摘要转交必须预览、目标绑定且一次确认，不继承记忆或权限", async () => {
    const ctx = fixture();
    let snapshot = await ctx.service.perform({
      action: "handoff.preview", sourceAgentId: "hr", targetAgentId: "finance", summary: "候选人已接受报价。",
    });
    const preview = snapshot.pendingHandoff!;
    await expect(ctx.service.perform({
      action: "handoff.confirm", handoffId: preview.handoffId, targetAgentId: "hr", confirmationToken: preview.confirmationToken,
    })).rejects.toThrow("无效");
    snapshot = await ctx.service.perform({
      action: "handoff.preview", sourceAgentId: "hr", targetAgentId: "finance", summary: "候选人已接受报价。",
    });
    const next = snapshot.pendingHandoff!;
    snapshot = await ctx.service.perform({
      action: "handoff.confirm", handoffId: next.handoffId, targetAgentId: "finance", confirmationToken: next.confirmationToken,
    });
    expect(snapshot.completedHandoff).toMatchObject({ targetAgentId: "finance", inheritedPermissions: [], inheritedMemory: [] });
  });
});
