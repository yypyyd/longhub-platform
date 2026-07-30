import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DesktopDiagnosticState,
  DIAGNOSTIC_EXPORT_SCHEMA,
  DIAGNOSTIC_EXPORT_URL,
  diagnosticExportFilename,
  isAuthorizedDiagnosticExportNavigation,
  isDiagnosticExportUrl,
  writeDiagnosticReport,
} from "../src/diagnostic-export.js";

const NOW = Date.parse("2026-07-30T01:02:03.456Z");
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "longhub-diagnostic-"));
  temporaryDirectories.push(root);
  return root;
}

function state(): DesktopDiagnosticState {
  return new DesktopDiagnosticState({
    desktopVersion: "0.4.0",
    openClawVersion: "2026.7.1-2",
    electronVersion: "31.7.7",
    nodeVersion: "24.15.0",
    platform: "win32",
    arch: "x64",
    osRelease: "10.0.26100",
    packaged: true,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
  }
});

describe("脱敏诊断快照", () => {
  it("只生成固定 schema 下的白名单状态", () => {
    const diagnostic = state();
    diagnostic.recordProductStatus("CLOUD_UNREACHABLE");
    diagnostic.recordGatewayState({ phase: "restarting", attempt: 2, delayMs: 1_000, exitCode: 1 });
    diagnostic.recordRuntimeConfig({
      source: "cache",
      attempts: 3,
      configVersion: "2026-07-30T00:00:00.000Z",
      expiresAt: "2026-07-30T00:10:00.000Z",
    });
    diagnostic.recordUpdateTrustPolicy("approved");
    diagnostic.recordUpdateStartup({ pending: true, attempts: 1, phase: "installing_update" });
    diagnostic.recordAgentCounts(2, 1);

    expect(diagnostic.report(NOW)).toEqual({
      schema_version: DIAGNOSTIC_EXPORT_SCHEMA,
      generated_at: "2026-07-30T01:02:03.456Z",
      application: {
        desktop_version: "0.4.0",
        openclaw_version: "2026.7.1-2",
        electron_version: "31.7.7",
        node_version: "24.15.0",
        platform: "win32",
        arch: "x64",
        os_release: "10.0.26100",
        packaged: true,
      },
      product: { status_code: "LH-CL-001" },
      gateway: { phase: "restarting", attempt: 2 },
      runtime_config: {
        state: "resolved",
        source: "cache",
        attempts: 3,
        config_version: "2026-07-30T00:00:00.000Z",
        expires_at: "2026-07-30T00:10:00.000Z",
      },
      update: {
        trust_policy: "approved",
        pending: true,
        phase: "installing_update",
        attempts: 1,
      },
      agents: { active_count: 2, installable_count: 1 },
    });
  });

  it("拒绝把自由文本伪装成版本或配置版本写入报告", () => {
    const secret = "Bearer dt-secret C:\\Users\\alice\\private.txt https://provider.example/v1";
    const diagnostic = new DesktopDiagnosticState({
      desktopVersion: secret,
      openClawVersion: secret,
      electronVersion: secret,
      nodeVersion: secret,
      platform: secret,
      arch: secret,
      osRelease: secret,
      packaged: false,
    });
    diagnostic.recordRuntimeConfig({
      source: "network",
      attempts: 1,
      configVersion: secret,
      expiresAt: secret,
    });
    const serialized = JSON.stringify(diagnostic.report(NOW));

    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("provider.example");
    expect(serialized).not.toMatch(/token|authorization|prompt|message|session|device_id|path|url/i);
  });

  it("运行配置失败只保留状态，不保留异常", () => {
    const diagnostic = state();
    diagnostic.recordRuntimeConfigFailure();
    expect(diagnostic.report(NOW).runtime_config).toEqual({
      state: "failed",
      source: null,
      attempts: null,
      config_version: null,
      expires_at: null,
    });
  });
});

describe("诊断导出导航", () => {
  it("只接受错误页中的精确固定 URL", () => {
    expect(isDiagnosticExportUrl(DIAGNOSTIC_EXPORT_URL)).toBe(true);
    expect(isAuthorizedDiagnosticExportNavigation(DIAGNOSTIC_EXPORT_URL, true)).toBe(true);
    expect(isAuthorizedDiagnosticExportNavigation(DIAGNOSTIC_EXPORT_URL, false)).toBe(false);
  });

  it.each([
    "https://example.com/export",
    "longhub-diagnostics://export/extra",
    "longhub-diagnostics://export/?token=secret",
    "longhub-diagnostics://export/#secret",
    "longhub-diagnostics://user:pass@export/",
    "longhub-diagnostics://other/",
    "not a url",
  ])("拒绝非精确诊断导航：%s", (target) => {
    expect(isDiagnosticExportUrl(target)).toBe(false);
  });
});

describe("诊断文件写入", () => {
  it("使用安全文件名并原子写入用户选择的 JSON 文件", () => {
    const root = temporaryDirectory();
    const target = join(root, diagnosticExportFilename(NOW));
    writeFileSync(target, "old", "utf8");
    const report = state().report(NOW);
    const bytes = writeDiagnosticReport(target, report);

    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual(report);
    expect(bytes).toBe(Buffer.byteLength(`${JSON.stringify(report, null, 2)}\n`));
    expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(diagnosticExportFilename(NOW)).toBe("longhub-diagnostic-2026-07-30T01-02-03.456Z.json");
  });

  it("拒绝相对路径、非 JSON 和符号链接目标", () => {
    const root = temporaryDirectory();
    expect(() => writeDiagnosticReport("relative.json", state().report(NOW))).toThrow("路径无效");
    expect(() => writeDiagnosticReport(join(root, "report.txt"), state().report(NOW))).toThrow("路径无效");

    const target = join(root, "target.json");
    const link = join(root, "report.json");
    writeFileSync(target, "sentinel", "utf8");
    try {
      symlinkSync(target, link, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    expect(() => writeDiagnosticReport(link, state().report(NOW))).toThrow("不是普通文件");
    expect(readFileSync(target, "utf8")).toBe("sentinel");
  });
});
