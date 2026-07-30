import { describe, expect, it } from "vitest";
import { openClawAgentSessionUrl, openClawControlUiUrl } from "../src/openclaw-webui.js";

describe("OpenClaw Control UI 地址", () => {
  it("把本机 ws Gateway 转成同端口 http WebUI", () => {
    expect(openClawControlUiUrl("ws://127.0.0.1:18789")).toBe(
      "http://127.0.0.1:18789/chat?gatewayUrl=ws%3A%2F%2F127.0.0.1%3A18789",
    );
  });

  it("保留 TLS、路径和查询参数", () => {
    expect(openClawControlUiUrl("wss://claw.example/openclaw?lang=zh-CN")).toBe(
      "https://claw.example/openclaw/chat?lang=zh-CN&gatewayUrl=wss%3A%2F%2Fclaw.example%2Fopenclaw%3Flang%3Dzh-CN",
    );
  });

  it("把令牌放在 fragment 中而不是查询参数中", () => {
    const url = openClawControlUiUrl("ws://127.0.0.1:18789", { token: "a+b/c=" });
    expect(url).toBe("http://127.0.0.1:18789/chat?gatewayUrl=ws%3A%2F%2F127.0.0.1%3A18789#token=a%2Bb%2Fc%3D");
    expect(new URL(url).searchParams.get("token")).toBeNull();
  });

  it("允许显式覆盖 WebUI 地址", () => {
    expect(
      openClawControlUiUrl("ws://127.0.0.1:18789", {
        explicitUrl: "http://127.0.0.1:18789/openclaw/",
        token: "secret",
      }),
    ).toBe("http://127.0.0.1:18789/openclaw/chat?gatewayUrl=ws%3A%2F%2F127.0.0.1%3A18789#token=secret");
  });

  it("拒绝无法作为页面加载的协议", () => {
    expect(() => openClawControlUiUrl("tcp://127.0.0.1:18789")).toThrow(
      "不支持的 OpenClaw Gateway 协议",
    );
  });

  it("拒绝把管理令牌交给不同源的 WebUI", () => {
    expect(() =>
      openClawControlUiUrl("ws://127.0.0.1:18789", {
        explicitUrl: "https://ui.example/",
        token: "secret",
      }),
    ).toThrow("必须与 Gateway 同源");
  });

  it("显式构造 Agent 主会话并保留 Gateway 参数与 fragment 令牌", () => {
    const url = openClawControlUiUrl("ws://127.0.0.1:18789", { token: "secret" });
    expect(openClawAgentSessionUrl(url, "Main")).toBe(
      "http://127.0.0.1:18789/chat?gatewayUrl=ws%3A%2F%2F127.0.0.1%3A18789&session=agent%3Amain%3Amain#token=secret",
    );
    expect(() => openClawAgentSessionUrl(url, "../hr")).toThrow("无效的 OpenClaw agentId");
  });
});
