import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { GatewayState } from "./gateway-supervisor.js";
import {
  productStatusDefinition,
  type ProductStatusCode,
} from "./product-error-page.js";

export const DIAGNOSTIC_EXPORT_SCHEMA = "longhub/diagnostic-export/v1" as const;
export const DIAGNOSTIC_EXPORT_URL = "longhub-diagnostics://export/";

type GatewayPhase = "not_started" | GatewayState["phase"];
type RuntimeConfigState = "not_resolved" | "resolved" | "failed";
type RuntimeConfigSource = "network" | "cache" | null;
type UpdateTrustState = "unavailable" | "pending" | "approved" | "invalid";
type UpdatePhase = "installing_update" | "rollback_launched" | null;

export interface DiagnosticApplicationInfo {
  desktopVersion: string;
  openClawVersion: string;
  electronVersion: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  osRelease: string;
  packaged: boolean;
}

export interface RuntimeConfigDiagnosticInput {
  source: Exclude<RuntimeConfigSource, null>;
  attempts: number;
  configVersion: string;
  expiresAt: string;
}

export interface UpdateStartupDiagnosticInput {
  pending: boolean;
  attempts: number;
  phase?: Exclude<UpdatePhase, null>;
}

export interface DesktopDiagnosticReport {
  schema_version: typeof DIAGNOSTIC_EXPORT_SCHEMA;
  generated_at: string;
  application: {
    manager_version: string;
    openclaw_version: string;
    electron_version: string;
    node_version: string;
    platform: string;
    arch: string;
    os_release: string;
    packaged: boolean;
  };
  product: { status_code: string | null };
  gateway: { phase: GatewayPhase; attempt: number | null };
  runtime_config: {
    state: RuntimeConfigState;
    source: RuntimeConfigSource;
    attempts: number | null;
    config_version: string | null;
    expires_at: string | null;
  };
  update: {
    trust_policy: UpdateTrustState;
    pending: boolean;
    phase: UpdatePhase;
    attempts: number;
  };
  agents: { active_count: number; installable_count: number };
}

function safeRelease(value: string): string {
  return /^[a-zA-Z0-9._+-]{1,64}$/.test(value) ? value : "unknown";
}

function canonicalInstant(value: string): string | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? value : null;
}

function safeConfigVersion(value: string): string {
  return value === "unconfigured" || canonicalInstant(value) ? value : "invalid";
}

function safeCount(value: number, maximum: number): number {
  return Number.isInteger(value) && value >= 0 && value <= maximum ? value : 0;
}

function gatewayAttempt(state: GatewayState): number | null {
  return "attempt" in state ? safeCount(state.attempt, 10) : null;
}

/**
 * 只接受 Main 主动提供的枚举和计数，不读取日志、目录、环境变量、Credential Manager 或聊天状态。
 */
export class DesktopDiagnosticState {
  private productStatus: ProductStatusCode | undefined;
  private gateway = { phase: "not_started" as GatewayPhase, attempt: null as number | null };
  private runtimeConfig: DesktopDiagnosticReport["runtime_config"] = {
    state: "not_resolved",
    source: null,
    attempts: null,
    config_version: null,
    expires_at: null,
  };
  private update: DesktopDiagnosticReport["update"] = {
    trust_policy: "unavailable",
    pending: false,
    phase: null,
    attempts: 0,
  };
  private agents = { active_count: 0, installable_count: 0 };

  constructor(private readonly application: DiagnosticApplicationInfo) {}

  recordProductStatus(code: ProductStatusCode | undefined): void {
    this.productStatus = code;
  }

  hasProductStatus(): boolean {
    return this.productStatus !== undefined;
  }

  recordGatewayState(state: GatewayState): void {
    this.gateway = { phase: state.phase, attempt: gatewayAttempt(state) };
  }

  recordRuntimeConfig(input: RuntimeConfigDiagnosticInput): void {
    this.runtimeConfig = {
      state: "resolved",
      source: input.source,
      attempts: safeCount(input.attempts, 5),
      config_version: safeConfigVersion(input.configVersion),
      expires_at: canonicalInstant(input.expiresAt),
    };
  }

  recordRuntimeConfigFailure(): void {
    this.runtimeConfig = {
      state: "failed",
      source: null,
      attempts: null,
      config_version: null,
      expires_at: null,
    };
  }

  recordUpdateTrustPolicy(state: UpdateTrustState): void {
    this.update = { ...this.update, trust_policy: state };
  }

  recordUpdateStartup(input: UpdateStartupDiagnosticInput): void {
    this.update = {
      ...this.update,
      pending: input.pending,
      phase: input.phase ?? null,
      attempts: safeCount(input.attempts, 10),
    };
  }

  recordAgentCounts(activeCount: number, installableCount: number): void {
    this.agents = {
      active_count: safeCount(activeCount, 1_000),
      installable_count: safeCount(installableCount, 1_000),
    };
  }

  report(now = Date.now()): DesktopDiagnosticReport {
    const generatedAt = new Date(now).toISOString();
    return {
      schema_version: DIAGNOSTIC_EXPORT_SCHEMA,
      generated_at: generatedAt,
      application: {
        manager_version: safeRelease(this.application.desktopVersion),
        openclaw_version: safeRelease(this.application.openClawVersion),
        electron_version: safeRelease(this.application.electronVersion),
        node_version: safeRelease(this.application.nodeVersion),
        platform: safeRelease(this.application.platform),
        arch: safeRelease(this.application.arch),
        os_release: safeRelease(this.application.osRelease),
        packaged: this.application.packaged,
      },
      product: {
        status_code: this.productStatus
          ? productStatusDefinition(this.productStatus).publicCode
          : null,
      },
      gateway: { ...this.gateway },
      runtime_config: { ...this.runtimeConfig },
      update: { ...this.update },
      agents: { ...this.agents },
    };
  }
}

export function isDiagnosticExportUrl(target: string): boolean {
  try {
    const url = new URL(target);
    return url.protocol === "longhub-diagnostics:" && url.hostname === "export" &&
      url.pathname === "/" && !url.username && !url.password && !url.port && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function isAuthorizedDiagnosticExportNavigation(target: string, productStatusVisible: boolean): boolean {
  return productStatusVisible && isDiagnosticExportUrl(target);
}

export function diagnosticExportFilename(now = Date.now()): string {
  const stamp = new Date(now).toISOString().replaceAll(":", "-");
  return `longhub-diagnostic-${stamp}.json`;
}

/** 原子导出到用户明确选择的位置；拒绝符号链接或非普通目标。 */
export function writeDiagnosticReport(path: string, report: DesktopDiagnosticReport): number {
  if (!isAbsolute(path) || !path.toLowerCase().endsWith(".json")) {
    throw new Error("诊断导出文件路径无效");
  }
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("诊断导出目标不是普通文件");
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, payload, "utf8");
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    return Buffer.byteLength(payload);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
