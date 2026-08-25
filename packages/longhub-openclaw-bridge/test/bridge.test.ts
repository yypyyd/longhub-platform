import { describe, expect, it, vi } from "vitest";
import {
  LONGHUB_RESUME_SCREEN_SKILL,
  LONGHUB_OFFER_LETTER_SKILL,
  createOfferLetterToolFactory,
  createLongHubBridgeClient,
  createLongHubToolFactory,
  parseResumeScreenInput,
  parseOfferLetterInput,
  offerLetterParameters,
  resumeScreenParameters,
} from "../src/index.js";

const trustedContext = {
  agentId: "longhub-agent-hr",
  sessionKey: "agent:longhub-agent-hr:main",
  sessionId: "session-1",
  toolCallId: "call-1",
};

describe("LongHub OpenClaw Tool Bridge", () => {
  it("在 factory 中绑定 OpenClaw 注入的可信上下文", async () => {
    const execute = vi.fn(async () => ({ score: 100 }));
    const tool = createLongHubToolFactory({ execute })(trustedContext);
    expect(tool).not.toBeNull();
    await (Array.isArray(tool) ? tool[0]! : tool!).execute("call-1", {
      requiredKeywords: ["TypeScript"],
      resumeText: "熟悉 TypeScript",
    });
    expect(execute).toHaveBeenCalledWith({
      skillId: LONGHUB_RESUME_SCREEN_SKILL,
      input: { requiredKeywords: ["TypeScript"], resumeText: "熟悉 TypeScript" },
      context: trustedContext,
    });
  });

  it("缺少任一可信身份字段时 fail closed，不注册工具", () => {
    const factory = createLongHubToolFactory({ execute: vi.fn() });
    expect(factory({ agentId: trustedContext.agentId, sessionKey: trustedContext.sessionKey })).toBeNull();
    expect(factory({ agentId: trustedContext.agentId, sessionId: trustedContext.sessionId })).toBeNull();
    expect(factory({ sessionKey: trustedContext.sessionKey, sessionId: trustedContext.sessionId })).toBeNull();
  });

  it("工具 schema 和运行时校验都拒绝模型伪造身份或权限", () => {
    expect(resumeScreenParameters.additionalProperties).toBe(false);
    expect(Object.keys(resumeScreenParameters.properties)).toEqual(["requiredKeywords", "resumeText"]);
    expect(() => parseResumeScreenInput({
      requiredKeywords: ["TypeScript"],
      resumeText: "内容",
      agentId: "main",
      grantedPermissions: ["connector:hr-api:write"],
    })).toThrow("禁止字段");
  });

  it("真实写工具只接受四个业务字段并转发可信上下文", async () => {
    const execute = vi.fn(async () => ({ letter: "ok" }));
    const tool = createOfferLetterToolFactory({ execute })(trustedContext);
    expect(offerLetterParameters.additionalProperties).toBe(false);
    await (Array.isArray(tool) ? tool[0]! : tool!).execute("call-offer-1", {
      candidateName: "张三",
      position: "前端工程师",
      monthlySalaryCny: 30_000,
      startDate: "2026-08-15",
    });
    expect(execute).toHaveBeenCalledWith({
      skillId: LONGHUB_OFFER_LETTER_SKILL,
      input: {
        candidateName: "张三",
        position: "前端工程师",
        monthlySalaryCny: 30_000,
        startDate: "2026-08-15",
      },
      context: { ...trustedContext, toolCallId: "call-offer-1" },
    });
    expect(() => parseOfferLetterInput({
      candidateName: "张三",
      position: "前端工程师",
      monthlySalaryCny: 30_000,
      startDate: "2026-08-15",
      approved: true,
    })).toThrow("禁止字段");
  });

  it("客户端只接受回环端点并携带随机令牌", async () => {
    const fetchImpl = vi.fn(async (_url: URL, init?: RequestInit) => new Response(
      JSON.stringify({ ok: true, result: { score: 80 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const client = createLongHubBridgeClient({
      endpoint: "http://127.0.0.1:30123/v1/execute",
      token: "a".repeat(64),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.execute({
      skillId: LONGHUB_RESUME_SCREEN_SKILL,
      input: { requiredKeywords: ["HR"], resumeText: "HR" },
      context: trustedContext,
    })).resolves.toEqual({ score: 80 });
    expect(fetchImpl.mock.calls[0]![1]?.headers).toMatchObject({
      authorization: `Bearer ${"a".repeat(64)}`,
    });
    expect(() => createLongHubBridgeClient({
      endpoint: "http://example.com/v1/execute",
      token: "a".repeat(64),
    })).toThrow("127.0.0.1");
  });
});
