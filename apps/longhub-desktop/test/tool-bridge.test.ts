import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BridgeConfirmationRequiredError,
  CoreRuntime,
  type BridgeExecutionPolicy,
  type SkillExecutor,
} from "@longhub/core";
import { buildHrAgentProfile, buildHrPackSource } from "@longhub/hr-suite";
import { LONGHUB_RESUME_SCREEN_SKILL } from "@longhub/openclaw-bridge";
import { AgentRegistry } from "../src/agent-registry.js";
import { ToolBridgeHost } from "../src/tool-bridge-host.js";
import { buildToolBridgePolicy } from "../src/tool-bridge-policy.js";

const temporaryDirectories: string[] = [];

function bridgePolicyFixture() {
  const root = mkdtempSync(join(tmpdir(), "longhub-tool-bridge-policy-"));
  temporaryDirectories.push(root);
  const source = buildHrPackSource("1.0.0");
  const registry = new AgentRegistry(join(root, "registry.json")).register({
    manifest: source.manifest,
    files: source.files,
  });
  const profiles = [{ registry, manifest: source.manifest, profile: buildHrAgentProfile() }];
  return { registry, policy: buildToolBridgePolicy(profiles) };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("LongHub Tool Bridge Core 边界", () => {
  it("Core 只按已激活 Profile 与 Bridge 契约授予只读技能权限", async () => {
    const { registry, policy } = bridgePolicyFixture();
    const execute = vi.fn(async () => ({ score: 100 }));
    const executor: SkillExecutor = { execute, abort: vi.fn() };
    const runtime = new CoreRuntime({
      executor,
      bridgePolicy: policy,
      verifyBridgeEntitlement: async () => ({ active: true, expiresAt: "2099-01-01T00:00:00.000Z" }),
      defaultBudget: { maxTokens: 10_000, maxCostCents: 25, maxDurationMs: 30_000 },
      onEvent: vi.fn(),
    });
    const context = {
      agentId: registry.agentId,
      sessionKey: `agent:${registry.agentId}:main`,
      sessionId: "session-1",
      toolCallId: "call-1",
    };

    await expect(runtime.executeBridgeSkill({
      skillId: LONGHUB_RESUME_SCREEN_SKILL,
      input: { requiredKeywords: ["TypeScript"], resumeText: "TypeScript" },
      context,
    })).resolves.toEqual({ score: 100 });
    expect(execute).toHaveBeenCalledWith(
      LONGHUB_RESUME_SCREEN_SKILL,
      expect.anything(),
      ["connector:hr-api:read"],
      { maxTokens: 10_000, maxCostCents: 25, maxDurationMs: 30_000 },
    );
  });

  it("main、Profile 未声明技能和缺失会话上下文全部 fail closed", async () => {
    const { registry, policy } = bridgePolicyFixture();
    const runtime = new CoreRuntime({
      executor: { execute: vi.fn(), abort: vi.fn() },
      bridgePolicy: policy,
      verifyBridgeEntitlement: async () => ({ active: true, expiresAt: "2099-01-01T00:00:00.000Z" }),
      onEvent: vi.fn(),
    });
    const request = {
      skillId: LONGHUB_RESUME_SCREEN_SKILL,
      input: {},
      context: { agentId: registry.agentId, sessionKey: "key", sessionId: "id", toolCallId: "call-1" },
    };
    await expect(runtime.executeBridgeSkill({
      ...request,
      context: { ...request.context, agentId: "main" },
    })).rejects.toMatchObject({ code: "BRIDGE_FORBIDDEN" });
    await expect(runtime.executeBridgeSkill({
      ...request,
      skillId: "longhub.skill.unknown",
    })).rejects.toMatchObject({ code: "BRIDGE_FORBIDDEN" });
    await expect(runtime.executeBridgeSkill({
      ...request,
      context: { ...request.context, sessionId: "" },
    })).rejects.toMatchObject({ code: "BRIDGE_FORBIDDEN" });
  });

  it("entitlement 撤销或任一权限来源不足时执行前拒绝", async () => {
    const { registry, policy } = bridgePolicyFixture();
    const execute = vi.fn();
    const request = {
      skillId: LONGHUB_RESUME_SCREEN_SKILL,
      input: { requiredKeywords: ["HR"], resumeText: "HR" },
      context: {
        agentId: registry.agentId,
        sessionKey: "key",
        sessionId: "session-1",
        toolCallId: "call-1",
      },
    };
    const revoked = new CoreRuntime({
      executor: { execute, abort: vi.fn() },
      bridgePolicy: policy,
      verifyBridgeEntitlement: async () => ({ active: false, reason: "已撤销" }),
      onEvent: vi.fn(),
    });
    await expect(revoked.executeBridgeSkill(request)).rejects.toMatchObject({ code: "BRIDGE_FORBIDDEN" });

    const grant = policy[registry.agentId]![0]!;
    const tenantDenied: BridgeExecutionPolicy = {
      [registry.agentId]: [{ ...grant, tenantPermissions: [] }],
    };
    const denied = new CoreRuntime({
      executor: { execute, abort: vi.fn() },
      bridgePolicy: tenantDenied,
      verifyBridgeEntitlement: async () => ({ active: true, expiresAt: "2099-01-01T00:00:00.000Z" }),
      onEvent: vi.fn(),
    });
    await expect(denied.executeBridgeSkill(request)).rejects.toMatchObject({ code: "BRIDGE_FORBIDDEN" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("敏感确认绑定 Agent/Profile/Session/ToolCall/输入并只能消费一次", async () => {
    const { registry, policy } = bridgePolicyFixture();
    const base = policy[registry.agentId]!.find(
      (grant) => grant.skillId === "longhub.skill.offer-letter",
    )!;
    const permission = "connector:hr-api:write";
    const writePolicy: BridgeExecutionPolicy = {
      [registry.agentId]: [{
        ...base,
        skillId: "longhub.skill.offer-letter",
        requiredPermissions: [permission],
        profilePermissions: [permission],
        packPermissions: [permission],
        tenantPermissions: [permission],
        devicePermissions: [permission],
      }],
    };
    const execute = vi.fn(async () => ({ ok: true }));
    const onConfirmationRequest = vi.fn();
    const runtime = new CoreRuntime({
      executor: { execute, abort: vi.fn() },
      bridgePolicy: writePolicy,
      verifyBridgeEntitlement: async () => ({ active: true, expiresAt: "2099-01-01T00:00:00.000Z" }),
      onConfirmationRequest,
      onEvent: vi.fn(),
    });
    const request = {
      skillId: "longhub.skill.offer-letter",
      input: {
        candidateName: "张三",
        position: "前端工程师",
        monthlySalaryCny: 30_000,
        startDate: "2026-08-15",
      },
      context: {
        agentId: registry.agentId,
        sessionKey: "key",
        sessionId: "session-1",
        toolCallId: "call-write-1",
      },
    };

    let confirmation: BridgeConfirmationRequiredError | undefined;
    try {
      await runtime.executeBridgeSkill(request);
    } catch (error) {
      confirmation = error as BridgeConfirmationRequiredError;
    }
    expect(confirmation).toBeInstanceOf(BridgeConfirmationRequiredError);
    expect(onConfirmationRequest).toHaveBeenCalledTimes(1);
    expect(confirmation!.request.display).toEqual({
      action: "生成录用通知书",
      object: "候选人录用通知",
      recipient: "张三",
      dataScope: ["岗位：前端工程师", "月薪（人民币元）：30000", "入职日期：2026-08-15"],
      estimatedCostCents: 0,
    });
    runtime.respondBridgeConfirmation({
      confirmationId: confirmation!.request.confirmationId,
      approved: true,
    });
    await expect(runtime.executeBridgeSkill(request)).resolves.toEqual({ ok: true });
    expect(execute).toHaveBeenCalledTimes(1);

    await expect(runtime.executeBridgeSkill(request)).rejects.toMatchObject({
      code: "BRIDGE_CONFIRMATION_REQUIRED",
    });
    await expect(runtime.executeBridgeSkill({
      ...request,
      input: {
        ...request.input,
        candidateName: "李四",
      },
    })).rejects.toMatchObject({ code: "BRIDGE_CONFIRMATION_REQUIRED" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("Bridge policy 替换会使旧安全纪元的待确认记录失效", async () => {
    const { registry, policy } = bridgePolicyFixture();
    const base = policy[registry.agentId]!.find(
      (grant) => grant.skillId === "longhub.skill.offer-letter",
    )!;
    const permission = "connector:hr-api:write";
    const writePolicy: BridgeExecutionPolicy = {
      [registry.agentId]: [{
        ...base,
        skillId: "longhub.skill.offer-letter",
        requiredPermissions: [permission],
        profilePermissions: [permission],
        packPermissions: [permission],
        tenantPermissions: [permission],
        devicePermissions: [permission],
      }],
    };
    const runtime = new CoreRuntime({
      executor: { execute: vi.fn(), abort: vi.fn() },
      bridgePolicy: writePolicy,
      verifyBridgeEntitlement: async () => ({ active: true, expiresAt: "2099-01-01T00:00:00.000Z" }),
      onEvent: vi.fn(),
    });
    let confirmation: BridgeConfirmationRequiredError | undefined;
    try {
      await runtime.executeBridgeSkill({
        skillId: "longhub.skill.offer-letter",
        input: {
          candidateName: "张三",
          position: "前端工程师",
          monthlySalaryCny: 30_000,
          startDate: "2026-08-15",
        },
        context: { agentId: registry.agentId, sessionKey: "key", sessionId: "session", toolCallId: "call" },
      });
    } catch (error) {
      confirmation = error as BridgeConfirmationRequiredError;
    }
    runtime.replaceBridgePolicy({});
    runtime.replaceBridgePolicy(writePolicy);
    expect(() => runtime.respondBridgeConfirmation({
      confirmationId: confirmation!.request.confirmationId,
      approved: true,
    })).toThrow("确认记录不存在");
  });

  it("拒绝、过期和跨 Agent 均不能复用确认", async () => {
    const { registry, policy } = bridgePolicyFixture();
    const grant = policy[registry.agentId]!.find(
      (item) => item.skillId === "longhub.skill.offer-letter",
    )!;
    const now = { value: Date.parse("2026-07-30T12:00:00.000Z") };
    const execute = vi.fn(async () => ({ ok: true }));
    const runtime = new CoreRuntime({
      executor: { execute, abort: vi.fn() },
      bridgePolicy: {
        [registry.agentId]: [grant],
        "agent-other": [grant],
      },
      verifyBridgeEntitlement: async () => ({
        active: true,
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
      now: () => now.value,
      onEvent: vi.fn(),
    });
    const request = {
      skillId: "longhub.skill.offer-letter",
      input: {
        candidateName: "张三",
        position: "前端工程师",
        monthlySalaryCny: 30_000,
        startDate: "2026-08-15",
      },
      context: {
        agentId: registry.agentId,
        sessionKey: "key",
        sessionId: "session",
        toolCallId: "call-deny",
      },
    };
    let denied!: BridgeConfirmationRequiredError;
    try {
      await runtime.executeBridgeSkill(request);
    } catch (error) {
      denied = error as BridgeConfirmationRequiredError;
    }
    runtime.respondBridgeConfirmation({
      confirmationId: denied.request.confirmationId,
      approved: false,
    });
    await expect(runtime.executeBridgeSkill(request)).rejects.toMatchObject({
      code: "BRIDGE_FORBIDDEN",
    });

    const expiring = {
      ...request,
      context: { ...request.context, toolCallId: "call-expire" },
    };
    let expired!: BridgeConfirmationRequiredError;
    try {
      await runtime.executeBridgeSkill(expiring);
    } catch (error) {
      expired = error as BridgeConfirmationRequiredError;
    }
    now.value += 5 * 60_000 + 1;
    expect(() => runtime.respondBridgeConfirmation({
      confirmationId: expired.request.confirmationId,
      approved: true,
    })).toThrow("已过期");

    const firstAgent = {
      ...request,
      context: { ...request.context, toolCallId: "call-cross-agent" },
    };
    let approved!: BridgeConfirmationRequiredError;
    try {
      await runtime.executeBridgeSkill(firstAgent);
    } catch (error) {
      approved = error as BridgeConfirmationRequiredError;
    }
    runtime.respondBridgeConfirmation({
      confirmationId: approved.request.confirmationId,
      approved: true,
    });
    await expect(runtime.executeBridgeSkill({
      ...firstAgent,
      context: { ...firstAgent.context, agentId: "agent-other" },
    })).rejects.toMatchObject({ code: "BRIDGE_CONFIRMATION_REQUIRED" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("HTTP 宿主只接受随机令牌保护的单一回环 JSON 路由", async () => {
    const token = randomBytes(32).toString("hex");
    const execute = vi.fn(async () => ({ score: 50 }));
    const host = new ToolBridgeHost({ token, execute });
    const connection = await host.start();
    try {
      const body = {
        skillId: LONGHUB_RESUME_SCREEN_SKILL,
        input: { requiredKeywords: ["HR"], resumeText: "HR" },
        context: { agentId: "hr", sessionKey: "key", sessionId: "id", toolCallId: "call-1" },
      };
      const unauthorized = await fetch(connection.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(unauthorized.status).toBe(401);

      const accepted = await fetch(connection.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      expect(accepted.status).toBe(200);
      await expect(accepted.json()).resolves.toEqual({ ok: true, result: { score: 50 } });
      expect(execute).toHaveBeenCalledWith(body);

      const absent = await fetch(new URL("/other", connection.endpoint), {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(absent.status).toBe(404);
    } finally {
      await host.stop();
    }
  });
});
