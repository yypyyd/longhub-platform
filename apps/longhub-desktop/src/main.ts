/**
 * Electron Main：创建窗口（Context Isolation + 禁用 Node Integration），
 * 拉起 Core 进程，向 Renderer 暴露白名单 IPC。
 */
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { connect } from "node:net";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { CoreClient } from "./core-client.js";
import { DesktopApp, type SubmitTaskParams } from "./desktop-app.js";
import { GatewaySupervisor } from "./gateway-supervisor.js";
import { CloudPackClient } from "./pack-distribution.js";
import { PackInstaller } from "./pack-installer.js";

const DESKTOP_VERSION = "1.0.0";
/** 默认云端地址；可用 LONGHUB_CLOUD_URL 环境变量覆盖 */
const DEFAULT_CLOUD_URL = process.env.LONGHUB_CLOUD_URL ?? "http://154.9.26.158:8081";
const dirname = fileURLToPath(new URL(".", import.meta.url));

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

/** 设备指纹与凭据：userData/device.json；正式版凭据改存 Windows Credential Manager */
interface DeviceState {
  fingerprint: string;
  tokensByBaseUrl: Record<string, string>;
  idsByBaseUrl?: Record<string, string>;
}

function loadDeviceState(): DeviceState {
  const file = join(app.getPath("userData"), "device.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf-8")) as DeviceState;
  const state: DeviceState = { fingerprint: `fp-${randomUUID()}`, tokensByBaseUrl: {} };
  writeFileSync(file, JSON.stringify(state, null, 2), "utf-8");
  return state;
}

function saveDeviceState(state: DeviceState): void {
  writeFileSync(join(app.getPath("userData"), "device.json"), JSON.stringify(state, null, 2), "utf-8");
}

/** 注册（或复用）设备凭据 */
async function deviceCredentialsFor(baseUrl: string): Promise<{ deviceId: string; deviceToken: string }> {
  const state = loadDeviceState();
  const cachedToken = state.tokensByBaseUrl[baseUrl];
  const cachedId = state.idsByBaseUrl?.[baseUrl];
  if (cachedToken && cachedId) return { deviceId: cachedId, deviceToken: cachedToken };
  const client = new CloudPackClient(baseUrl);
  const credentials = await client.registerDevice({
    appVersion: DESKTOP_VERSION,
    deviceFingerprint: state.fingerprint,
  });
  state.tokensByBaseUrl[baseUrl] = credentials.deviceToken;
  state.idsByBaseUrl = { ...state.idsByBaseUrl, [baseUrl]: credentials.deviceId };
  saveDeviceState(state);
  return credentials;
}

async function deviceTokenFor(baseUrl: string): Promise<string> {
  return (await deviceCredentialsFor(baseUrl)).deviceToken;
}

/** 内嵌小龙虾（OpenClaw）Gateway：端口与运行时/入口发现 */
const GATEWAY_PORT = Number(process.env.OPENCLAW_GATEWAY_PORT ?? 18789);
const GATEWAY_URL = `ws://127.0.0.1:${GATEWAY_PORT}`;

/** 真实 Node 运行时：打包版用随安装包分发的 node.exe，开发环境用 PATH 上的 node */
function nodeRuntimePath(): string | undefined {
  if (app.isPackaged) {
    const bundled = join(process.resourcesPath, "node-runtime", "node.exe");
    return existsSync(bundled) ? bundled : undefined;
  }
  return process.env.LONGHUB_NODE_PATH ?? "node";
}

function openclawEntryPath(): string | undefined {
  const candidates = [
    join(app.getAppPath(), "node_modules", "openclaw", "openclaw.mjs"),
    join(dirname, "..", "node_modules", "openclaw", "openclaw.mjs"),
  ];
  return candidates.find((p) => existsSync(p));
}

function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = connect({ host: "127.0.0.1", port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 500);
      });
    };
    attempt();
  });
}

let gateway: GatewaySupervisor | undefined;

/** 拉起内嵌 Gateway；缺运行时/入口时降级回 Mock（不设 OPENCLAW_GATEWAY_URL） */
async function startEmbeddedGateway(): Promise<string | undefined> {
  if (process.env.OPENCLAW_GATEWAY_URL) return process.env.OPENCLAW_GATEWAY_URL;
  const nodeExecutable = nodeRuntimePath();
  const entryScript = openclawEntryPath();
  if (!nodeExecutable || !entryScript) {
    console.warn("[gateway] 未找到 Node 运行时或 openclaw 入口，聊天将使用 Mock 底座");
    return undefined;
  }
  if (await waitForPort(GATEWAY_PORT, 1)) return GATEWAY_URL; // 已有 Gateway 在跑，直接复用
  gateway = new GatewaySupervisor({
    nodeExecutable,
    entryScript,
    args: ["gateway", "--port", String(GATEWAY_PORT), "--allow-unconfigured"],
    onStateChange: (state) => console.log("[gateway]", JSON.stringify(state)),
  });
  gateway.start();
  const ready = await waitForPort(GATEWAY_PORT, 30_000);
  if (!ready) {
    console.warn("[gateway] 启动超时，聊天将使用 Mock 底座");
    await gateway.stop();
    gateway = undefined;
    return undefined;
  }
  return GATEWAY_URL;
}

let core: CoreClient | undefined;
let desktopApp: DesktopApp | undefined;
let mainWindow: BrowserWindow | undefined;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "龙枢工作台",
    webPreferences: {
      preload: join(dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void mainWindow.loadFile(join(dirname, "renderer", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
}

app.whenReady().then(async () => {
  const gatewayUrl = await startEmbeddedGateway();
  core = new CoreClient({
    corePath: join(dirname, "core-process.js"),
    nodeExecutable: process.execPath,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      ...(gatewayUrl ? { OPENCLAW_GATEWAY_URL: gatewayUrl } : {}),
    },
  });
  const installer = new PackInstaller(join(app.getPath("userData"), "packs"));
  desktopApp = new DesktopApp(core, installer, {
    trustedKeys: loadTrustedKeys(),
    desktopVersion: DESKTOP_VERSION,
  });
  desktopApp.start();
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
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });
  ipcMain.handle("task:submit", (_e, params: SubmitTaskParams) =>
    desktopApp!.submitTask(params),
  );
  ipcMain.handle("task:get", (_e, taskId: string) => desktopApp!.getTask(taskId));
  ipcMain.handle("task:cancel", (_e, taskId: string) => desktopApp!.cancelTask(taskId));
  ipcMain.handle("packs:list", () => desktopApp!.listPacks());
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
          message: err instanceof Error ? err.message : String(err),
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

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("will-quit", () => {
  desktopApp?.stop();
  void gateway?.stop();
});
