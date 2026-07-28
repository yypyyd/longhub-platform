/**
 * Preload：通过 contextBridge 向 Renderer 暴露白名单 API（window.longhub）。
 * Renderer 不能直接访问 Node 或 Electron 能力。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

contextBridge.exposeInMainWorld("longhub", {
  hello: () => ipcRenderer.invoke("core:hello"),
  deviceInfo: () => ipcRenderer.invoke("device:info"),
  submitTask: (params: unknown) => ipcRenderer.invoke("task:submit", params),
  getTask: (taskId: string) => ipcRenderer.invoke("task:get", taskId),
  cancelTask: (taskId: string) => ipcRenderer.invoke("task:cancel", taskId),
  listPacks: () => ipcRenderer.invoke("packs:list"),
  installPack: () => ipcRenderer.invoke("packs:install"),
  rollbackPack: (packId: string) => ipcRenderer.invoke("packs:rollback", packId),
  installPackFromCloud: (params: unknown) => ipcRenderer.invoke("packs:installFromCloud", params),
  onTaskEvent: (callback: (event: unknown) => void) => {
    const listener = (_e: IpcRendererEvent, event: unknown) => callback(event);
    ipcRenderer.on("task:event", listener);
    return () => ipcRenderer.removeListener("task:event", listener);
  },
});
