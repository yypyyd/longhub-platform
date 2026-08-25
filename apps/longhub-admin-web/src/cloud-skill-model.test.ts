import { describe, expect, it } from "vitest";
import {
  cloudSkillOrderStatusLabel,
  cloudSkillSubscriptionStatusLabel,
  isValidCloudSkillId,
  isValidCloudSkillPlanId,
  isValidPositiveInteger,
  isValidYuanAmount,
  normalizeSkillIds,
} from "./cloud-skill-model";

describe("云端 Skill 后台模型", () => {
  it("规范化逗号、中文逗号和空格分隔的 Skill ID，并去重", () => {
    expect(normalizeSkillIds("content-draft， meeting-summary content-draft"))
      .toEqual(["content-draft", "meeting-summary"]);
  });

  it("只接受小写、数字和受限标点组成的方案 ID", () => {
    expect(isValidCloudSkillPlanId("content-pro")).toBe(true);
    expect(isValidCloudSkillPlanId("longhub.pro")).toBe(true);
    expect(isValidCloudSkillPlanId("Content Pro")).toBe(false);
    expect(isValidCloudSkillPlanId("1content-pro")).toBe(false);
    expect(isValidCloudSkillPlanId("content_pro")).toBe(false);
    expect(isValidCloudSkillPlanId("a")).toBe(true);
  });

  it("要求方案绑定规范的 publisher.skill.name ID", () => {
    expect(isValidCloudSkillId("longhub.skill.resume-screen")).toBe(true);
    expect(isValidCloudSkillId("longhub.tools.skill.resume.screen")).toBe(true);
    expect(isValidCloudSkillId("resume-screen")).toBe(false);
    expect(isValidCloudSkillId("LongHub.skill.resume")).toBe(false);
  });

  it("在发送前校验金额和整数额度", () => {
    expect(isValidYuanAmount("0")).toBe(true);
    expect(isValidYuanAmount("99.90")).toBe(true);
    expect(isValidYuanAmount("-1")).toBe(false);
    expect(isValidYuanAmount("Infinity")).toBe(false);
    expect(isValidPositiveInteger("10")).toBe(true);
    expect(isValidPositiveInteger("1.5")).toBe(false);
    expect(isValidPositiveInteger("Infinity")).toBe(false);
  });

  it("为订阅和订单显示稳定的中文状态", () => {
    expect(cloudSkillSubscriptionStatusLabel("refunded")).toBe("已退款");
    expect(cloudSkillOrderStatusLabel("paid")).toBe("已完成");
    expect(cloudSkillOrderStatusLabel("unknown")).toBe("unknown");
  });
});
