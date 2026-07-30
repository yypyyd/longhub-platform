import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("longhubActivation", {
  submit(code: string): Promise<{ ok: boolean; message?: string }> {
    return ipcRenderer.invoke("longhub:activation:submit", code) as Promise<{ ok: boolean; message?: string }>;
  },
});
