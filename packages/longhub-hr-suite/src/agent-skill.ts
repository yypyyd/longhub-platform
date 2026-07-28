/**
 * HR 套装智能体技能（L2）：经小龙虾适配层调用 OpenClaw 底座生成内容。
 * 只依赖 UpstreamRuntimeAdapter 契约，不接触上游内部类型（ADR-LH-009）。
 */
import { defineSkill, type SkillDefinition } from "@longhub/sdk";
import type { UpstreamRuntimeAdapter } from "@longhub/xiaolongxia-adapter";

export const HR_AGENT_ID = "longhub.agent.hr";

export interface JdDraftInput {
  position: string;
  /** 岗位硬性要求 */
  mustHaves: string[];
  /** 团队/业务背景（可选） */
  teamContext?: string;
}

export interface JdDraftOutput {
  jd: string;
}

/**
 * 岗位 JD 起草：把结构化输入组织成提示词交给底座智能体，流式收集为完整文本。
 * @param upstream 惰性提供已初始化的底座适配器（真实环境 OpenClaw Gateway，测试环境 Mock）
 */
export function createJdDraftSkill(
  upstream: () => Promise<UpstreamRuntimeAdapter>,
): SkillDefinition<JdDraftInput, JdDraftOutput> {
  return defineSkill<JdDraftInput, JdDraftOutput>({
    id: "longhub.skill.jd-draft",
    level: "L2",
    permissions: ["connector:hr-api:read"],
    async run(input) {
      if (!input.position.trim()) throw new Error("position 不能为空");
      const prompt = [
        `请为「${input.position}」岗位起草一份职位描述（JD）。`,
        `硬性要求：${input.mustHaves.join("、") || "无"}。`,
        ...(input.teamContext ? [`团队背景：${input.teamContext}。`] : []),
      ].join("\n");

      const adapter = await upstream();
      const session = await adapter.createSession(HR_AGENT_ID);
      let finalText = "";
      for await (const event of adapter.sendMessage(session, prompt)) {
        if (event.type === "done") {
          finalText = event.finalText;
        } else if (event.type === "error") {
          throw new Error(`底座生成失败 [${event.code}] ${event.message}`);
        }
      }
      if (!finalText) throw new Error("底座未返回内容");
      return { jd: finalText };
    },
  });
}
