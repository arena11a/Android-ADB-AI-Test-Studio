import { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } from "electron";
import path from "node:path";
import fs from "node:fs";
import { AgentProcess, type Endpoints } from "./agent.js";
import { ControlClient } from "./control.js";
import type { ControlEvent } from "../shared/types.js";

/** One window, one agent, zero shortcuts past the control plane. */
let win: BrowserWindow | null = null;
const agent = new AgentProcess(
  (line) => { if (win) win.webContents.send("agent:log", line); },
  () => { send("agent:state", agent.status()); void reconnect(); },
);
const control = new ControlClient(
  (e: ControlEvent) => { if (win) win.webContents.send(`ctl:event:${e.event}`, e.data); },
  () => send("agent:state", { ...agent.status(), controlConnected: control.connected }),
);

const send = (channel: string, payload: unknown) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };

async function reconnect(): Promise<void> {
  try {
    const ep: Endpoints = await agent.start();
    await control.connect(ep.control.url, ep.control.token);
    send("agent:state", { ...agent.status(), controlConnected: true, adbPath: ep.adbPath });
  } catch (e) {
    send("agent:state", { ...agent.status(), controlConnected: false, error: e instanceof Error ? e.message : String(e) });
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1080, minHeight: 700,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#09090b" : "#fafafa",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,       // the renderer gets nothing but the bridge API
      nodeIntegration: false,
      sandbox: true,                // preload is CSP'd: no node, no fs, no ws
      spellcheck: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  win.once("ready-to-show", () => win?.show());
  win.on("closed", () => { win = null; });

  // every link/open attempt stays inside the rules: files via the OS, URLs via the browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());

  // smoke-test helpers: ADBSTUDIO_PAGE=logs opens on a page, ADBSTUDIO_SKIP_FIRST_RUN=1
  // hides the one-time warning dialog
  const page = process.env.ADBSTUDIO_PAGE;
  const hash = [page ? `page=${page}` : "", process.env.ADBSTUDIO_SKIP_FIRST_RUN === "1" ? "firstrun=0" : "",
                process.env.ADBSTUDIO_LANG ? `lang=${process.env.ADBSTUDIO_LANG}` : ""]
    .filter(Boolean).join("&");

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (!app.isPackaged && devUrl) {
    void win.loadURL(devUrl + (hash ? `#${hash}` : ""));
  } else {
    void win.loadFile(path.join(__dirname, "../../dist-renderer/index.html"), hash ? { hash } : undefined);
  }

  // optional: capture the window to a PNG for smoke tests (ADBSTUDIO_CAPTURE=/tmp/a.png)
  const capture = process.env.ADBSTUDIO_CAPTURE;
  if (capture) {
    win.webContents.once("did-finish-load", () => setTimeout(async () => {
      try {
        const img = await win!.webContents.capturePage();
        fs.writeFileSync(capture, img.toPNG());
      } catch { /* best effort */ }
      setTimeout(() => app.quit(), 500).unref();
    }, 3000));   // give the agent time to report ready before capturing
  }
}

function registerIpc(): void {
  ipcMain.handle("ctl:call", (_e, method: string, params: Record<string, unknown> = {}) => control.call(method, params));
  ipcMain.handle("agent:status", () => ({ ...agent.status(), runtime: agent.runtime, controlConnected: control.connected }));
  ipcMain.handle("agent:restart", async () => { await agent.restart(); await reconnect(); return { ...agent.status(), runtime: agent.runtime, controlConnected: control.connected }; });

  // files are opened by the OS, so the renderer never touches fs
  ipcMain.handle("agent:openPath", (_e, p: string) => shell.openPath(p));
  ipcMain.handle("agent:chooseApk", async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: "เลือก APK สำหรับติดตั้ง",
      properties: ["openFile"],
      filters: [{ name: "Android Package", extensions: ["apk"] }],
    });
    return r.canceled || !r.filePaths[0] ? { canceled: true } : { canceled: false, path: r.filePaths[0] };
  });
  ipcMain.handle("agent:chooseLocalFile", async (_e, title = "เลือกไฟล์") => {
    const r = await dialog.showOpenDialog(win!, { title, properties: ["openFile"] });
    return r.canceled || !r.filePaths[0] ? { canceled: true } : { canceled: false, path: r.filePaths[0] };
  });
}

// single instance: two apps would fight over the same agent + endpoint file
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    registerIpc();
    createWindow();
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
    void reconnect();
    nativeTheme.on("updated", () => send("theme:changed", { dark: nativeTheme.shouldUseDarkColors }));
  });

  // closing the window must take the agent (and its adb children) with it
  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => { control.disconnect(); agent.stop(); });
  process.on("uncaughtException", (e) => send("agent:state", { error: String(e) }));
}
