import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { agentPackInstallUrl, parseAgentPackInstallUrl } from "../src/agent-install-navigation.js";
import { openClawSelectorPolicyScript } from "../src/openclaw-selector-policy.js";

const root = mkdtempSync(join(tmpdir(), "longhub-agent-install-ui-"));

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("原生 Agent Selector 一键安装入口", () => {
  it("真实 Electron 点击只发出固定安装导航，成功后切换到目标 Agent", async () => {
    const packId = "longhub.hr-suite";
    const agentId = "longhub-agent-hr";
    const resultPath = join(root, "result.json");
    const inputPath = join(root, "input.json");
    writeFileSync(inputPath, JSON.stringify({
      packId,
      agentId,
      resultPath,
      installPolicyScript: openClawSelectorPolicyScript({
        allowedAgentIds: ["main"],
        installableAgents: [{ packId, agentId, label: "HR 助理", state: "ready" }],
      }),
      installingPolicyScript: openClawSelectorPolicyScript({
        allowedAgentIds: ["main"],
        installableAgents: [{ packId, agentId, label: "HR 助理", state: "installing" }],
      }),
      errorPolicyScript: openClawSelectorPolicyScript({
        allowedAgentIds: ["main"],
        installableAgents: [{ packId, agentId, label: "HR 助理", state: "error", error: "验签失败" }],
      }),
      installedPolicyScript: openClawSelectorPolicyScript({
        allowedAgentIds: ["main", agentId],
        agentLabels: { main: "龙枢助手", [agentId]: "HR 助理" },
      }),
    }), "utf8");
    const electronPath = createRequire(import.meta.url)("electron") as string;
    const runner = fileURLToPath(new URL("./fixtures/agent-install-runner.cjs", import.meta.url));
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
    expect(result.before, JSON.stringify(result)).toEqual([
      { value: "main", label: "龙枢助手", installPack: null },
      {
        value: "__longhub_install__:longhub.hr-suite",
        label: "HR 助理（点击安装）",
        installPack: packId,
      },
    ]);
    expect(result.requestedUrl).toBe(agentPackInstallUrl(packId));
    expect(parseAgentPackInstallUrl(result.requestedUrl)).toEqual({ packId });
    expect(result.requestCount).toBe(1);
    expect(result.installing).toEqual({ label: "HR 助理（安装中…）", disabled: true });
    expect(result.failed).toEqual({ label: "HR 助理（安装失败，点击重试）", disabled: false, title: "验签失败" });
    expect(result.after).toEqual({
      value: agentId,
      options: ["main", agentId],
      selectedAgent: agentId,
      hasNode: false,
    });
  }, 30_000);
});
