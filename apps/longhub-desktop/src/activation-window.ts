import { pathToFileURL } from "node:url";
import { BrowserWindow, ipcMain } from "electron";
import { normalizeActivationInput } from "./activation-code-input.js";

const ACTIVATION_CHANNEL = "longhub:activation:submit";

export interface ActivationWindowOptions {
  htmlPath: string;
  preloadPath: string;
  deviceId: string;
  activate(code: string): Promise<void>;
}

/** 独立的最小权限激活窗口；关闭或成功后 preload 随窗口销毁，不进入 OpenClaw WebUI。 */
export function showActivationWindow(options: ActivationWindowOptions): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const expectedPage = pathToFileURL(options.htmlPath);
    expectedPage.searchParams.set("device", options.deviceId);
    const expectedUrl = expectedPage.toString();
    const activationWindow = new BrowserWindow({
      width: 520,
      height: 620,
      minWidth: 460,
      minHeight: 560,
      title: "激活龙枢",
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: options.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    let completed = false;
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      ipcMain.removeHandler(ACTIVATION_CHANNEL);
      resolve(value);
    };

    ipcMain.removeHandler(ACTIVATION_CHANNEL);
    ipcMain.handle(ACTIVATION_CHANNEL, async (event, rawCode: unknown) => {
      if (event.sender.id !== activationWindow.webContents.id || event.senderFrame?.url !== expectedUrl) {
        return { ok: false, message: "激活请求来源无效" };
      }
      const code = normalizeActivationInput(rawCode);
      if (!code) return { ok: false, message: "请输入正确格式的授权码" };
      try {
        await options.activate(code);
        completed = true;
        queueMicrotask(() => activationWindow.close());
        return { ok: true };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "激活失败，请稍后重试" };
      }
    });
    activationWindow.webContents.on("will-navigate", (event, target) => {
      if (target !== expectedUrl) event.preventDefault();
    });
    activationWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    activationWindow.once("ready-to-show", () => activationWindow.show());
    activationWindow.once("closed", () => finish(completed));
    void activationWindow.loadFile(options.htmlPath, { query: { device: options.deviceId } }).catch((error) => {
      ipcMain.removeHandler(ACTIVATION_CHANNEL);
      if (!activationWindow.isDestroyed()) activationWindow.destroy();
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}
