import { contextBridge, ipcRenderer } from "electron";
import type { DialogResult } from "../shared/types.js";

/**
 * The only bridge between the UI and the machine. Runs in the sandboxed
 * preload: no node modules, no fs — just whitelisted IPC to the main process.
 */
const api = {
  platform: process.platform,

  /** subscribe to a control-plane event ("approval:added", "log:line", ...) */
  on(event: string, cb: (data: unknown) => void): () => void {
    const channel = `ctl:event:${event}`;
    const handler = (_e: unknown, data: unknown) => cb(data);
    ipcRenderer.on(channel, handler);
    return () => { ipcRenderer.removeListener(channel, handler); };
  },

  /** one control-plane method ("devices/list", "tool/call", "policy/set_mode", ...) */
  call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return ipcRenderer.invoke("ctl:call", method, params);
  },

  app: {
    /** agent lifecycle/state pushed by the main process */
    onAgentState: (cb: (s: unknown) => void): (() => void) => {
      const channel = "agent:state";
      const handler = (_e: unknown, s: unknown) => cb(s);
      ipcRenderer.on(channel, handler);
      return () => { ipcRenderer.removeListener(channel, handler); };
    },
  },

  agent: {
    status: () => ipcRenderer.invoke("agent:status"),
    restart: () => ipcRenderer.invoke("agent:restart"),
    openPath: (p: string) => ipcRenderer.invoke("agent:openPath", p) as Promise<string>,
    chooseApk: () => ipcRenderer.invoke("agent:chooseApk") as Promise<DialogResult>,
    chooseLocalFile: (title?: string) => ipcRenderer.invoke("agent:chooseLocalFile", title) as Promise<DialogResult>,
  },
};

contextBridge.exposeInMainWorld("adbstudio", api);
