import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeActivationInput } from "../src/activation-code-input.js";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("客户端授权码输入", () => {
  it("接受大小写、空格和无分隔格式并生成规范值", () => {
    expect(normalizeActivationInput(" lh-abcd-1234-ef56-7890 ")).toBe("LH-ABCD-1234-EF56-7890");
    expect(normalizeActivationInput("LHABCD1234EF567890")).toBe("LH-ABCD-1234-EF56-7890");
  });

  it("拒绝长度、前缀和字符不合法的输入", () => {
    expect(normalizeActivationInput("ABCD-1234-EF56-7890")).toBeUndefined();
    expect(normalizeActivationInput("LH-ABCD-1234-EF56-XYZ0")).toBeUndefined();
    expect(normalizeActivationInput("x".repeat(65))).toBeUndefined();
  });

  it("激活页使用严格 CSP，脚本不直接取得 Node 或模型配置", () => {
    const html = readFileSync(join(appRoot, "assets", "activation.html"), "utf8");
    const script = readFileSync(join(appRoot, "assets", "activation.js"), "utf8");
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'self'");
    expect(script).toContain("longhubActivation.submit");
    expect(script).toContain("ACTIVATION_BRIDGE_UNAVAILABLE");
    expect(script).toContain("ACTIVATION_TIMEOUT");
    expect(script).toContain("button.disabled = false");
    expect(script).not.toMatch(/require\(|ipcRenderer|process\.|model|provider|token/i);
  });
});
