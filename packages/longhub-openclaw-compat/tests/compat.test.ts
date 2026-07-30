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
    expect(css).not.toContain(OPENCLAW_COMPAT_CONTRACT.selectors.agentSelector);
  });

  it("契约摘要作为升级审查基线", () => {
    expect(openClawCompatibilityDigest()).toBe("0A59AE77AED4081717E57A5211150F62A1C15569BBF0F92EE0714EE5E903F030");
  });
});
