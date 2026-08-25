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
const root = mkdtempSync(join(appRoot, ".product-extension-e2e-"));
const screenshotPath = join(tmpdir(), "longhub-product-extension-e2e.png");

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(screenshotPath, { force: true });
});

function transpile(sourcePath: string, outputPath: string, module: ts.ModuleKind): void {
  const source = readFileSync(sourcePath, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: sourcePath,
  });
  writeFileSync(outputPath, output.outputText, "utf8");
}

describe("Product Extension Surface 真实 Electron E2E", () => {
  it("受限子窗口无 Node/通用 IPC，直接路由和跨窗口调用均拒绝", async () => {
    const coordinatorModule = join(root, "product-extension-window.mjs");
    const preloadPath = join(root, "product-extension-preload.cjs");
    const attackerPreloadPath = join(root, "attacker-preload.cjs");
    const resultPath = join(root, "result.json");
    const inputPath = join(root, "input.json");
    transpile(
      join(appRoot, "src", "product-extension-window.ts"),
      coordinatorModule,
      ts.ModuleKind.ES2022,
    );
    transpile(
      join(appRoot, "src", "product-extension-preload.cts"),
      preloadPath,
      ts.ModuleKind.CommonJS,
    );
    writeFileSync(attackerPreloadPath, `
      const { contextBridge, ipcRenderer } = require("electron");
      contextBridge.exposeInMainWorld("attackProduct", () =>
        ipcRenderer.invoke("longhub:extension:context-read", {
          schema_version: "longhub/product-extension-surface/v2",
          window_id: "12345678-1234-4234-9234-123456789abc",
          entry: "agents",
          action: "context.read",
          nonce: "a".repeat(43),
        }));
    `, "utf8");
    writeFileSync(inputPath, JSON.stringify({
      coordinatorModule,
      preloadPath,
      attackerPreloadPath,
      resultPath,
      screenshotPath,
      assetsDir: join(appRoot, "assets"),
      iconPath: join(appRoot, "assets", "longhub-icon.png"),
    }), "utf8");

    const electronPath = createRequire(import.meta.url)("electron") as string;
    const runner = fileURLToPath(new URL("./fixtures/product-extension-runner.cjs", import.meta.url));
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
    expect(result.opened).toBe(true);
    expect(result.denied).toBe(false);
    expect(result.state).toMatchObject({
      url: "longhub-product://app/agents",
      title: "智能体 - 龙枢",
      heading: "智能体",
      status: "摘要已转交，未继承权限或原始记忆",
      content: "招聘写作规范",
      workflow: "安全筛选",
      overlay: "我的招聘助手",
      bridgeKeys: [
        "cancelHandoff", "close", "confirmHandoff", "createContent", "createOverlay", "createWorkflow",
        "disableAgent", "enableAgent", "exportContent", "importContent", "importOpenClawContent", "installAgent",
        "previewHandoff", "runWorkflow", "selectAgent", "workspace",
      ],
      hasNode: false,
    });
    expect(result.state.handoff).toContain("继承权限 0 · 继承记忆 0");
    expect(result.noCodeActions).toEqual([
      { action: "content.create", name: "招聘写作规范", description: "统一语气", instructions: "只使用可核验信息。" },
      { action: "workflow.create", name: "安全筛选", steps: [{ id: "first", kind: "skill", skillId: "user.skill.11111111-1111-4111-8111-111111111111", input: {} }] },
      {
        action: "agent.create", baseProfileId: "longhub.agent.hr", targetAgentId: "longhub-agent-hr",
        name: "我的招聘助手", description: "使用设备本地偏好", language: "zh-CN", tone: "balanced",
        personalEntryIds: [], skillIds: ["user.skill.11111111-1111-4111-8111-111111111111"],
      },
      { action: "handoff.preview", sourceAgentId: "longhub-agent-hr", targetAgentId: "longhub-agent-finance", summary: "候选人已接受报价。" },
      { action: "handoff.confirm", handoffId: "11111111-1111-4111-8111-111111111111", targetAgentId: "longhub-agent-finance", confirmationToken: "b".repeat(43) },
    ]);
    expect(result.agentActions).toEqual([{ action: "select", agentId: "longhub-agent-finance" }]);
    expect(result.agentSwitch).toEqual({ current: "财务助理", status: "已切换到 财务助理" });
    expect(result.bounds.width).toBeGreaterThanOrEqual(820);
    expect(result.bounds.width).toBeLessThanOrEqual(821);
    expect(result.bounds.height).toBe(720);
    expect(result.afterForbiddenNavigation).toBe("longhub-product://app/agents");
    expect(result.skillOpened).toBe(true);
    expect(result.skillPreview).toEqual({
      title: "能力 - 龙枢",
      action: "启用",
      meta: ["招聘", "本机内置能力", "版本 1.0.0", "无需写操作确认", "单次费用上限 ¥0.01"],
      permission: "connector:hr-api:read",
      agents: ["HR 助理", "财务助理"],
      bridgeKeys: ["close", "disable", "enable", "install", "rollback", "skills", "uninstall", "upgrade"],
      hasNode: false,
    });
    expect(result.firstSkillFailure).toContain("状态已恢复");
    expect(result.skillAfterRetry).toEqual({ status: "启用成功", action: "停用", installed: "版本 1.0.0" });
    expect(result.skillActions).toEqual([
      { action: "install", skillId: "longhub.skill.resume-screen", agentId: "longhub-agent-hr" },
      { action: "install", skillId: "longhub.skill.resume-screen", agentId: "longhub-agent-hr" },
    ]);
    expect(result.accountOpened).toBe(true);
    expect(result.accountPreview).toMatchObject({
      title: "我的 - 龙枢",
      agents: ["HR 助理", "财务助理"],
      session: "候选人沟通",
      profile: "我的简历",
      hasNode: false,
    });
    expect(result.accountPreview.bridgeKeys).toContain("queryKnowledge");
    expect(result.accountCitation).toEqual({ title: "差旅制度", source: "员工手册", snippet: "十个工作日内报销" });
    expect(result.accountActions).toEqual([{ action: "knowledge.query", agentId: "longhub-agent-hr", query: "差旅 报销" }]);
    expect(result.attacker).toMatchObject({ ok: false });
    expect(result.confirmationOpened).toBe(true);
    expect(result.confirmationState).toEqual({
      action: "生成录用通知书",
      agent: "agent-hr",
      skill: "longhub.skill.offer-letter",
      recipient: "张三",
      data: ["岗位：前端工程师", "月薪（人民币元）：30000", "入职日期：2026-08-15"],
      permission: "connector:hr-api:write",
      cost: "无额外费用",
      bridgeKeys: ["approve", "close", "confirmation", "deny"],
      hasNode: false,
    });
    expect(result.confirmationResponses).toEqual([
      { confirmationId: expect.stringMatching(/^confirm-/), approved: true },
      { confirmationId: expect.stringMatching(/^confirm-/), approved: false },
    ]);
    expect(result.screenshot.width).toBeGreaterThanOrEqual(900);
    expect(result.remainingWindowsBeforeClose).toBe(1);
  }, 30_000);
});
