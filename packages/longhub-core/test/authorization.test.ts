import { describe, expect, it } from "vitest";
import {
  bridgeConfirmationBinding,
  bridgePayloadDigest,
  buildBridgeConfirmationDisplay,
  clampBudget,
  intersectBridgePermissions,
  permissionRequiresConfirmation,
  type BridgeSkillGrant,
} from "../src/index.js";

const grant: BridgeSkillGrant = {
  skillId: "longhub.skill.resume-screen",
  packId: "longhub.hr-suite",
  packVersion: "1.0.0",
  profileVersion: "1.0.0",
  requiredPermissions: ["connector:hr-api:read", "connector:hr-api:write"],
  profilePermissions: ["connector:hr-api:read", "connector:hr-api:write"],
  packPermissions: ["connector:hr-api:read", "connector:hr-api:write"],
  tenantPermissions: ["connector:hr-api:read"],
  devicePermissions: ["connector:hr-api:read", "connector:hr-api:write"],
  budget: { maxTokens: 10_000, maxCostCents: 20, maxDurationMs: 30_000 },
};

describe("Core 授权原语", () => {
  it("只返回所有权限来源都允许的交集", () => {
    expect(intersectBridgePermissions(grant)).toEqual(["connector:hr-api:read"]);
  });

  it("确认绑定摘要与对象字段顺序无关，但输入变化会改变摘要", () => {
    const first = bridgePayloadDigest(grant.skillId, { name: "张三", salary: 10_000 });
    const reordered = bridgePayloadDigest(grant.skillId, { salary: 10_000, name: "张三" });
    const changed = bridgePayloadDigest(grant.skillId, { name: "李四", salary: 10_000 });
    expect(first).toBe(reordered);
    expect(changed).not.toBe(first);
    expect(bridgeConfirmationBinding({
      agentId: "hr",
      skillId: "longhub.skill.offer-letter",
      profileVersion: grant.profileVersion,
      sessionId: "session-1",
      toolCallId: "call-1",
      permissions: ["connector:hr-api:write"],
      payloadDigest: first,
      display: {
        action: "生成录用通知书",
        object: "候选人录用通知",
        recipient: "张三",
        dataScope: ["月薪：10000"],
        estimatedCostCents: 0,
      },
    })).toHaveLength(64);
  });

  it("确认展示只从受信声明和绑定参数计算，展示变化会改变 binding", () => {
    const descriptor = {
      action: "生成录用通知书",
      object: "候选人录用通知",
      recipientField: "candidateName",
      dataFields: [{ label: "岗位", field: "position" }],
      estimatedCostCents: 0,
    };
    expect(buildBridgeConfirmationDisplay(descriptor, {
      candidateName: "张三",
      position: "前端工程师",
    })).toEqual({
      action: "生成录用通知书",
      object: "候选人录用通知",
      recipient: "张三",
      dataScope: ["岗位：前端工程师"],
      estimatedCostCents: 0,
    });
    expect(() => buildBridgeConfirmationDisplay(
      descriptor,
      { candidateName: "张三\n伪造操作", position: "前端工程师" },
    )).toThrow("内容无效");
    const base = {
      agentId: "hr",
      skillId: "longhub.skill.offer-letter",
      profileVersion: "1.0.0",
      sessionId: "session-1",
      toolCallId: "call-1",
      permissions: ["connector:hr-api:write"],
      payloadDigest: "a".repeat(64),
    };
    const firstBinding = bridgeConfirmationBinding({
      ...base,
      display: {
        action: "生成录用通知书",
        object: "候选人录用通知",
        recipient: "张三",
        dataScope: ["岗位：前端工程师"],
        estimatedCostCents: 0,
      },
    });
    expect(bridgeConfirmationBinding({
      ...base,
      display: {
        action: "生成录用通知书",
        object: "候选人录用通知",
        recipient: "李四",
        dataScope: ["岗位：前端工程师"],
        estimatedCostCents: 0,
      },
    })).not.toBe(firstBinding);
  });

  it("调用方预算只能降低上限，写权限需要确认", () => {
    expect(clampBudget(
      { maxTokens: 99_999, maxCostCents: 5, maxDurationMs: 99_999 },
      grant.budget,
    )).toEqual({ maxTokens: 10_000, maxCostCents: 5, maxDurationMs: 30_000 });
    expect(permissionRequiresConfirmation("connector:hr-api:read")).toBe(false);
    expect(permissionRequiresConfirmation("connector:hr-api:write")).toBe(true);
  });
});
