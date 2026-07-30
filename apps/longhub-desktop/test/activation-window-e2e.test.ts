import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import ts from "typescript";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(appRoot, ".activation-e2e-"));
const screenshotPath = join(tmpdir(), "longhub-activation-window-e2e.png");

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(screenshotPath, { force: true });
});

function transpile(sourcePath: string, outputPath: string, module: ts.ModuleKind): void {
  const source = readFileSync(sourcePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: sourcePath,
  });
  writeFileSync(outputPath, output.outputText, "utf8");
}

describe("首次授权码激活窗口 E2E", () => {
  it("仅允许受信激活页核销，正确授权后才关闭", async () => {
    const activationWindowModule = join(root, "activation-window.mjs");
    const activationInputModule = join(root, "activation-code-input.js");
    const preloadPath = join(root, "activation-preload.cjs");
    const attackerPreloadPath = join(root, "attacker-preload.cjs");
    const resultPath = join(root, "result.json");
    const inputPath = join(root, "input.json");
    transpile(join(appRoot, "src", "activation-window.ts"), activationWindowModule, ts.ModuleKind.ES2022);
    transpile(join(appRoot, "src", "activation-code-input.ts"), activationInputModule, ts.ModuleKind.ES2022);
    transpile(join(appRoot, "src", "activation-preload.cts"), preloadPath, ts.ModuleKind.CommonJS);
    writeFileSync(attackerPreloadPath, `
      const { contextBridge, ipcRenderer } = require("electron");
      contextBridge.exposeInMainWorld("activationAttacker", (code) =>
        ipcRenderer.invoke("longhub:activation:submit", code));
    `, "utf8");
    writeFileSync(inputPath, JSON.stringify({
      activationWindowModule,
      htmlPath: join(appRoot, "assets", "activation.html"),
      preloadPath,
      attackerPreloadPath,
      resultPath,
      screenshotPath,
      deviceId: "dev-activation-e2e",
      wrongCode: "LH-AAAA-BBBB-CCCC-DDDD",
      correctCode: "LH-1111-2222-3333-4444",
    }), "utf8");

    const electronPath = createRequire(import.meta.url)("electron") as string;
    const runner = fileURLToPath(new URL("./fixtures/activation-window-runner.cjs", import.meta.url));
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
    expect(result.initial).toEqual({
      title: "激活龙枢",
      heading: "激活龙枢",
      device: "设备：dev-activation-e2e",
      message: "",
      button: "立即激活",
      buttonDisabled: false,
      bridgeKeys: ["submit"],
      hasNode: false,
    });
    expect(result.visual.windowBounds.width).toBe(520);
    expect(Math.abs(result.visual.windowBounds.height - 620)).toBeLessThanOrEqual(2);
    expect(result.visual.screenshotSize.width).toBeGreaterThanOrEqual(500);
    expect(result.visual.screenshotSize.height).toBeGreaterThanOrEqual(560);
    expect(result.attackerResult).toEqual({ ok: false, message: "激活请求来源无效" });
    expect(result.malformed).toMatchObject({
      message: "请输入正确格式的授权码",
      button: "立即激活",
      buttonDisabled: false,
      hasNode: false,
    });
    expect(result.rejected).toMatchObject({
      message: "授权码无效或已失效",
      button: "立即激活",
      buttonDisabled: false,
      hasNode: false,
    });
    expect(result.activated).toBe(true);
    expect(result.activateCalls).toEqual([
      "LH-AAAA-BBBB-CCCC-DDDD",
      "LH-1111-2222-3333-4444",
    ]);
    expect(result.remainingWindows).toBe(0);
  }, 30_000);
});
