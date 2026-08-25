import { describe, expect, it } from "vitest";
import {
  installOpenClawProductUi,
  openClawProductUiScript,
  OPENCLAW_PRODUCT_UI_CONTRACT,
} from "../src/openclaw-product-ui.js";

describe("OpenClaw 龙枢产品化薄层", () => {
  it("固定中文品牌、语言并只处理登记的 UI chrome", () => {
    const script = openClawProductUiScript();
    expect(OPENCLAW_PRODUCT_UI_CONTRACT).toEqual({
      policyKey: "__longhubProductUiV1",
      locale: "zh-CN",
      productName: "龙枢",
      assistantName: "龙枢助手",
    });
    expect(script).toContain("sidebar-recent-session__name");
    expect(script).toContain("agent-chat__run-status-label");
    expect(script).toContain("Help me configure a channel");
    expect(script).toContain("龙枢助手会话");
    expect(script).toContain("ordinaryUserAgentPanels");
    expect(script).toContain("longhubAgentPanels");
    expect(openClawProductUiScript({
      assistant_name: "龙枢助手",
      welcome_message: "你好",
      assistant_avatar_data_url: "data:image/png;base64,avatar",
    })).toContain("data:image/png;base64,avatar");
    expect(script).not.toContain("innerHTML");
    expect(script).not.toContain("document.body.innerText");
  });

  it("通过隔离页面世界安装，不要求 preload 或 IPC", async () => {
    let executed = "";
    await installOpenClawProductUi({
      async executeJavaScript(code) {
        executed = code;
        return undefined;
      },
    });
    expect(executed).toBe(openClawProductUiScript());
  });
});
