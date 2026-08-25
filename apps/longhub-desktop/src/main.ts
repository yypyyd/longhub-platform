/**
 * Electron Main：拉起 OpenClaw Gateway 与 LongHub Core，创建安全隔离窗口并直接
 * 加载 OpenClaw Control UI；保留 LongHub 白名单 IPC 供后续原生扩展使用。
 */
import { basename, join } from "node:path";
import { release as osRelease } from "node:os";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, powerMonitor } from "electron";
import { BoundedWorkflowEngine, newWorkflowRunId, type BridgeExecutionPolicy } from "@longhub/core";
import { verifyClientUpdateMetadata, verifySkillPackageSignature, type BoundedWorkflow } from "@longhub/pack-schema";
import {
  PRODUCT_EXTENSION_ENTRY_IDS,
  inspectOpenClawInstallation,
  parseProductExtensionEntryUrl,
  type ProductExtensionEntryId,
} from "@longhub/openclaw-compat";
import {
  createConsoleLogger,
  redactLogText,
  type ClientGatewayState,
  type ClientProductErrorCode,
} from "@longhub/observability";
import { CoreClient, CoreRequestError } from "./core-client.js";
import { DesktopApp, type SubmitTaskParams } from "./desktop-app.js";
import { DeviceCredentialStore } from "./device-credential-store.js";
import { composeOpenClawAgentConfig, type AgentConfigComposerOptions } from "./agent-config-composer.js";
import { parseAgentPackInstallUrl } from "./agent-install-navigation.js";
import { AgentLifecycleCoordinator } from "./agent-lifecycle-coordinator.js";
import { AgentManagementService } from "./agent-management-service.js";
import { discoverInstallableAgentPacks, type InstallableAgentPack } from "./agent-pack-catalog.js";
import {
  activateInstalledAgentProfiles,
  BUNDLED_OPENCLAW_VERSION,
} from "./agent-runtime-activation.js";
import { AgentRegistry } from "./agent-registry.js";
import { SkillRegistry } from "./skill-registry.js";
import { SkillCatalogClient } from "./skill-catalog-client.js";
import { BUILTIN_WORKER_IMPLEMENTATIONS } from "./skill-runtime-policy.js";
import { SkillCenterService } from "./skill-center-service.js";
import { loadDevelopmentSkillTrustedKeys, loadSkillTrustPolicy } from "./skill-trust-policy.js";
import { resolveModelInputCapabilities } from "./model-input-capabilities.js";
import { SessionManagementService, RecoverableSessionTrash } from "./session-management.js";
import { LocalPersonalProfileStore } from "./local-personal-profile.js";
import { AgentKnowledgeClient } from "./knowledge-client.js";
import { UserDataCenterService } from "./user-data-center-service.js";
import { FileCapabilityStore } from "./file-capability.js";
import { IsolatedFileParser } from "./isolated-file-parser.js";
import { NoCodeWorkspaceService } from "./nocode-workspace-service.js";
import { importOpenClawContentSkill } from "./openclaw-content-importer.js";
import {
  SkillLifecycleCoordinator,
  type CoreSkillGrant,
  type GatewaySkillView,
} from "./skill-lifecycle-coordinator.js";
import { GatewaySupervisor, recoverStaleOpenClawStartupLease, resolveGatewayPort } from "./gateway-supervisor.js";
import { GatewayRuntimeRecovery, waitForGatewayChatPage } from "./gateway-runtime-recovery.js";
import { OpenClawCliGatewayTransport, OpenClawGatewayConfigClient } from "./openclaw-gateway-client.js";
import { CloudPackClient, type SigningKeyInfo } from "./pack-distribution.js";
import { CloudPackEligibilitySource } from "./pack-eligibility.js";
import { PackInstaller } from "./pack-installer.js";
import { openClawAgentSessionUrl, openClawControlUiUrl } from "./openclaw-webui.js";
import {
  buildOpenClawConfig,
  initializeOpenClawWorkspace,
} from "./openclaw-runtime.js";
import { resolveClientRuntimeConfig } from "./runtime-config-resolver.js";
import { FeaturePolicyCoordinator } from "./feature-policy-coordinator.js";
import {
  ProductExtensionWindowCoordinator,
  registerProductExtensionScheme,
} from "./product-extension-window.js";
import {
  isAllowedOpenClawNavigation,
  OPENCLAW_PRODUCT_CSS,
} from "./openclaw-product-policy.js";
import { installOpenClawProductUi } from "./openclaw-product-ui.js";
import { installOpenClawSelectorPolicy, selectOpenClawAgent } from "./openclaw-selector-policy.js";
import { ToolBridgeHost, type ToolBridgeConnection } from "./tool-bridge-host.js";
import { buildToolBridgePolicy } from "./tool-bridge-policy.js";
import { showActivationWindow } from "./activation-window.js";
import { WindowsCredentialManager } from "./windows-credential-manager.js";
import { resolveExternalRuntimePath } from "./packaged-runtime-path.js";
import {
  ClientUpdateVerifier,
  downloadTrustedClientUpdate,
  loadClientUpdateTrustPolicy,
  verifyDownloadedClientUpdate,
  type ClientUpdateTrustPolicy,
} from "./client-update.js";
import { ClientUpdateCoordinator, ClientUpdateRecoveryStore } from "./client-update-coordinator.js";
import { launchWindowsUpdateInstaller, verifyWindowsInstallerAuthenticode } from "./windows-update-installer.js";
import {
  classifyProductError,
  productStatusDefinition,
  productStatusPage,
  type ProductStatusCode,
} from "./product-error-page.js";
import {
  DesktopDiagnosticState,
  DIAGNOSTIC_EXPORT_SCHEMA,
  diagnosticExportFilename,
  isAuthorizedDiagnosticExportNavigation,
  writeDiagnosticReport,
} from "./diagnostic-export.js";
import {
  maintainManagedStorage,
  RotatingJsonlLogWriter,
  StorageFreeSpaceError,
  StorageQuotaCheckError,
  StorageQuotaExceededError,
} from "./storage-maintenance.js";
import { ClientTelemetryReporter } from "./client-telemetry.js";
import { ClientRunMarker } from "./client-run-marker.js";

const DESKTOP_VERSION = app.getVersion();
const STARTUP_STARTED_AT = Date.now();
const logSecrets = new Set<string>();
let fileLogWriter: RotatingJsonlLogWriter | undefined;
const logger = createConsoleLogger("desktop", {
  sensitiveValues: () => [...logSecrets],
  sink(line) {
    process.stdout.write(`${line}\n`);
    if (!fileLogWriter) return;
    try {
      fileLogWriter.write(line);
    } catch {
      // 日志存储故障不能阻断启动，也不能递归记录自身错误。
      fileLogWriter = undefined;
    }
  },
});
const diagnosticState = new DesktopDiagnosticState({
  desktopVersion: DESKTOP_VERSION,
  openClawVersion: BUNDLED_OPENCLAW_VERSION,
  electronVersion: process.versions.electron ?? "unknown",
  nodeVersion: process.versions.node,
  platform: process.platform,
  arch: process.arch,
  osRelease: osRelease(),
  packaged: app.isPackaged,
});
/** 默认云端地址；可用 LONGHUB_CLOUD_URL 环境变量覆盖 */
const DEFAULT_CLOUD_URL = process.env.LONGHUB_CLOUD_URL ?? "https://154-9-26-158.sslip.io";
const dirname = fileURLToPath(new URL(".", import.meta.url));
registerProductExtensionScheme();

function rememberLogSecret(value: string | undefined): void {
  if (value && value.length >= 8) logSecrets.add(value);
}

function safeDiagnostic(error: unknown): string {
  return redactLogText(error instanceof Error ? error.message : String(error), 4_096, [...logSecrets]);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

/** 信任的发布公钥：userData/trusted-keys.json（keyId → Ed25519 公钥 PEM） */
function loadTrustedKeys(): ReadonlyMap<string, string> {
  const file = join(app.getPath("userData"), "trusted-keys.json");
  if (!existsSync(file)) return new Map();
  const parsed = JSON.parse(readFileSync(file, "utf-8")) as Record<string, string>;
  return new Map(Object.entries(parsed));
}

let deviceCredentialStore: DeviceCredentialStore | undefined;
let currentDeviceId: string | undefined;
let telemetry: ClientTelemetryReporter | undefined;
let clientRunMarker: ClientRunMarker | undefined;
let activeProductPolicy: OpenClawRuntimeFiles["productPolicy"] | undefined;
let activeRuntimeFeatures: OpenClawRuntimeFiles["features"] | undefined;

function telemetryGatewayState(phase: string): ClientGatewayState | undefined {
  if (phase === "config-error") return "config_error";
  return ["starting", "running", "restarting", "failed", "stopped"].includes(phase)
    ? phase as ClientGatewayState
    : undefined;
}

/** Skill 信任锚由客户端发布流程预置；目录返回的在线公钥不能自举信任。 */
function loadSkillTrustedKeys(): ReadonlyMap<string, string> {
  const policy = loadSkillTrustPolicy(join(app.getAppPath(), "assets", "skill-trusted-keys.json"));
  if (app.isPackaged) return policy.trustedKeys;
  const development = loadDevelopmentSkillTrustedKeys(process.env.LONGHUB_SKILL_TRUSTED_KEYS_JSON);
  return development.size > 0 ? development : policy.trustedKeys;
}

function telemetryProductCode(code: ProductStatusCode): ClientProductErrorCode {
  return productStatusDefinition(code).publicCode as ClientProductErrorCode;
}

function localDeviceCredentialStore(): DeviceCredentialStore {
  deviceCredentialStore ??= new DeviceCredentialStore({
    stateFile: join(app.getPath("userData"), "device.json"),
    vault: new WindowsCredentialManager(),
    async resolveLegacyDeviceId(baseUrl, deviceToken) {
      rememberLogSecret(deviceToken);
      const status = await new CloudPackClient(baseUrl).getActivationStatus(deviceToken);
      if (!status.device_id) throw new Error("云端未返回旧设备 ID；已保留 device.json 原文");
      return status.device_id;
    },
  });
  return deviceCredentialStore;
}

/** 注册（或复用）设备凭据 */
async function deviceCredentialsFor(baseUrl: string): Promise<{ deviceId: string; deviceToken: string }> {
  const client = new CloudPackClient(baseUrl);
  const credentials = await localDeviceCredentialStore().credentialsFor(
    baseUrl,
    async (fingerprint) => client.registerDevice({
      appVersion: DESKTOP_VERSION,
      deviceFingerprint: fingerprint,
    }),
  );
  rememberLogSecret(credentials.deviceToken);
  return credentials;
}

async function deviceTokenFor(baseUrl: string): Promise<string> {
  return (await deviceCredentialsFor(baseUrl)).deviceToken;
}

/** 注册不等于授权：只有云端确认已核销授权码后，才继续准备模型与 Gateway。 */
async function ensureDeviceActivated(): Promise<boolean> {
  const credentials = await deviceCredentialsFor(DEFAULT_CLOUD_URL);
  currentDeviceId = credentials.deviceId;
  const client = new CloudPackClient(DEFAULT_CLOUD_URL);
  const status = await client.getActivationStatus(credentials.deviceToken);
  if (status.activated) return true;

  const unattendedCode = process.env.LONGHUB_ACTIVATION_CODE;
  if (unattendedCode) {
    rememberLogSecret(unattendedCode);
    await client.activateDevice(credentials.deviceToken, unattendedCode);
    return true;
  }
  return showActivationWindow({
    htmlPath: join(app.getAppPath(), "assets", "activation.html"),
    preloadPath: join(dirname, "activation-preload.cjs"),
    deviceId: credentials.deviceId,
    async activate(code) {
      rememberLogSecret(code);
      const result = await client.activateDevice(credentials.deviceToken, code);
      if (!result.activated) throw new Error("云端未确认激活状态");
    },
  });
}

/** 内嵌小龙虾（OpenClaw）Gateway：端口与运行时/入口发现 */
const DEFAULT_GATEWAY_PORT = 18789;

interface GatewayConnection {
  wsUrl: string;
  token?: string;
}

function persistTrustedKey(key: SigningKeyInfo): void {
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(key.keyId) || !key.publicKeyPem.includes("BEGIN PUBLIC KEY")) {
    throw new Error("云端签名公钥格式无效");
  }
  const file = join(app.getPath("userData"), "trusted-keys.json");
  const temporaryPath = `${file}.tmp`;
  const keys = new Map(loadTrustedKeys());
  keys.set(key.keyId, key.publicKeyPem);
  writeFileSync(temporaryPath, JSON.stringify(Object.fromEntries(keys), null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporaryPath, file);
}

interface OpenClawRuntimeFiles {
  stateDir: string;
  configPath: string;
  modelToken: string;
  bridgePolicy: BridgeExecutionPolicy;
  registry: AgentRegistry;
  baseConfig: Record<string, unknown>;
  composer: Omit<AgentConfigComposerOptions, "profiles">;
  agentIds: readonly string[];
  agentLabels: Readonly<Record<string, string>>;
  productPolicy: { assistant_name: string; welcome_message: string; assistant_avatar_data_url: string };
  features: { agent_catalog: boolean; file_upload: boolean; tool_execution: boolean };
}

function toolBridgePluginPath(): string {
  if (app.isPackaged) {
    const packaged = resolveExternalRuntimePath(
      app.getAppPath(),
      join("node_modules", "@longhub", "openclaw-bridge"),
    );
    if (!existsSync(join(packaged, "openclaw.plugin.json")) || !existsSync(join(packaged, "index.js")) ||
      !existsSync(join(packaged, "dist", "index.js"))) {
      throw new Error("安装包内 LongHub Tool Bridge 插件不完整");
    }
    return packaged;
  }
  const candidates = [
    join(app.getAppPath(), "node_modules", "@longhub", "openclaw-bridge"),
    join(dirname, "..", "..", "..", "packages", "longhub-openclaw-bridge"),
  ];
  const found = candidates.find((candidate) =>
    existsSync(join(candidate, "openclaw.plugin.json")) && existsSync(join(candidate, "index.js")) &&
    existsSync(join(candidate, "dist", "index.js")) && existsSync(join(candidate, "node_modules", "typebox")),
  );
  if (!found) throw new Error("未找到已构建的 LongHub Tool Bridge 插件");
  const digest = createHash("sha256")
    .update(readFileSync(join(found, "openclaw.plugin.json")))
    .update(readFileSync(join(found, "index.js")))
    .update(readFileSync(join(found, "dist", "index.js")))
    .digest("hex").slice(0, 16);
  const target = join(app.getPath("userData"), "product-plugins", `longhub-tool-bridge-${digest}`);
  if (existsSync(join(target, "openclaw.plugin.json")) && existsSync(join(target, "index.js")) &&
    existsSync(join(target, "dist", "index.js")) && existsSync(join(target, "node_modules", "typebox"))) return target;
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  mkdirSync(join(temporary, "dist"), { recursive: true, mode: 0o700 });
  mkdirSync(join(temporary, "node_modules"), { recursive: true, mode: 0o700 });
  for (const file of ["package.json", "openclaw.plugin.json", "index.js"]) {
    copyFileSync(join(found, file), join(temporary, file));
  }
  cpSync(join(found, "dist"), join(temporary, "dist"), { recursive: true, dereference: true });
  cpSync(join(found, "node_modules", "typebox"), join(temporary, "node_modules", "typebox"), {
    recursive: true,
    dereference: true,
  });
  renameSync(temporary, target);
  return target;
}

async function prepareOpenClawRuntime(installer: PackInstaller): Promise<OpenClawRuntimeFiles> {
  const credentials = await deviceCredentialsFor(DEFAULT_CLOUD_URL);
  const stateDir = join(app.getPath("userData"), "openclaw");
  const resolvedRuntime = await resolveClientRuntimeConfig({
    cloudBaseUrl: DEFAULT_CLOUD_URL,
    deviceId: credentials.deviceId,
    deviceToken: credentials.deviceToken,
    cacheFile: join(stateDir, "runtime-config-cache.json"),
    onCacheWriteFailure: () => logger.warn("runtime_config.cache_write_failed"),
  });
  const runtime = resolvedRuntime.config;
  diagnosticState.recordRuntimeConfig({
    source: resolvedRuntime.source,
    attempts: resolvedRuntime.attempts,
    configVersion: runtime.config_version,
    expiresAt: runtime.expires_at,
  });
  logger.info("runtime_config.resolved", {
    source: resolvedRuntime.source,
    attempts: resolvedRuntime.attempts,
    config_version: runtime.config_version,
    expires_at: runtime.expires_at,
  });
  const workspaceDir = join(stateDir, "workspace");
  const avatarPath = join(dirname, "../assets/longhub-avatar.png");
  const configPath = join(stateDir, "openclaw.json");
  const temporaryPath = `${configPath}.tmp`;
  mkdirSync(stateDir, { recursive: true });
  initializeOpenClawWorkspace(workspaceDir, avatarPath);
  mkdirSync(join(stateDir, "agents", "main", "agent"), { recursive: true });
  mkdirSync(join(stateDir, "agents", "main", "sessions"), { recursive: true });
  const registry = new AgentRegistry(join(app.getPath("userData"), "agent-registry.json"));
  const profiles = activateInstalledAgentProfiles({ installer, registry, stateDir });
  const modelCapabilities = await resolveModelInputCapabilities({
    baseUrl: DEFAULT_CLOUD_URL,
    deviceToken: credentials.deviceToken,
  });
  const baseConfig = buildOpenClawConfig(DEFAULT_CLOUD_URL, runtime, workspaceDir, modelCapabilities.input);
  const mainAvatarDataUrl = `data:image/png;base64,${readFileSync(avatarPath).toString("base64")}`;
  const composer: Omit<AgentConfigComposerOptions, "profiles"> = {
    stateDir,
    mainWorkspaceDir: workspaceDir,
    mainAvatarDataUrl,
    desktopVersion: DESKTOP_VERSION,
    openclawVersion: BUNDLED_OPENCLAW_VERSION,
    modelPolicies: { "longhub.model.default": `${runtime.provider_id}/${runtime.model_id}` },
    toolBridgePluginPath: toolBridgePluginPath(),
  };
  const config = composeOpenClawAgentConfig(baseConfig, { ...composer, profiles });
  writeFileSync(temporaryPath, JSON.stringify(config, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporaryPath, configPath);
  return {
    stateDir,
    configPath,
    modelToken: credentials.deviceToken,
    bridgePolicy: runtime.features.tool_execution ? buildToolBridgePolicy(profiles) : {},
    registry,
    baseConfig,
    composer,
    agentIds: ["main", ...profiles.map((profile) => profile.registry.agentId)],
    agentLabels: Object.fromEntries([
      ["main", runtime.product.assistant_name],
      ...profiles.map((profile) => [profile.registry.agentId, profile.profile.display.name]),
    ]),
    productPolicy: {
      assistant_name: runtime.product.assistant_name,
      welcome_message: runtime.product.welcome_message,
      assistant_avatar_data_url: mainAvatarDataUrl,
    },
    features: runtime.features,
  };
}

/** 真实 Node 运行时：打包版用随安装包分发的 node.exe，开发环境用 PATH 上的 node */
function nodeRuntimePath(): string | undefined {
  if (app.isPackaged) {
    const bundled = join(process.resourcesPath, "node-runtime", "node.exe");
    return existsSync(bundled) ? bundled : undefined;
  }
  return process.env.LONGHUB_NODE_PATH ?? "node";
}

function openclawEntryPath(): string | undefined {
  let entry: string | undefined;
  if (app.isPackaged) {
    try {
      entry = resolveExternalRuntimePath(
        app.getAppPath(),
        join("node_modules", "openclaw", "openclaw.mjs"),
      );
    } catch {
      return undefined;
    }
  } else {
    entry = [
      join(app.getAppPath(), "node_modules", "openclaw", "openclaw.mjs"),
      join(dirname, "..", "node_modules", "openclaw", "openclaw.mjs"),
    ].find((candidate) => existsSync(candidate));
  }
  if (entry) inspectOpenClawInstallation(entry);
  return entry;
}

let gateway: GatewaySupervisor | undefined;

/** 拉起内嵌 Gateway；缺运行时/入口时返回失败，由主窗口显示专用错误页。 */
async function startEmbeddedGateway(
  runtime: OpenClawRuntimeFiles,
  bridgeConnection?: ToolBridgeConnection,
): Promise<GatewayConnection | undefined> {
  if (process.env.OPENCLAW_GATEWAY_URL) {
    rememberLogSecret(process.env.OPENCLAW_GATEWAY_TOKEN);
    diagnosticState.recordGatewayState({ phase: "running", pid: process.pid });
    telemetry?.recordGatewayState("running");
    return {
      wsUrl: process.env.OPENCLAW_GATEWAY_URL,
      token: process.env.OPENCLAW_GATEWAY_TOKEN,
    };
  }
  const nodeExecutable = nodeRuntimePath();
  const entryScript = openclawEntryPath();
  if (!nodeExecutable || !entryScript) {
    logger.warn("gateway.runtime_missing");
    return undefined;
  }
  try {
    if (await recoverStaleOpenClawStartupLease({
      nodeExecutable,
      stateDir: runtime.stateDir,
      configPath: runtime.configPath,
    })) logger.warn("gateway.startup_lease_recovered");
  } catch (err) {
    // 恢复检查失败不应阻断正常启动；Gateway 自身仍会执行标准校验。
    logger.warn("gateway.startup_lease_recovery_failed", { error: err });
  }
  const configuredPort = process.env.OPENCLAW_GATEWAY_PORT;
  const preferredPort = Number(configuredPort ?? DEFAULT_GATEWAY_PORT);
  let gatewayPort: number;
  try {
    // 显式端口保持严格语义；产品默认端口冲突时分配新端口，但绝不复用未知 Gateway。
    gatewayPort = await resolveGatewayPort(preferredPort, configuredPort === undefined);
  } catch (err) {
    logger.warn("gateway.port_allocation_failed", { error: err });
    return undefined;
  }
  if (gatewayPort !== preferredPort) {
    logger.info("gateway.port_reassigned", { preferred_port: preferredPort, gateway_port: gatewayPort });
  }
  const token = process.env.OPENCLAW_GATEWAY_TOKEN ?? randomBytes(32).toString("hex");
  rememberLogSecret(token);
  rememberLogSecret(bridgeConnection?.token);
  let startupFailure: ProductStatusCode | undefined;
  gateway = new GatewaySupervisor({
    nodeExecutable,
    entryScript,
    args: ["gateway", "--port", String(gatewayPort), "--auth", "token"],
    env: {
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_STATE_DIR: runtime.stateDir,
      OPENCLAW_CONFIG_PATH: runtime.configPath,
      LONGHUB_MODEL_TOKEN: runtime.modelToken,
      ...(bridgeConnection
        ? {
            LONGHUB_BRIDGE_URL: bridgeConnection.endpoint,
            LONGHUB_BRIDGE_TOKEN: bridgeConnection.token,
          }
        : {}),
    },
    onStateChange: (state) => {
      diagnosticState.recordGatewayState(state);
      logger.info("gateway.state_changed", { state });
      const telemetryState = telemetryGatewayState(state.phase);
      if (telemetryState) telemetry?.recordGatewayState(telemetryState);
      if (state.phase === "config-error") startupFailure = "GATEWAY_CONFIG_ERROR";
      if (state.phase === "failed") startupFailure = "GATEWAY_RESTART_EXHAUSTED";
      gatewayRuntimeRecovery?.handle(state);
    },
  });
  gateway.start();
  // 首次启动可能需要迁移既有 OpenClaw SQLite 状态；必须看到真实 HTML `/chat`，不能只凭 TCP 端口。
  const ready = await waitForGatewayChatPage(`http://127.0.0.1:${gatewayPort}/chat`, 120_000, {
    shouldAbort: () => startupFailure !== undefined,
  });
  if (!ready) {
    logger.warn("gateway.start_timeout");
    await gateway.stop();
    gateway = undefined;
    if (startupFailure) throw Object.assign(new Error(startupFailure), { code: startupFailure });
    return undefined;
  }
  gateway.markHealthy();
  return { wsUrl: `ws://127.0.0.1:${gatewayPort}`, token };
}

let core: CoreClient | undefined;
let desktopApp: DesktopApp | undefined;
let mainWindow: BrowserWindow | undefined;
let bridgeHost: ToolBridgeHost | undefined;
let allowedAgentIds: readonly string[] = ["main"];
let agentLabels: Readonly<Record<string, string>> = { main: "龙枢助手" };
let installableAgents: readonly InstallableAgentPack[] = [];
let activeControlUiUrl: string | undefined;
let gatewayRuntimeRecovery: GatewayRuntimeRecovery | undefined;
let catalogTimer: NodeJS.Timeout | undefined;
let updateTimer: NodeJS.Timeout | undefined;
let updateHealthTimer: NodeJS.Timeout | undefined;
let updateCoordinator: ClientUpdateCoordinator | undefined;
let featurePolicyCoordinator: FeaturePolicyCoordinator | undefined;
let productExtensionWindows: ProductExtensionWindowCoordinator | undefined;
let agentManagementService: AgentManagementService | undefined;
let skillCenterService: SkillCenterService | undefined;
let userDataCenterService: UserDataCenterService | undefined;
let noCodeWorkspaceService: NoCodeWorkspaceService | undefined;
let installedSkillCorePolicy: readonly CoreSkillGrant[] = [];
let installedGatewaySkills: readonly GatewaySkillView[] = [];
let removeConfirmationListener: (() => void) | undefined;
let refreshBridgePolicyConstraint: (() => Promise<void>) | undefined;
const confirmationWaiters = new Map<
  string,
  { promise: Promise<boolean>; resolve: (approved: boolean) => void; timer: NodeJS.Timeout }
>();
let updateRecovery: ClientUpdateRecoveryStore | undefined;
let updatePolicy: ClientUpdateTrustPolicy | undefined;
let updateChecksStarted = false;
let runtimeStoppedForUpdate = false;
let unresolvedUpdateAtStartup = false;
let powerResumeHandler: (() => void) | undefined;
let rollbackInFlight: Promise<void> | undefined;
let diagnosticExportInFlight = false;

function settleConfirmationWaiter(toolCallId: string, approved: boolean): void {
  const waiter = confirmationWaiters.get(toolCallId);
  if (!waiter) return;
  confirmationWaiters.delete(toolCallId);
  clearTimeout(waiter.timer);
  waiter.resolve(approved);
}

function registerConfirmationWaiter(toolCallId: string, expiresAt: string): void {
  settleConfirmationWaiter(toolCallId, false);
  let resolvePromise!: (approved: boolean) => void;
  const promise = new Promise<boolean>((resolve) => {
    resolvePromise = resolve;
  });
  const timer = setTimeout(
    () => settleConfirmationWaiter(toolCallId, false),
    Math.max(1, Date.parse(expiresAt) - Date.now()),
  );
  timer.unref();
  confirmationWaiters.set(toolCallId, { promise, resolve: resolvePromise, timer });
}

function clearConfirmationWaiters(): void {
  for (const toolCallId of confirmationWaiters.keys()) settleConfirmationWaiter(toolCallId, false);
}

async function stopRuntimeForUpdate(): Promise<void> {
  if (runtimeStoppedForUpdate) return;
  runtimeStoppedForUpdate = true;
  if (catalogTimer) clearInterval(catalogTimer);
  catalogTimer = undefined;
  if (updateTimer) clearTimeout(updateTimer);
  updateTimer = undefined;
  featurePolicyCoordinator?.stop();
  featurePolicyCoordinator = undefined;
  productExtensionWindows?.dispose();
  productExtensionWindows = undefined;
  agentManagementService = undefined;
  skillCenterService = undefined;
  userDataCenterService = undefined;
  noCodeWorkspaceService = undefined;
  installedSkillCorePolicy = [];
  installedGatewaySkills = [];
  removeConfirmationListener?.();
  removeConfirmationListener = undefined;
  clearConfirmationWaiters();
  refreshBridgePolicyConstraint = undefined;
  desktopApp?.stop();
  await gateway?.stop();
  await bridgeHost?.stop();
}

const PRODUCT_EXTENSION_FEATURES = {
  agents: "agent.catalog",
  skills: "skill.catalog",
  account: "memory.user_controls",
} as const;

function allowedProductExtensionEntries(): readonly ProductExtensionEntryId[] {
  return PRODUCT_EXTENSION_ENTRY_IDS.filter((entry) =>
    featurePolicyCoordinator?.decide(PRODUCT_EXTENSION_FEATURES[entry]).allowed === true,
  );
}

function constrainBridgePolicy(policy: BridgeExecutionPolicy): BridgeExecutionPolicy {
  const writeAllowed = featurePolicyCoordinator?.current()?.source === "network"
    && featurePolicyCoordinator.decide("skill.catalog").allowed;
  const managedSkillIds = new Set(
    [...Object.values(BUILTIN_WORKER_IMPLEMENTATIONS), ...installedSkillCorePolicy.map((grant) => grant.skillId)],
  );
  const enabledBindings = new Set(
    installedSkillCorePolicy.map((grant) => `${grant.agentId}\0${grant.skillId}`),
  );
  return Object.fromEntries(Object.entries(policy).map(([agentId, grants]) => [
    agentId,
    grants.filter((grant) =>
      (!grant.confirmation || writeAllowed) &&
      (!managedSkillIds.has(grant.skillId) || enabledBindings.has(`${agentId}\0${grant.skillId}`))),
  ]));
}

function isProductExtensionEntryAllowed(entry: ProductExtensionEntryId): boolean {
  return allowedProductExtensionEntries().includes(entry);
}

function syncFeaturePolicyConstraints(): void {
  productExtensionWindows?.closeDisabledEntries();
  void refreshBridgePolicyConstraint?.()
    .catch((error) => logger.warn("feature_policy.bridge_sync_failed", { error }));
}

async function executeAutomaticClientRollback(reason: string): Promise<void> {
  if (rollbackInFlight) return rollbackInFlight;
  rollbackInFlight = (async () => {
    if (!updateRecovery || updatePolicy?.status !== "approved" || !updatePolicy.expected_signer_subject) {
      throw new Error("客户端自动回滚缺少已审批的更新信任策略");
    }
    const pending = updateRecovery.pending();
    if (!pending) return;
    if (!verifyClientUpdateMetadata(pending.rollback_metadata, updatePolicy.trustedKeys)) {
      throw new Error("客户端回滚安装器元数据签名无效或密钥不受信任");
    }
    if (pending.rollback_metadata.manifest.version !== pending.previous_version) {
      throw new Error("客户端回滚安装器版本与 pending 状态不一致");
    }
    await verifyDownloadedClientUpdate(
      pending.rollback_installer_path,
      pending.rollback_metadata.manifest,
    );
    verifyWindowsInstallerAuthenticode(
      pending.rollback_installer_path,
      updatePolicy.expected_signer_subject,
    );
    await stopRuntimeForUpdate();
    const prepared = updateRecovery.prepareRollback(reason);
    verifyWindowsInstallerAuthenticode(
      prepared.rollback_installer_path,
      updatePolicy.expected_signer_subject,
    );
    await launchWindowsUpdateInstaller(prepared.rollback_installer_path);
    logger.warn("client_update.rollback_launched", {
      previous_version: prepared.previous_version,
      target_version: prepared.target_version,
      attempts: prepared.attempts,
      reason,
    });
    app.quit();
  })();
  try {
    await rollbackInFlight;
  } finally {
    rollbackInFlight = undefined;
  }
}

async function updateConfirmation(options: Electron.MessageBoxOptions): Promise<boolean> {
  const result = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  return result.response === 1;
}

function scheduleClientUpdateCheck(delayMs: number): void {
  if (!updateCoordinator || runtimeStoppedForUpdate) return;
  if (updateTimer) clearTimeout(updateTimer);
  updateTimer = setTimeout(() => {
    updateTimer = undefined;
    void updateCoordinator!.checkOnce().then((result) => {
      logger.info("client_update.check_completed", { result });
      telemetry?.recordUpdateResult(result);
      if (result === "install_launched") app.quit();
    }).catch((error) => {
      logger.error("client_update.transaction_failed", { error });
      telemetry?.recordUpdateResult("failed");
      dialog.showErrorBox("龙枢更新失败", safeDiagnostic(error));
      if (runtimeStoppedForUpdate) {
        app.relaunch();
        app.exit(1);
      }
    }).finally(() => {
      if (!runtimeStoppedForUpdate) scheduleClientUpdateCheck(6 * 60 * 60_000);
    });
  }, delayMs);
  updateTimer.unref();
}

async function markMainWindowHealthy(): Promise<void> {
  if (updateHealthTimer) clearTimeout(updateHealthTimer);
  updateHealthTimer = undefined;
  try {
    const pending = updateRecovery?.pending();
    if (pending?.target_version === DESKTOP_VERSION) {
      if (
        updatePolicy?.status !== "approved" || !updatePolicy.expected_signer_subject ||
        !verifyClientUpdateMetadata(pending.target_metadata, updatePolicy.trustedKeys)
      ) throw new Error("客户端目标版本健康确认缺少可信签名元数据");
      await verifyDownloadedClientUpdate(pending.target_installer_path, pending.target_metadata.manifest);
      verifyWindowsInstallerAuthenticode(pending.target_installer_path, updatePolicy.expected_signer_subject);
    }
    updateRecovery?.markHealthy(DESKTOP_VERSION);
    if (pending?.target_version === DESKTOP_VERSION) telemetry?.recordUpdateResult("healthy");
    diagnosticState.recordUpdateStartup({ pending: false, attempts: 0 });
  } catch (error) {
    logger.error("client_update.health_marker_failed", { error });
    updateCoordinator = undefined;
    void executeAutomaticClientRollback("health_marker_failed").catch((rollbackError) => {
      logger.error("client_update.rollback_failed", { error: rollbackError });
      dialog.showErrorBox("龙枢自动回滚失败", safeDiagnostic(rollbackError));
      app.quit();
    });
    return;
  }
  if (unresolvedUpdateAtStartup) {
    logger.warn("client_update.disabled", { reason: "unresolved_previous_update" });
    return;
  }
  if (!updateChecksStarted && updateCoordinator) {
    updateChecksStarted = true;
    scheduleClientUpdateCheck(30_000);
  }
}

function syncSelectorPolicy(): void {
  diagnosticState.recordAgentCounts(allowedAgentIds.length, installableAgents.length);
  if (!mainWindow || mainWindow.isDestroyed()) return;
  void installOpenClawSelectorPolicy(mainWindow.webContents, {
    allowedAgentIds,
    agentLabels,
    installableAgents,
  }).catch((error) => logger.warn("selector.policy_update_failed", { error }));
}

async function refreshInstallableAgents(): Promise<void> {
  if (!desktopApp) return;
  if (activeRuntimeFeatures?.agent_catalog === false) {
    installableAgents = [];
    syncSelectorPolicy();
    return;
  }
  const token = await deviceTokenFor(DEFAULT_CLOUD_URL);
  const discovered = await discoverInstallableAgentPacks({
    client: new CloudPackClient(DEFAULT_CLOUD_URL),
    deviceToken: token,
    installedPackIds: new Set(
      desktopApp.listPacks().filter((pack) => pack.activeVersion).map((pack) => pack.packId),
    ),
  });
  const currentByPack = new Map(installableAgents.map((agent) => [agent.packId, agent]));
  installableAgents = discovered.map((agent) => {
    const current = currentByPack.get(agent.packId);
    return current?.state === "installing" ? current : agent;
  });
  syncSelectorPolicy();
}

async function provisionAgentPack(packId: string): Promise<void> {
  if (!desktopApp || !activeControlUiUrl) return;
  const candidate = installableAgents.find((agent) => agent.packId === packId);
  if (!candidate || candidate.state === "installing") return;
  installableAgents = installableAgents.map((agent) =>
    agent.packId === packId ? { ...agent, state: "installing", error: undefined } : agent,
  );
  syncSelectorPolicy();
  try {
    const token = await deviceTokenFor(DEFAULT_CLOUD_URL);
    const result = await desktopApp.provisionAgentPackFromCloud({
      baseUrl: DEFAULT_CLOUD_URL,
      deviceToken: token,
      packId,
      version: candidate.version,
    });
    if (!result.ok) throw new Error(result.message);
    installableAgents = installableAgents.filter((agent) => agent.packId !== packId);
    syncSelectorPolicy();
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.loadURL(openClawAgentSessionUrl(activeControlUiUrl, candidate.agentId));
    }
  } catch (error) {
    installableAgents = installableAgents.map((agent) =>
      agent.packId === packId
        ? { ...agent, state: "error", error: safeDiagnostic(error) }
        : agent,
    );
    syncSelectorPolicy();
  }
}

async function showProductStatus(code: ProductStatusCode): Promise<void> {
  diagnosticState.recordProductStatus(code);
  telemetry?.recordProductError(telemetryProductCode(code));
  const targetWindow = mainWindow;
  if (!targetWindow || targetWindow.isDestroyed()) return;
  try {
    await targetWindow.loadURL(productStatusPage(code));
  } catch (error) {
    logger.error("webui.error_page_load_failed", { code, error });
  }
}

async function requestDiagnosticExport(): Promise<void> {
  if (diagnosticExportInFlight) return;
  diagnosticExportInFlight = true;
  try {
    const options: Electron.SaveDialogOptions = {
      title: "导出龙枢诊断信息",
      defaultPath: join(app.getPath("downloads"), diagnosticExportFilename()),
      filters: [{ name: "JSON 诊断信息", extensions: ["json"] }],
    };
    const targetWindow = mainWindow;
    const result = targetWindow && !targetWindow.isDestroyed()
      ? await dialog.showSaveDialog(targetWindow, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return;
    const bytes = writeDiagnosticReport(result.filePath, diagnosticState.report());
    logger.info("diagnostic.exported", { schema_version: DIAGNOSTIC_EXPORT_SCHEMA, bytes });
    const confirmation: Electron.MessageBoxOptions = {
      type: "info",
      title: "诊断信息已导出",
      message: "龙枢诊断信息已安全导出",
      detail: "文件只包含脱敏状态，可发送给管理员或技术支持。",
      buttons: ["知道了"],
      defaultId: 0,
      noLink: true,
    };
    if (targetWindow && !targetWindow.isDestroyed()) {
      await dialog.showMessageBox(targetWindow, confirmation);
    } else {
      await dialog.showMessageBox(confirmation);
    }
  } catch {
    logger.warn("diagnostic.export_failed");
    dialog.showErrorBox("诊断信息导出失败", "请选择其他位置后重试。");
  } finally {
    diagnosticExportInFlight = false;
  }
}

function createWindow(controlUiUrl?: string, statusCode: ProductStatusCode = "GATEWAY_START_TIMEOUT"): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 640,
    title: "龙枢",
    icon: join(dirname, "../assets/longhub-icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // 主窗口就是 OpenClaw 原生 Control UI，不再套一层 LongHub React 面板。
  // 同时不挂载 LongHub preload，避免上游页面取得本地安装/任务 IPC 权限。
  const targetWindow = mainWindow;
  targetWindow.removeMenu();
  diagnosticState.recordProductStatus(controlUiUrl ? undefined : statusCode);
  if (!controlUiUrl) telemetry?.recordProductError(telemetryProductCode(statusCode));
  const chatUrl = controlUiUrl ? new URL(controlUiUrl) : undefined;
  targetWindow.webContents.on("will-navigate", (event, target) => {
    if (isAuthorizedDiagnosticExportNavigation(target, diagnosticState.hasProductStatus())) {
      event.preventDefault();
      void requestDiagnosticExport();
      return;
    }
    if (!chatUrl) {
      event.preventDefault();
      return;
    }
    try {
      const entry = parseProductExtensionEntryUrl(target);
      event.preventDefault();
      void productExtensionWindows?.open(entry).catch((error) => {
        logger.warn("product_extension.open_failed", { entry, error });
      });
      return;
    } catch {
      // 非产品入口继续交给既有安装、诊断和同源导航策略处理。
    }
    const installRequest = parseAgentPackInstallUrl(target);
    if (installRequest) {
      event.preventDefault();
      void provisionAgentPack(installRequest.packId).catch((error) => {
        logger.warn("packs.provision_failed", { error });
      });
      return;
    }
    if (isAllowedOpenClawNavigation(target, chatUrl.toString())) return;
    event.preventDefault();
    void targetWindow.loadURL(chatUrl.toString());
  });
  targetWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  if (controlUiUrl) {
    let healthyReported = false;
    targetWindow.webContents.on("did-navigate-in-page", (_event, target) => {
      if (!isAllowedOpenClawNavigation(target, chatUrl!.toString())) void targetWindow.loadURL(chatUrl!.toString());
    });
    targetWindow.webContents.on("did-finish-load", () => {
      if (!isAllowedOpenClawNavigation(targetWindow.webContents.getURL(), chatUrl!.toString())) return;
      diagnosticState.recordProductStatus(undefined);
      void targetWindow.webContents.insertCSS(OPENCLAW_PRODUCT_CSS);
      void installOpenClawProductUi(targetWindow.webContents, activeProductPolicy)
        .catch((error) => logger.warn("product_ui.policy_update_failed", { error }));
      syncSelectorPolicy();
      if (!healthyReported && isAllowedOpenClawNavigation(targetWindow.webContents.getURL(), chatUrl!.toString())) {
        healthyReported = true;
        void markMainWindowHealthy();
      }
    });
  }
  void (async () => {
    try {
      await targetWindow.loadURL(controlUiUrl ?? productStatusPage(statusCode));
    } catch (err) {
      if (targetWindow.isDestroyed()) return;
      logger.warn("webui.chat_page_load_failed", { error: err });
      await showProductStatus("WEBUI_LOAD_FAILED");
    }
  })();
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
}

app.whenReady().then(async () => {
  clientRunMarker = new ClientRunMarker(app.getPath("userData"), {
    onFailure: (code) => logger.warn("telemetry.run_marker_unavailable", { code }),
  });
  const previousExit = clientRunMarker.begin();
  try {
    fileLogWriter = new RotatingJsonlLogWriter(app.getPath("userData"));
  } catch (error) {
    logger.warn("storage.log_writer_unavailable", { error });
  }
  updateRecovery = new ClientUpdateRecoveryStore(app.getPath("userData"));
  try {
    updatePolicy = loadClientUpdateTrustPolicy(
      join(app.getAppPath(), "assets", "update-trusted-keys.json"),
    );
    if (updatePolicy.status !== "approved") {
      diagnosticState.recordUpdateTrustPolicy("pending");
      logger.info("client_update.disabled", { reason: "trust_policy_pending" });
    } else {
      diagnosticState.recordUpdateTrustPolicy("approved");
    }
  } catch (error) {
    diagnosticState.recordUpdateTrustPolicy("invalid");
    logger.error("client_update.trust_policy_invalid", { error });
    updatePolicy = undefined;
  }
  try {
    const startup = updateRecovery.beginStartup(DESKTOP_VERSION);
    diagnosticState.recordUpdateStartup(startup);
    if (startup.rollbackCompleted) logger.warn("client_update.rollback_completed", { ...startup });
    if (startup.pending) logger.info("client_update.pending_startup", { ...startup });
    unresolvedUpdateAtStartup = startup.pending && startup.targetVersion !== DESKTOP_VERSION;
    if (startup.shouldRollback) {
      await executeAutomaticClientRollback("startup_failure_threshold");
      return;
    }
    if (startup.pending && startup.targetVersion === DESKTOP_VERSION) {
      updateHealthTimer = setTimeout(() => {
        updateHealthTimer = undefined;
        void executeAutomaticClientRollback("webui_health_timeout").catch((error) => {
          logger.error("client_update.rollback_failed", { error });
          dialog.showErrorBox("龙枢自动回滚失败", safeDiagnostic(error));
          app.quit();
        });
      }, 180_000);
      updateHealthTimer.unref();
    }
  } catch (error) {
    logger.error("client_update.pending_state_invalid", { error });
    dialog.showErrorBox("龙枢更新恢复状态无效", safeDiagnostic(error));
    app.quit();
    return;
  }
  try {
    const report = maintainManagedStorage({
      userDataDir: app.getPath("userData"),
      protectedPaths: updateRecovery.maintenanceProtectedPaths(),
    });
    logger.info("storage.maintenance_completed", {
      deleted_files: report.deletedFiles,
      deleted_directories: report.deletedDirectories,
      reclaimed_bytes: report.reclaimedBytes,
      state_bytes: report.stateBytes,
      skipped_unsafe_entries: report.skippedUnsafeEntries,
      errors: report.errors,
    });
  } catch (error) {
    if (error instanceof StorageFreeSpaceError) {
      logger.error("storage.free_space_low", {
        available_bytes: error.availableBytes,
        required_bytes: error.requiredBytes,
        code: error.code,
      });
      createWindow(undefined, "STORAGE_SPACE_LOW");
      return;
    }
    if (error instanceof StorageQuotaExceededError || error instanceof StorageQuotaCheckError) {
      logger.error("storage.quota_exceeded", {
        ...(error instanceof StorageQuotaExceededError
          ? { state_bytes: error.stateBytes, limit_bytes: error.limitBytes }
          : { quota_check_failed: true }),
        code: error.code,
      });
      createWindow(undefined, "STORAGE_QUOTA_EXCEEDED");
      return;
    }
    logger.warn("storage.maintenance_failed", { error });
  }
  try {
    if (!(await ensureDeviceActivated())) {
      app.quit();
      return;
    }
    const credentials = await deviceCredentialsFor(DEFAULT_CLOUD_URL);
    const deviceToken = credentials.deviceToken;
    featurePolicyCoordinator = new FeaturePolicyCoordinator({
      cloudBaseUrl: DEFAULT_CLOUD_URL,
      deviceId: credentials.deviceId,
      deviceToken: credentials.deviceToken,
      desktopVersion: DESKTOP_VERSION,
      cacheFile: join(app.getPath("userData"), "openclaw", "feature-policy-cache.json"),
      onEmergencyDisabled(featureIds) {
        logger.warn("feature_policy.emergency_disabled", { feature_ids: featureIds });
        syncFeaturePolicyConstraints();
      },
      onRefresh(snapshot) {
        logger.info("feature_policy.refreshed", {
          policy_version: snapshot.document.policy_version,
          source: snapshot.source,
          feature_count: snapshot.document.features.length,
        });
        syncFeaturePolicyConstraints();
      },
      onError(error) {
        logger.warn("feature_policy.refresh_failed", { code: error.code, reason: error.reason });
      },
    });
    void featurePolicyCoordinator.refresh().catch((error) => {
      logger.warn("feature_policy.initial_refresh_failed", {
        code: error instanceof Error && "code" in error ? error.code : "FEATURE_POLICY_UNAVAILABLE",
      });
    });
    featurePolicyCoordinator.startPolling();
    productExtensionWindows = new ProductExtensionWindowCoordinator({
      assetsDir: join(app.getAppPath(), "assets"),
      preloadPath: join(dirname, "product-extension-preload.cjs"),
      iconPath: join(dirname, "../assets/longhub-icon.png"),
      parentWindow: () => mainWindow,
      isEntryAllowed: isProductExtensionEntryAllowed,
      agentCenter: {
        read: () => {
          if (!agentManagementService) throw new Error("智能体中心尚未就绪");
          return agentManagementService.read();
        },
        perform: (params) => {
          if (!agentManagementService) throw new Error("智能体中心尚未就绪");
          return agentManagementService.perform(params);
        },
      },
      skillCenter: {
        read: () => {
          if (!skillCenterService) throw new Error("能力中心尚未就绪");
          return skillCenterService.read();
        },
        perform: (params) => {
          if (!skillCenterService) throw new Error("能力中心尚未就绪");
          return skillCenterService.perform(params);
        },
      },
      dataCenter: {
        read: (agentId) => {
          if (!userDataCenterService) throw new Error("用户数据中心尚未就绪");
          return userDataCenterService.read(agentId);
        },
        perform: (params) => {
          if (!userDataCenterService) throw new Error("用户数据中心尚未就绪");
          return userDataCenterService.perform(params);
        },
      },
      noCodeCenter: {
        read: () => {
          if (!noCodeWorkspaceService) throw new Error("无代码工作台尚未就绪");
          return noCodeWorkspaceService.read();
        },
        perform: (params) => {
          if (!noCodeWorkspaceService) throw new Error("无代码工作台尚未就绪");
          return noCodeWorkspaceService.perform(params);
        },
      },
      onDenied(entry) {
        logger.warn("product_extension.open_denied", { entry });
      },
      async respondConfirmation(request, approved) {
        if (!core) throw new Error("LongHub Core 尚未就绪");
        try {
          await core.request("confirm.respond", {
            confirmationId: request.confirmationId,
            approved,
          });
          settleConfirmationWaiter(request.toolCallId, approved);
        } catch (error) {
          settleConfirmationWaiter(request.toolCallId, false);
          throw error;
        }
        logger.info("confirmation.responded", {
          confirmation_id: request.confirmationId,
          agent_id: request.agentId,
          skill_id: request.skillId,
          approved,
        });
      },
    });
    await productExtensionWindows.start();
    if (process.platform === "win32" && (process.arch === "x64" || process.arch === "arm64")) {
      telemetry = new ClientTelemetryReporter({
        baseUrl: DEFAULT_CLOUD_URL,
        deviceToken,
        desktopVersion: DESKTOP_VERSION,
        openClawVersion: BUNDLED_OPENCLAW_VERSION,
        platform: process.platform,
        architecture: process.arch,
        onDrop: () => logger.warn("telemetry.batch_dropped"),
      });
      if (previousExit) telemetry.recordPreviousExit(previousExit);
    } else {
      logger.info("telemetry.disabled", { reason: "unsupported_platform" });
    }
  } catch (error) {
    dialog.showErrorBox("龙枢激活服务不可用", safeDiagnostic(error));
    app.quit();
    return;
  }
  const installer = new PackInstaller(join(app.getPath("userData"), "packs"));
  let runtime: OpenClawRuntimeFiles | undefined;
  let runtimeStatusCode: ProductStatusCode = "MODEL_NOT_CONFIGURED";
  try {
    runtime = await prepareOpenClawRuntime(installer);
  } catch (err) {
    diagnosticState.recordRuntimeConfigFailure();
    logger.warn("runtime.prepare_failed", { error: err });
    runtimeStatusCode = classifyProductError(err, "MODEL_NOT_CONFIGURED");
  }
  let bridgeConnection: ToolBridgeConnection | undefined;
  if (runtime) {
    activeProductPolicy = runtime.productPolicy;
    activeRuntimeFeatures = runtime.features;
    try {
      const bridgeToken = randomBytes(32).toString("hex");
      rememberLogSecret(bridgeToken);
      bridgeHost = new ToolBridgeHost({
        token: bridgeToken,
        async execute(request) {
          if (!core) throw new Error("LongHub Core 尚未就绪");
          try {
            return await core.request("bridge.execute", { ...request });
          } catch (error) {
            if (!(error instanceof CoreRequestError) || error.code !== "BRIDGE_CONFIRMATION_REQUIRED") {
              throw error;
            }
            const waiter = confirmationWaiters.get(request.context.toolCallId);
            if (!waiter || !(await waiter.promise)) {
              throw Object.assign(new Error("用户拒绝、关闭或确认已过期"), {
                code: "BRIDGE_FORBIDDEN",
              });
            }
            return core.request("bridge.execute", { ...request });
          }
        },
      });
      bridgeConnection = await bridgeHost.start();
    } catch (err) {
      logger.warn("bridge.start_failed", { error: err });
      runtimeStatusCode = classifyProductError(err);
      bridgeHost = undefined;
    }
  }
  let gatewayConnection: GatewayConnection | undefined;
  let gatewayStartupStatus: ProductStatusCode | undefined;
  if (runtime && bridgeConnection) {
    try {
      gatewayConnection = await startEmbeddedGateway(runtime, bridgeConnection);
    } catch (err) {
      logger.warn("gateway.start_failed", { error: err });
      gatewayStartupStatus = classifyProductError(err, "GATEWAY_START_TIMEOUT");
    }
  }
  let controlUiUrl: string | undefined;
  let gatewayStatusCode: ProductStatusCode = gatewayStartupStatus
    ?? (runtime && bridgeConnection ? "GATEWAY_START_TIMEOUT" : runtimeStatusCode);
  if (gatewayConnection) {
    try {
      controlUiUrl = openClawControlUiUrl(gatewayConnection.wsUrl, {
        explicitUrl: process.env.LONGHUB_OPENCLAW_WEBUI_URL,
        token: gatewayConnection.token,
      });
      activeControlUiUrl = controlUiUrl;
    } catch (err) {
      logger.warn("webui.url_invalid", { error: err });
      gatewayStatusCode = "GATEWAY_CONFIG_ERROR";
    }
  }
  if (controlUiUrl && gateway) {
    const chatUrl = controlUiUrl;
    gatewayRuntimeRecovery = new GatewayRuntimeRecovery({
      async probeChatPage(pid, reason) {
        if (gateway?.pid !== pid) return false;
        const ready = await waitForGatewayChatPage(chatUrl, reason === "resume" ? 15_000 : 120_000, {
          shouldAbort: () => gateway?.pid !== pid,
        });
        return ready && gateway?.pid === pid;
      },
      showStatus: showProductStatus,
      async restoreChatPage(pid) {
        if (gateway?.pid !== pid) return;
        gateway.markHealthy();
        const targetWindow = mainWindow;
        if (!targetWindow || targetWindow.isDestroyed()) return;
        try {
          await targetWindow.loadURL(chatUrl);
        } catch (error) {
          logger.warn("webui.recovery_load_failed", { error });
          await showProductStatus("WEBUI_LOAD_FAILED");
        }
      },
    });
    powerResumeHandler = () => {
      const supervisor = gateway;
      const recovery = gatewayRuntimeRecovery;
      if (!supervisor || !recovery) return;
      recovery.handleHostResume(supervisor.pid, () => supervisor.restart());
    };
    powerMonitor.on("resume", powerResumeHandler);
  }
  allowedAgentIds = runtime?.agentIds ?? ["main"];
  agentLabels = runtime?.agentLabels ?? { main: "龙枢助手" };
  diagnosticState.recordAgentCounts(allowedAgentIds.length, installableAgents.length);
  core = new CoreClient({
    corePath: join(dirname, "core-process.js"),
    nodeExecutable: process.execPath,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      LONGHUB_BRIDGE_POLICY: JSON.stringify(constrainBridgePolicy(runtime?.bridgePolicy ?? {})),
      LONGHUB_CLOUD_URL: DEFAULT_CLOUD_URL,
      LONGHUB_DEVICE_TOKEN: runtime?.modelToken ?? "",
      LONGHUB_MANAGER_VERSION: DESKTOP_VERSION,
      ...(gatewayConnection
        ? {
            OPENCLAW_GATEWAY_URL: gatewayConnection.wsUrl,
            ...(gatewayConnection.token
              ? { OPENCLAW_GATEWAY_TOKEN: gatewayConnection.token }
              : {}),
          }
        : {}),
    },
  });
  const trustedKeys = loadTrustedKeys();
  const gatewayTransport = runtime && gatewayConnection && gateway
    ? (() => {
        const nodeExecutable = nodeRuntimePath();
        const entryScript = openclawEntryPath();
        if (!nodeExecutable || !entryScript) return undefined;
        return new OpenClawCliGatewayTransport({
          nodeExecutable,
          entryScript,
          wsUrl: gatewayConnection.wsUrl,
          token: gatewayConnection.token,
          env: {
            OPENCLAW_STATE_DIR: runtime.stateDir,
            OPENCLAW_CONFIG_PATH: runtime.configPath,
            LONGHUB_MODEL_TOKEN: runtime.modelToken,
          },
        });
      })()
    : undefined;
  const lifecycle = runtime && gatewayTransport
    ? (() => {
        const gatewayClient = new OpenClawGatewayConfigClient(gatewayTransport);
        return new AgentLifecycleCoordinator({
          installer,
          registry: runtime.registry,
          installContext: { trustedKeys, desktopVersion: DESKTOP_VERSION },
          stateDir: runtime.stateDir,
          baseConfig: runtime.baseConfig,
          composer: runtime.composer,
          gateway: gatewayClient,
          eligibility: new CloudPackEligibilitySource({
            baseUrl: DEFAULT_CLOUD_URL,
            deviceToken: runtime.modelToken,
            desktopVersion: DESKTOP_VERSION,
          }),
          initialBridgePolicy: runtime.bridgePolicy,
          constrainBridgePolicy,
          async replaceBridgePolicy(policy) {
            if (!core) throw new Error("LongHub Core 尚未就绪");
            await core.request("bridge.policy.replace", policy as Record<string, unknown>);
          },
          onAgentsChanged(agents) {
            allowedAgentIds = agents.map((agent) => agent.id);
            agentLabels = Object.fromEntries(agents.map((agent) => [agent.id, agent.label]));
            syncSelectorPolicy();
          },
          onAgentsRemoved(agentIds) {
            logger.info("packs.agents_removed", { agent_ids: agentIds });
            // 历史会话仍会让上游重新列出已移除 Agent，因此显式进入 main，并由允许列表隐藏旧选项。
            if (mainWindow && !mainWindow.isDestroyed() && controlUiUrl) {
              void mainWindow.loadURL(openClawAgentSessionUrl(controlUiUrl, "main"));
            }
          },
          onSyncError(error) {
            logger.warn("packs.entitlement_sync_failed", { error, selector_preserved: true });
          },
        });
      })()
    : undefined;
  if (runtime) {
    agentManagementService = new AgentManagementService({
      currentAgentId: () => {
        if (!mainWindow || mainWindow.isDestroyed()) return "main";
        try {
          const session = new URL(mainWindow.webContents.getURL()).searchParams.get("session") ?? "";
          return /^agent:([^:]+):/i.exec(session)?.[1]?.toLowerCase() ?? "main";
        } catch {
          return "main";
        }
      },
      agents: () => [
        { agentId: "main", name: agentLabels.main ?? "龙枢助手", enabled: true, builtIn: true },
        ...runtime.registry.list().map((entry) => ({
          agentId: entry.agentId,
          name: agentLabels[entry.agentId] ?? entry.profileId,
          packId: entry.packId,
          enabled: entry.enabled,
          builtIn: false,
        })),
      ],
      installableAgents: () => installableAgents,
      async selectAgent(agentId) {
        if (!mainWindow || mainWindow.isDestroyed() || !await selectOpenClawAgent(mainWindow.webContents, agentId)) {
          throw new Error("OpenClaw 智能体切换器当前不可用");
        }
      },
      installAgent: provisionAgentPack,
      async enableAgent(packId) {
        if (!lifecycle) throw new Error("智能体生命周期当前不可用");
        await lifecycle.enablePack(packId);
      },
      async disableAgent(packId) {
        if (!lifecycle) throw new Error("智能体生命周期当前不可用");
        await lifecycle.disablePack(packId);
      },
    });
  }
  refreshBridgePolicyConstraint = lifecycle
    ? () => lifecycle.refreshBridgePolicyConstraint()
    : undefined;
  if (runtime && currentDeviceId) {
    const skillRegistry = new SkillRegistry(
      join(app.getPath("userData"), "skills", "skill-registry.json"),
      `${DEFAULT_CLOUD_URL}\0${currentDeviceId}`,
    );
    const skillTrustedKeys = loadSkillTrustedKeys();
    const skillCatalog = new SkillCatalogClient({
      baseUrl: DEFAULT_CLOUD_URL,
      deviceToken: runtime.modelToken,
      openclawVersion: BUNDLED_OPENCLAW_VERSION,
      trustedKeys: skillTrustedKeys,
    });
    const skillLifecycle = new SkillLifecycleCoordinator({
      registry: skillRegistry,
      verifyPackage: async (manifest) => {
        const publicKey = skillTrustedKeys.get(manifest.integrity.signatureKeyId);
        if (!publicKey || !verifySkillPackageSignature(manifest, publicKey)) {
          throw new Error("Skill 引用签名不受当前客户端信任");
        }
      },
      verifyEntitlement: async (skillId, version) => {
        try {
          await skillCatalog.reference(skillId, version);
          return true;
        } catch {
          return false;
        }
      },
      readCorePolicy: async () => structuredClone(installedSkillCorePolicy),
      replaceCorePolicy: async (policy) => {
        installedSkillCorePolicy = structuredClone(policy);
        await refreshBridgePolicyConstraint?.();
      },
      readGatewaySkills: async () => structuredClone(installedGatewaySkills),
      replaceGatewaySkills: async (skills) => {
        installedGatewaySkills = structuredClone(skills);
      },
    });
    skillCenterService = new SkillCenterService({
      catalog: skillCatalog,
      registry: skillRegistry,
      lifecycle: skillLifecycle,
      agents: () => runtime.registry.list().filter((entry) => entry.enabled).map((entry) => ({
        profileId: entry.profileId,
        agentId: entry.agentId,
        name: agentLabels[entry.agentId] ?? entry.profileId,
      })),
    });
    if (gatewayTransport) {
      const sessionService = new SessionManagementService(gatewayTransport);
      const personalProfile = new LocalPersonalProfileStore(
        join(app.getPath("userData"), "personal-profile.json"),
        `${DEFAULT_CLOUD_URL}\0${currentDeviceId}\0${app.getPath("userData")}`,
      );
      const fileCapabilities = new FileCapabilityStore(join(app.getPath("userData"), "attachments", "staging"));
      const parserNode = nodeRuntimePath();
      const fileParser = parserNode ? new IsolatedFileParser({
        nodeExecutable: parserNode,
        workerScript: join(dirname, "file-parser-worker.js"),
      }) : undefined;
      userDataCenterService = new UserDataCenterService({
        agents: () => runtime.registry.list().filter((entry) => entry.enabled).map((entry) => ({
          agentId: entry.agentId,
          name: agentLabels[entry.agentId] ?? entry.profileId,
        })),
        sessions: sessionService,
        trash: new RecoverableSessionTrash(
          join(app.getPath("userData"), "sessions", "trash.json"),
          sessionService,
        ),
        personal: personalProfile,
        knowledge: new AgentKnowledgeClient({
          baseUrl: DEFAULT_CLOUD_URL,
          deviceToken: runtime.modelToken,
        }),
        attachments: {
          async selectAndParse(agentId, sessionId) {
            if (!fileParser) throw new Error("隔离文件解析器不可用");
            const selected = await dialog.showOpenDialog({
              title: "选择要提供给当前智能体的文本附件",
              properties: ["openFile", "multiSelections"],
              filters: [{ name: "安全文本附件", extensions: ["txt", "md", "json", "csv"] }],
            });
            if (selected.canceled || selected.filePaths.length === 0) return [];
            const context = { agentId, sessionId };
            const handles = fileCapabilities.issueFromTrustedPicker(selected.filePaths, context);
            const previews = [];
            try {
              for (const handle of handles) {
                const consumed = fileCapabilities.consume(handle.handleId, context);
                const parsed = await fileParser.parse(consumed.stagedPath);
                previews.push({ filename: handle.filename, ...parsed });
              }
              return previews;
            } finally {
              for (const handle of handles) fileCapabilities.cancel(handle.handleId, context);
            }
          },
        },
      });
      const workspaceAgents = () => runtime.registry.list().filter((entry) => entry.enabled).map((entry) => ({
        agentId: entry.agentId,
        profileId: entry.profileId,
        name: agentLabels[entry.agentId] ?? entry.profileId,
      }));
      const effectiveBridgeGrants = (agentId: string) => constrainBridgePolicy(runtime.bridgePolicy)[agentId] ?? [];
      let workspaceService!: NoCodeWorkspaceService;
      noCodeWorkspaceService = workspaceService = new NoCodeWorkspaceService({
        stateFile: join(app.getPath("userData"), "nocode", "workspace.json"),
        owner: `${DEFAULT_CLOUD_URL}\0${currentDeviceId}\0${app.getPath("userData")}`,
        agents: workspaceAgents,
        personalEntryIds: (agentId) => personalProfile.list(agentId).map((entry) => entry.entryId),
        authorizedSkillIds: (agentId) => [
          ...new Set([
            ...effectiveBridgeGrants(agentId).map((grant) => grant.skillId),
            ...installedSkillCorePolicy.filter((grant) => grant.agentId === agentId).map((grant) => grant.skillId),
          ]),
        ],
        async runWorkflow(workflow: BoundedWorkflow, agentId: string) {
          const grants = new Map(effectiveBridgeGrants(agentId).map((grant) => [grant.skillId, grant]));
          const engine = new BoundedWorkflowEngine({
            async describeSkill(skillId) {
              if (skillId.startsWith("user.skill.")) {
                workspaceService.contentSkillInstructions(skillId);
                return { sideEffect: "none", requiresConfirmation: false };
              }
              const grant = grants.get(skillId);
              if (!grant) throw new Error("Workflow 子 Skill 未通过当前 Core policy");
              const externalWrite = grant.requiredPermissions.some((permission) =>
                /(?:^|:)(?:write|delete|send|pay|admin)(?:$|:)/i.test(permission));
              return { sideEffect: externalWrite ? "external_write" : "none", requiresConfirmation: false };
            },
            async requestConfirmation(input) {
              const target = BrowserWindow.getFocusedWindow() ?? mainWindow;
              const options: Electron.MessageBoxOptions = {
                type: "question",
                title: "Workflow 步骤确认 - 龙枢",
                message: input.title,
                detail: `${input.summary}\n\n目标智能体：${input.agentId}\n步骤：${input.stepId}`,
                buttons: ["取消", "确认执行"],
                defaultId: 0,
                cancelId: 0,
                noLink: true,
              };
              const result = target && !target.isDestroyed()
                ? await dialog.showMessageBox(target, options)
                : await dialog.showMessageBox(options);
              return result.response === 1;
            },
            async authorizeAndExecute(input) {
              if (input.skillId.startsWith("user.skill.")) {
                return { output: { instructions: workspaceService.contentSkillInstructions(input.skillId) }, costMicros: 0 };
              }
              const grant = grants.get(input.skillId);
              if (!grant || !core) throw new Error("Workflow 子 Skill 当前不可用");
              const request = {
                skillId: input.skillId,
                input: input.payload,
                context: {
                  agentId,
                  sessionKey: `workflow:${input.runId}`,
                  sessionId: input.runId,
                  toolCallId: input.idempotencyKey,
                },
              };
              let output: unknown;
              try {
                output = await core.request("bridge.execute", request);
              } catch (error) {
                if (!(error instanceof CoreRequestError) || error.code !== "BRIDGE_CONFIRMATION_REQUIRED") throw error;
                const waiter = confirmationWaiters.get(input.idempotencyKey);
                if (!waiter || !(await waiter.promise)) throw new Error("Workflow 子步骤未获用户确认");
                output = await core.request("bridge.execute", request);
              }
              return { output, costMicros: Math.max(0, grant.budget.maxCostCents * 10_000) };
            },
          });
          return engine.execute(workflow, {
            runId: newWorkflowRunId(),
            agentId,
            input: {},
            maxCostMicros: 100_000_000,
            maxDurationMs: 5 * 60_000,
          });
        },
        async selectOpenClawContent() {
          const selected = await dialog.showOpenDialog({
            title: "选择纯内容 OpenClaw Skill 的 SKILL.md",
            properties: ["openFile"],
            filters: [{ name: "OpenClaw 纯内容 Skill", extensions: ["md"] }],
          });
          if (selected.canceled || selected.filePaths.length !== 1) return undefined;
          const source = selected.filePaths[0]!;
          const stat = lstatSync(source);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 ||
            realpathSync.native(source).toLowerCase() !== source.toLowerCase() || basename(source).toLowerCase() !== "skill.md") {
            throw new Error("OpenClaw Content Skill 入口无效");
          }
          return importOpenClawContentSkill({ "SKILL.md": readFileSync(source) });
        },
      });
    }
  }
  desktopApp = new DesktopApp(core, installer, {
    trustedKeys,
    desktopVersion: DESKTOP_VERSION,
  }, lifecycle, { persistTrustedKey });
  desktopApp.start();
  await refreshBridgePolicyConstraint?.();
  removeConfirmationListener = core.onConfirmationRequest((request) => {
    registerConfirmationWaiter(request.toolCallId, request.expiresAt);
    void (async () => {
      const opened = await productExtensionWindows?.openConfirmation(request) ?? false;
      if (!opened) {
        await core?.request("confirm.respond", {
          confirmationId: request.confirmationId,
          approved: false,
        });
        settleConfirmationWaiter(request.toolCallId, false);
      }
    })().catch(async (error) => {
      logger.warn("confirmation.open_failed", {
        confirmation_id: request.confirmationId,
        agent_id: request.agentId,
        skill_id: request.skillId,
        error,
      });
      try {
        await core?.request("confirm.respond", {
          confirmationId: request.confirmationId,
          approved: false,
        });
      } catch {
        // Core 不可用时确认天然无法执行；保持 fail-closed。
      }
      settleConfirmationWaiter(request.toolCallId, false);
    });
  });
  if (
    updateRecovery && updatePolicy?.status === "approved" && updatePolicy.expected_signer_subject && currentDeviceId &&
    (app.isPackaged || process.env.LONGHUB_ENABLE_CLIENT_UPDATE === "1")
  ) {
    const verifier = new ClientUpdateVerifier({
      cloudBaseUrl: DEFAULT_CLOUD_URL,
      currentVersion: DESKTOP_VERSION,
      channel: updatePolicy.channel,
      rolloutIdentity: currentDeviceId,
      trustedKeys: updatePolicy.trustedKeys,
      stateFile: join(app.getPath("userData"), "client-update-state.json"),
      rollbackRecordFile: updateRecovery.rollbackRecordPath,
    });
    const signerSubject = updatePolicy.expected_signer_subject;
    updateCoordinator = new ClientUpdateCoordinator({
      currentVersion: DESKTOP_VERSION,
      check: () => verifier.check(),
      revalidate: () => verifier.check(),
      resolveRollback: () => verifier.fetchVersion(DESKTOP_VERSION),
      confirmDownload: (metadata) => updateConfirmation({
        type: "info",
        title: "龙枢更新",
        message: `发现龙枢 ${metadata.manifest.version}`,
        detail: "更新包已通过龙枢发布签名验证。是否现在下载？",
        buttons: ["稍后", "下载更新"],
        defaultId: 1,
        cancelId: 0,
        noLink: true,
      }),
      download: (update) => downloadTrustedClientUpdate({
        metadata: update.metadata,
        artifactUrl: update.artifactUrl,
        directory: join(app.getPath("userData"), "client-updates", "downloads", update.metadata.manifest.version),
      }),
      downloadRollback: (update) => downloadTrustedClientUpdate({
        metadata: update.metadata,
        artifactUrl: update.artifactUrl,
        directory: updateRecovery!.installerDirectory(update.metadata.manifest.version),
      }),
      verifyInstaller: (path) => { verifyWindowsInstallerAuthenticode(path, signerSubject); },
      confirmInstall: (metadata) => updateConfirmation({
        type: "info",
        title: "龙枢更新已就绪",
        message: `龙枢 ${metadata.manifest.version} 已安全下载`,
        detail: "立即安装会关闭当前聊天窗口；安装完成后龙枢将重新启动。",
        buttons: ["稍后重启", "立即重启安装"],
        defaultId: 1,
        cancelId: 0,
        noLink: true,
      }),
      stopRuntime: stopRuntimeForUpdate,
      snapshot: updateRecovery,
      launchInstaller: launchWindowsUpdateInstaller,
    });
  }
  void refreshInstallableAgents().catch((error) => {
    logger.warn("packs.catalog_unavailable", { error });
  });
  catalogTimer = setInterval(() => {
    void refreshInstallableAgents().catch((error) => {
      logger.warn("packs.catalog_sync_failed", { error });
    });
  }, 30_000);
  catalogTimer.unref();
  desktopApp.onTaskEvent((event) => {
    mainWindow?.webContents.send("task:event", event);
  });

  ipcMain.handle("core:hello", () => desktopApp!.hello());
  ipcMain.handle("device:info", async () => {
    try {
      const credentials = await deviceCredentialsFor(DEFAULT_CLOUD_URL);
      return { ok: true, deviceId: credentials.deviceId, baseUrl: DEFAULT_CLOUD_URL };
    } catch (err) {
      return {
        ok: false,
        baseUrl: DEFAULT_CLOUD_URL,
        message: safeDiagnostic(err),
      };
    }
  });
  ipcMain.handle("task:submit", (_e, params: SubmitTaskParams) =>
    desktopApp!.submitTask(params),
  );
  ipcMain.handle("task:get", (_e, taskId: string) => desktopApp!.getTask(taskId));
  ipcMain.handle("task:cancel", (_e, taskId: string) => desktopApp!.cancelTask(taskId));
  ipcMain.handle("packs:list", () => desktopApp!.listPacks());
  ipcMain.handle("packs:enable", (_e, packId: string) => desktopApp!.enablePack(packId));
  ipcMain.handle("packs:disable", (_e, packId: string) => desktopApp!.disablePack(packId));
  ipcMain.handle("packs:rollback", (_e, packId: string) => desktopApp!.rollbackPack(packId));
  ipcMain.handle(
    "packs:installFromCloud",
    async (_e, params: { baseUrl: string; packId: string; version?: string }) => {
      try {
        const deviceToken = await deviceTokenFor(params.baseUrl);
        return await desktopApp!.installPackFromCloud({ ...params, deviceToken });
      } catch (err) {
        return {
          ok: false,
          code: "CLOUD_UNREACHABLE",
          message: safeDiagnostic(err),
        };
      }
    },
  );
  ipcMain.handle("packs:install", async () => {
    const result = await dialog.showOpenDialog({
      title: "选择 LongHub Agent Pack",
      filters: [{ name: "LongHub Agent Pack", extensions: ["json"] }],
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, code: "CANCELLED", message: "已取消" };
    }
    return desktopApp!.installPackFromFile(result.filePaths[0]!);
  });

  telemetry?.recordStarted(Date.now() - STARTUP_STARTED_AT, allowedAgentIds.length);
  createWindow(controlUiUrl, gatewayStatusCode);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(controlUiUrl, gatewayStatusCode);
    }
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("will-quit", () => {
  clientRunMarker?.markClean();
  if (catalogTimer) clearInterval(catalogTimer);
  if (updateTimer) clearTimeout(updateTimer);
  if (updateHealthTimer) clearTimeout(updateHealthTimer);
  if (powerResumeHandler) powerMonitor.removeListener("resume", powerResumeHandler);
  featurePolicyCoordinator?.stop();
  featurePolicyCoordinator = undefined;
  productExtensionWindows?.dispose();
  productExtensionWindows = undefined;
  agentManagementService = undefined;
  removeConfirmationListener?.();
  removeConfirmationListener = undefined;
  clearConfirmationWaiters();
  refreshBridgePolicyConstraint = undefined;
  desktopApp?.stop();
  telemetry?.stop();
  void gateway?.stop();
  void bridgeHost?.stop();
});
