import { describe, expect, it } from "vitest";
import { productExtensionEntryScript } from "../src/product-extension-entry.js";

describe("OpenClaw 产品扩展入口", () => {
  it("只把已启用的固定入口编译到注入脚本", () => {
    const script = productExtensionEntryScript(["agents", "account"]);
    expect(script).toContain("longhub-extension:");
    expect(script).toContain("智能体");
    expect(script).toContain("我的");
    expect(script).toContain('"enabledEntries":["agents","account"]');
    expect(script).not.toContain('"enabledEntries":["agents","skills","account"]');
    expect(script).toContain("MutationObserver");
    expect(script).toContain("__longhubProductNativeShellV2");
    expect(script).toContain('nav.dataset.longhubExtensionNav = "v2"');
    expect(script).not.toMatch(/ipcRenderer|require\(|child_process|nodeIntegration/);
  });

  it("未知值即使绕过 TypeScript 也不会进入脚本", () => {
    const script = productExtensionEntryScript(["settings" as "agents"]);
    expect(script).toContain('"enabledEntries":[]');
    expect(script).not.toContain("longhub-extension://open/settings");
  });
});
