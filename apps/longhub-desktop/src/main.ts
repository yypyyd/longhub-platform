/**
 * Electron Main：创建窗口（Context Isolation + 禁用 Node Integration），
 * 拉起 Core 进程，向 Renderer 暴露白名单 IPC。
 */
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { CoreClient } from "./core-client.js";
import { DesktopApp, type SubmitTaskParams } from "./desktop-app.js";
import { CloudPackClient } from "./pack-distribution.js";
import { PackInstaller } from "./pack-installer.js";

const DESKTOP_VERSION = "1.0.0";
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
async function deviceTokenFor(baseUrl: string): Promise<string> {
  const state = loadDeviceState();
  const cached = state.tokensByBaseUrl[baseUrl];
  if (cached) return cached;
  const client = new CloudPackClient(baseUrl);
  const credentials = await client.registerDevice({
    appVersion: DESKTOP_VERSION,
    deviceFingerprint: state.fingerprint,
  });
  state.tokensByBaseUrl[baseUrl] = credentials.deviceToken;
  saveDeviceState(state);
  return credentials.deviceToken;
}

const core = new CoreClient({
  corePath: join(dirname, "core-process.js"),
  nodeExecutable: process.execPath,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
});

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

app.whenReady().then(() => {
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
});
