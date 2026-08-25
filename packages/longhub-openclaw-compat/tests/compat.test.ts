import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertCompatibleOpenClawVersion,
  BUNDLED_OPENCLAW_VERSION,
  buildOpenClawProductCss,
  inspectOpenClawInstallation,
  OPENCLAW_COMPAT_CONTRACT,
  openClawCompatibilityDigest,
  OpenClawCompatibilityError,
  isAllowedProductExtensionNavigation,
  parseProductExtensionActionRequest,
  parseProductExtensionSkillActionRequest,
  parseProductExtensionEntryUrl,
  productExtensionRoute,
  productExtensionSurfaceDigest,
  PRODUCT_EXTENSION_SURFACE_CONTRACT,
  PRODUCT_EXTENSION_SURFACE_SCHEMA,
} from "../src/index.js";

const root = mkdtempSync(join(tmpdir(), "longhub-openclaw-compat-"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("OpenClaw 版本化兼容契约", () => {
  it("接受精确锁定版本并拒绝任何漂移", () => {
    expect(() => assertCompatibleOpenClawVersion(BUNDLED_OPENCLAW_VERSION)).not.toThrow();
    expect(() => assertCompatibleOpenClawVersion("2026.7.2")).toThrow(OpenClawCompatibilityError);
    expect(() => assertCompatibleOpenClawVersion("")).toThrow("实际 unknown");
  });

  it("从真实 openclaw.mjs 同目录回读锁定版本", () => {
    const entry = fileURLToPath(new URL("../node_modules/openclaw/openclaw.mjs", import.meta.url));
    expect(inspectOpenClawInstallation(entry)).toMatchObject({
      actualVersion: BUNDLED_OPENCLAW_VERSION,
      expectedVersion: BUNDLED_OPENCLAW_VERSION,
    });
  });

  it("损坏或漂移的安装给出可诊断错误", () => {
    const badEntry = join(root, "openclaw.mjs");
    writeFileSync(badEntry, "", "utf8");
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "2026.8.0" }), "utf8");
    expect(() => inspectOpenClawInstallation(badEntry)).toThrow("需要 2026.7.1-2，实际 2026.8.0");
    writeFileSync(join(root, "package.json"), "{broken", "utf8");
    expect(() => inspectOpenClawInstallation(badEntry)).toThrow("无法读取内置 OpenClaw 版本");
  });

  it("产品 CSS 由同一契约生成且绝不隐藏 Agent Selector", () => {
    const css = buildOpenClawProductCss();
    for (const selector of OPENCLAW_COMPAT_CONTRACT.selectors.modelControls) expect(css).toContain(selector);
    for (const selector of OPENCLAW_COMPAT_CONTRACT.selectors.restrictedNavigationLinks) {
      expect(css).toContain(selector);
    }
    for (const selector of OPENCLAW_COMPAT_CONTRACT.selectors.ordinaryUserHidden) {
      expect(css).toContain(selector);
    }
    for (const selector of OPENCLAW_COMPAT_CONTRACT.selectors.ordinaryUserRestrictedControls) {
      expect(css).toContain(selector);
    }
    expect(OPENCLAW_COMPAT_CONTRACT.routes.ordinaryUserPathSuffixes).toEqual([
      "/chat", "/activity", "/agents", "/sessions", "/usage", "/tasks", "/skills",
    ]);
    expect(css).not.toContain("\n  .sidebar-nav,");
    expect(css).not.toContain(OPENCLAW_COMPAT_CONTRACT.selectors.agentSelector);
  });

  it("契约摘要作为升级审查基线", () => {
    expect(openClawCompatibilityDigest()).toBe("EDC310A59F7B4C029C77A8FD5B98F8F9AFC0A433E04C6192E46CC1DC3415C88F");
  });
});

describe("Product Native Shell V2 契约", () => {
  it("冻结独立 origin、路由、窗口隔离和最小 IPC", () => {
    expect(PRODUCT_EXTENSION_SURFACE_CONTRACT.resourceOrigin.origin).toBe("longhub-product://app");
    expect(PRODUCT_EXTENSION_SURFACE_CONTRACT.resourceOrigin.routes).toEqual({
      agents: "/agents",
      skills: "/skills",
      account: "/account",
      confirmations: "/confirmations",
    });
    expect(PRODUCT_EXTENSION_SURFACE_CONTRACT.window.webPreferences).toEqual({
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    });
    expect(Object.values(PRODUCT_EXTENSION_SURFACE_CONTRACT.ipc.channels)).toEqual([
      "longhub:extension:context-read",
      "longhub:extension:window-close",
      "longhub:extension:confirmation-read",
      "longhub:extension:confirmation-approve",
      "longhub:extension:confirmation-deny",
      "longhub:extension:agents-read",
      "longhub:extension:agents-action",
      "longhub:extension:skills-read",
      "longhub:extension:skills-action",
      "longhub:extension:account-read",
      "longhub:extension:account-action",
    ]);
    expect(productExtensionSurfaceDigest()).toMatch(/^[A-F0-9]{64}$/);
  });

  it("入口只接受三个固定动作，不接受参数、凭据或相似路由", () => {
    expect(parseProductExtensionEntryUrl("longhub-extension://open/agents")).toBe("agents");
    expect(parseProductExtensionEntryUrl("longhub-extension://open/skills")).toBe("skills");
    expect(parseProductExtensionEntryUrl("longhub-extension://open/account")).toBe("account");
    for (const target of [
      "https://open/agents",
      "longhub-extension://open/confirmations",
      "longhub-extension://open/agents?next=settings",
      "longhub-extension://user:pass@open/agents",
      "longhub-extension://open/agents/extra",
    ]) {
      expect(() => parseProductExtensionEntryUrl(target)).toThrow("不在白名单");
    }
  });

  it("子窗口导航只允许独立 origin 的固定路由", () => {
    expect(productExtensionRoute("agents")).toBe("longhub-product://app/agents");
    expect(isAllowedProductExtensionNavigation("longhub-product://app/agents")).toBe(true);
    expect(isAllowedProductExtensionNavigation("longhub-product://app/confirmations")).toBe(true);
    for (const target of [
      "longhub-product://other/agents",
      "longhub-product://app/settings",
      "longhub-product://app/agents?debug=1",
      "https://app/agents",
    ]) {
      expect(isAllowedProductExtensionNavigation(target)).toBe(false);
    }
  });

  it("动作绑定窗口、入口、动作和一次性 nonce", () => {
    const windowId = "12345678-1234-4234-9234-123456789abc";
    const nonce = "a".repeat(43);
    const consumed = new Set<string>();
    const request = {
      schema_version: PRODUCT_EXTENSION_SURFACE_SCHEMA,
      window_id: windowId,
      entry: "agents",
      action: "context.read",
      nonce,
    };
    const expected = {
      windowId,
      entry: "agents" as const,
      action: "context.read" as const,
      consumeNonce(value: string) {
        if (consumed.has(value)) return false;
        consumed.add(value);
        return true;
      },
    };
    expect(parseProductExtensionActionRequest(request, expected)).toEqual(request);
    expect(() => parseProductExtensionActionRequest(request, expected)).toThrow("nonce");
    expect(() => parseProductExtensionActionRequest(
      { ...request, nonce: "b".repeat(43), window_id: "22345678-1234-4234-9234-123456789abc" },
      expected,
    )).toThrow("绑定");
    expect(() => parseProductExtensionActionRequest(
      { ...request, nonce: "c".repeat(43), unexpected: true },
      expected,
    )).toThrow("字段");
  });

  it("能力动作只接受固定 skill/agent ID 和一次性动作 nonce", () => {
    const windowId = "12345678-1234-4234-9234-123456789abc";
    const request = {
      schema_version: PRODUCT_EXTENSION_SURFACE_SCHEMA,
      window_id: windowId,
      entry: "skills",
      action: "skills.install",
      nonce: "s".repeat(43),
      payload: { skillId: "longhub.skill.resume-screen", agentId: "longhub-agent-hr" },
    } as const;
    let consumed = false;
    const expected = {
      windowId,
      entry: "skills" as const,
      action: "skills.install" as const,
      consumeNonce() { if (consumed) return false; consumed = true; return true; },
    };
    expect(parseProductExtensionSkillActionRequest(request, expected)).toEqual(request);
    expect(() => parseProductExtensionSkillActionRequest(request, expected)).toThrow("nonce");
    expect(() => parseProductExtensionSkillActionRequest({
      ...request,
      nonce: "t".repeat(43),
      payload: { skillId: "longhub.skill.resume-screen", agentId: "../../main" },
    }, { ...expected, consumeNonce: () => true })).toThrow("能力动作");
  });
});
