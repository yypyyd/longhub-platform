import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { DIAGNOSTIC_EXPORT_URL } from "../src/diagnostic-export.js";
import { productStatusPage } from "../src/product-error-page.js";

const root = mkdtempSync(join(tmpdir(), "longhub-diagnostic-export-e2e-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("错误页一键导出诊断信息", () => {
  it("真实 sandbox 页面点击只发出固定诊断导航", async () => {
    const resultPath = join(root, "result.json");
    const inputPath = join(root, "input.json");
    writeFileSync(inputPath, JSON.stringify({
      pageUrl: productStatusPage("CLOUD_UNREACHABLE"),
      expectedUrl: DIAGNOSTIC_EXPORT_URL,
      resultPath,
    }), "utf8");
    const electronPath = createRequire(import.meta.url)("electron") as string;
    const runner = fileURLToPath(new URL("./fixtures/diagnostic-export-runner.cjs", import.meta.url));
    const electron = spawn(electronPath, [runner, inputPath], {
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const output: string[] = [];
    electron.stdout?.on("data", (chunk) => output.push(String(chunk)));
    electron.stderr?.on("data", (chunk) => output.push(String(chunk)));
    const [exitCode] = await once(electron, "exit") as [number | null];

    expect(existsSync(resultPath), output.join("")).toBe(true);
    const result = JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, any>;
    expect(exitCode, result.error ?? output.join("")).toBe(0);
    expect(result.error, JSON.stringify(result)).toBeUndefined();
    expect(result.before).toEqual({
      title: "暂时无法连接龙枢服务",
      linkText: "导出诊断信息",
      linkHref: DIAGNOSTIC_EXPORT_URL,
      csp: "default-src 'none'; style-src 'unsafe-inline'",
      hasNode: false,
    });
    expect(result.requestedUrl).toBe(DIAGNOSTIC_EXPORT_URL);
    expect(result.requestCount).toBe(1);
  }, 30_000);
});
