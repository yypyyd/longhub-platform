import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isAllowedOpenClawNavigation,
  isForbiddenOpenClawRoute,
  OPENCLAW_PRODUCT_CSS,
} from "../src/openclaw-product-policy.js";

describe("OpenClaw 成品 UI 策略", () => {
  const chat = "http://127.0.0.1:18789/chat";

  it("拦截控制面与任意执行路由", () => {
    for (const path of [
      "/overview", "/settings/general", "/config", "/channels", "/appearance", "/cron",
      "/nodes", "/debug", "/logs", "/skills/workshop", "/worktrees", "/dreaming",
    ]) {
      expect(isForbiddenOpenClawRoute(`http://127.0.0.1:18789${path}`, chat), path).toBe(true);
    }
    expect(isForbiddenOpenClawRoute("http://127.0.0.1:18789/chat", chat)).toBe(false);
    expect(isForbiddenOpenClawRoute("http://127.0.0.1:18789/tasks", chat)).toBe(false);
  });

  it("不把跨源页面误判成本机配置页", () => {
    expect(isForbiddenOpenClawRoute("https://example.com/settings/general", chat)).toBe(false);
  });

  it("主窗口开放已审查的同源原生页面，拒绝控制面、外部来源与自定义协议", () => {
    for (const path of ["/chat?session=agent:main:main", "/activity", "/agents", "/sessions", "/usage", "/tasks", "/skills"]) {
      expect(isAllowedOpenClawNavigation(`http://127.0.0.1:18789${path}`, chat), path).toBe(true);
    }
    expect(isAllowedOpenClawNavigation("http://127.0.0.1:18789/settings/general", chat)).toBe(false);
    expect(isAllowedOpenClawNavigation("http://127.0.0.1:18789/skills/workshop", chat)).toBe(false);
    expect(isAllowedOpenClawNavigation("http://127.0.0.1:18789/agents/files", chat)).toBe(false);
    expect(isAllowedOpenClawNavigation("http://127.0.0.1:18789/other/chat", chat)).toBe(false);
    expect(isAllowedOpenClawNavigation("https://example.com/chat", chat)).toBe(false);
    expect(isAllowedOpenClawNavigation("longhub-agent://install/?packId=longhub.hr-suite", chat)).toBe(false);
  });

  it("支持配置了 basePath 的锁定 Gateway，但不接受其他前缀", () => {
    const based = "http://127.0.0.1:18789/longhub/chat";
    expect(isAllowedOpenClawNavigation("http://127.0.0.1:18789/longhub/agents", based)).toBe(true);
    expect(isAllowedOpenClawNavigation("http://127.0.0.1:18789/other/agents", based)).toBe(false);
  });

  it("保留官方侧边栏，同时隐藏模型、设置与原生高风险写控件", () => {
    expect(OPENCLAW_PRODUCT_CSS).toContain("data-chat-model-select");
    expect(OPENCLAW_PRODUCT_CSS).toContain("data-chat-model-option");
    expect(OPENCLAW_PRODUCT_CSS).toContain("chat-controls__inline-select-menu--combined");
    expect(OPENCLAW_PRODUCT_CSS).toContain("chat-settings-chip");
    expect(OPENCLAW_PRODUCT_CSS).toContain("/settings/");
    expect(OPENCLAW_PRODUCT_CSS).not.toContain("\n  .sidebar-nav,");
    expect(OPENCLAW_PRODUCT_CSS).toContain(".sidebar-footer-icon");
    expect(OPENCLAW_PRODUCT_CSS).toContain("agent-model-select");
    expect(OPENCLAW_PRODUCT_CSS).toContain("clawhub-search");
    expect(OPENCLAW_PRODUCT_CSS).toContain("agent-tool-toggle");
    expect(OPENCLAW_PRODUCT_CSS).toContain(".agent-chat__suggestion");
  });

  it("锁定版 Control UI 保留原生 Agent Selector，产品 CSS 不隐藏它", () => {
    const assetsDir = fileURLToPath(new URL("../node_modules/openclaw/dist/control-ui/assets/", import.meta.url));
    const controlUiSource = readdirSync(assetsDir)
      .filter((name) => name.endsWith(".js"))
      .map((name) => readFileSync(join(assetsDir, name), "utf8"))
      .find((source) => source.includes('data-chat-agent-filter="true"'));
    expect(controlUiSource).toContain('data-chat-agent-filter="true"');
    expect(controlUiSource).toContain("agentsList");
    expect(OPENCLAW_PRODUCT_CSS).not.toContain("data-chat-agent-filter");
    expect(OPENCLAW_PRODUCT_CSS).not.toContain("sidebar-agent-scope");
  });
});
