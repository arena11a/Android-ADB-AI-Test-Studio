import { create } from "zustand";
import { getTranslateLang, translate } from "./i18n";
import type {
  ApprovalRequest, AuditRow, ControlSnapshot, DeviceInfo, LogLine, MetricSample,
  Mode, PolicyFile, Risk, Session, ToolResult,
} from "@shared/types.js";

export interface MediaState { scrcpy: { running: boolean; serial?: string; seconds?: number }; record: { running: boolean; seconds?: number } }
export interface DbState { available: boolean; schemaVersion: number; stats: Record<string, number> }
export interface Folders { screenshots: string; recordings: string; data: string; audit: string; sessions: string }

export type Page = "dashboard" | "apps" | "files" | "logs" | "metrics" | "sessions" | "settings" | "live" | "record" | "history" | "security" | "bootloader";

const MAX_LOGS = 2000;        // ring buffer kept in memory
const LOG_FLUSH_MS = 200;     // render at most ~5 batches/second
const LOG_FLUSH_MAX = 400;    // and at most this many new rows per batch
const MAX_METRICS = 600;
const MAX_AUDIT = 400;

interface StudioState {
  page: Page;
  status: { running: boolean; controlConnected: boolean; restarts: number; error?: string; adbPath?: string };
  hello: ControlSnapshot | null;
  policy: PolicyFile | null;
  devices: DeviceInfo[];
  selected: string | null;
  approvals: ApprovalRequest[];
  logs: LogLine[];
  logPaused: boolean;
  logFilter: { level: string; tag: string; contains: string };
  logsSubscribed: boolean;
  metrics: MetricSample[];
  metricsSubscribed: boolean;
  session: Session | null;
  history: Session[];
  audit: AuditRow[];
  scan: { loading: boolean; report: unknown; error: string | null };
  media: MediaState;
  /** last scrcpy start failure, rendered inline on the Live page (localized there) */
  scrcpyError: { code?: string; message: string } | null;
  /** AI clients currently attached to the MCP socket */
  aiClients: number;
  folders: Folders | null;
  db: DbState;
  theme: "system" | "light" | "dark";
  busy: string | null;
  lastShot: string | null;
  wordPrompt: { mode: Mode; word: string; value: string; error: string | null } | null;
  toast: { text: string; kind: "info" | "warn" | "error" } | null;

  init: () => () => void;
  setPage: (p: Page) => void;
  call: (method: string, params?: Record<string, unknown>) => Promise<any>;
  runTool: (tool: string, params?: Record<string, unknown>) => Promise<ToolResult>;
  refresh: () => Promise<void>;
  selectDevice: (serial: string | null) => void;
  setMode: (mode: Mode) => Promise<void>;
  confirmMode: (word: string) => Promise<void>;
  cancelModePrompt: () => void;
  applyPreset: (preset: "read" | "test" | "repair" | "bootloader") => Promise<void>;
  setRole: (role: "viewer" | "tester" | "admin") => Promise<void>;
  setFeatures: (features: Record<string, boolean>) => Promise<void>;
  setTargets: (targets: string[]) => Promise<void>;
  safeMode: () => Promise<void>;
  killSwitch: (trigger: boolean) => Promise<void>;
  decide: (id: string, action: "approve" | "deny", typed?: string) => Promise<void>;
  subscribeLogs: (level?: string) => Promise<void>;
  unsubscribeLogs: () => Promise<void>;
  subscribeMetrics: (intervalMs?: number) => Promise<void>;
  unsubscribeMetrics: () => Promise<void>;
  startSession: (name: string, pkg: string, goal?: string) => Promise<void>;
  stopSession: (reason?: string) => Promise<void>;
  createReport: (format: "html" | "md" | "json") => Promise<void>;
  refreshAudit: () => Promise<void>;
  setTheme: (theme: "system" | "light" | "dark") => void;
  scrcpyStart: (opts?: Record<string, unknown>) => Promise<void>;
  scrcpyStop: () => Promise<void>;
  refreshMedia: () => Promise<void>;
  recordStart: (seconds?: number) => Promise<void>;
  recordStop: () => Promise<void>;
  refreshDb: () => Promise<void>;
  refreshFolders: () => Promise<void>;
  runScan: () => Promise<void>;
  saveScreenshot: () => Promise<void>;
  notify: (text: string, kind?: "info" | "warn" | "error") => void;
}

const errText = (e: unknown) => (e instanceof Error ? (e as Error & { code?: string }).code ? `${(e as Error & { code?: string }).code}: ${e.message}` : e.message : String(e));

export const useStudio = create<StudioState>()((set, get) => ({
  page: "dashboard",
  status: { running: false, controlConnected: false, restarts: 0 },
  hello: null,
  policy: null,
  devices: [],
  selected: null,
  approvals: [],
  logs: [],
  logPaused: false,
  logFilter: { level: "V", tag: "", contains: "" },
  logsSubscribed: false,
  metrics: [],
  metricsSubscribed: false,
  session: null,
  history: [],
  audit: [],
  scan: { loading: false, report: null, error: null },
  media: { scrcpy: { running: false }, record: { running: false } },
  scrcpyError: null,
  aiClients: 0,
  folders: null,
  db: { available: false, schemaVersion: 0, stats: {} },
  theme: ((localStorage.getItem("adbstudio.theme") as "system" | "light" | "dark") ?? "system"),
  busy: null,
  lastShot: null,
  wordPrompt: null,
  toast: null,

  async call(method, params = {}) {
    if (!window.adbstudio) throw new Error("bridge not available");
    return window.adbstudio.call(method, params);
  },

  async runTool(tool, params = {}) {
    const withDevice = (d: string | null) => (d ? { device: d, ...params } : params);
    const r = (await get().call("tool/call", { tool, params: withDevice(get().selected) })) as ToolResult;
    if (!r.ok) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r;
  },

  notify(text, kind = "info") { set({ toast: { text, kind } }); setTimeout(() => set({ toast: null }), 5000); },

  init() {
    const offs: Array<() => void> = [];
    const on = (event: string, cb: (data: unknown) => void) => offs.push(window.adbstudio.on(event, cb));
    const api = window.adbstudio;

    // agent lifecycle (connected, restarted, crashed) comes from the main process
    offs.push(api.app.onAgentState((s) => {
      const prev = get().status.controlConnected;
      set({ status: s as StudioState["status"] });
      if (s.controlConnected && !prev) void get().refresh();     // agent came up → load state
      if (!s.controlConnected && prev) get().notify(translate("toast.agent_dropped"), "warn");
    }));

    on("policy:update", (p: unknown) => { set({ policy: p as unknown as PolicyFile }); void get().call("hello").then((h: ControlSnapshot) => set({ hello: h, aiClients: h.aiClients ?? 0 })); });
    on("devices", (d: unknown) => set({ devices: (d as unknown as DeviceInfo[]) }));
    on("approval:added", (r: unknown) => set({ approvals: [...get().approvals, r as unknown as ApprovalRequest] }));
    on("approval:settled", (r: unknown) => {
      const id = (r as unknown as { id: string }).id;
      set({ approvals: get().approvals.filter((a) => a.id !== id) });
      if (get().session) void get().call("session/current").then((s: { session: Session | null }) => set({ session: s.session }));
    });
    on("killswitch", (d: unknown) => {
      const active = (d as unknown as { active: boolean }).active;
      get().notify(translate(active ? "toast.kill_on" : "toast.kill_off"), active ? "error" : "info");
      void get().refresh();
    });
    // Batched: logcat can emit thousands of lines per second and React must
    // not re-render per line (that is what makes "stop" unclickable).
    const inbox: LogLine[] = [];
    let flush: ReturnType<typeof setInterval> | undefined;
    on("log:line", (l: unknown) => {
      inbox.push(l as unknown as LogLine);
      if (inbox.length > 5000) inbox.splice(0, inbox.length - 5000);   // never grow unbounded
      if (flush) return;
      flush = setInterval(() => {
        const take = inbox.splice(0, LOG_FLUSH_MAX);
        if (take.length && !get().logPaused) set({ logs: [...get().logs, ...take].slice(-MAX_LOGS) });
      }, LOG_FLUSH_MS);
    });
    offs.push(() => { if (flush) clearInterval(flush); });
    on("metrics:sample", (m: unknown) => set({ metrics: [...get().metrics, m as unknown as MetricSample].slice(-MAX_METRICS) }));
    on("session:update", (s: unknown) => set({ session: (s as unknown as Session | null) }));
    on("audit:entry", (e: unknown) => set({ audit: [e as unknown as AuditRow, ...get().audit].slice(0, MAX_AUDIT) }));
    on("anomaly", (d: unknown) => get().notify(translate("toast.anomaly", { msg: (d as unknown as { message: string }).message }), "warn"));
    on("metrics:error", (d: unknown) => get().notify(translate("toast.metrics_error", { msg: (d as unknown as { message: string }).message }), "warn"));
    on("bye", () => get().notify(translate("toast.agent_closed"), "warn"));
    on("media:update", (d: unknown) => set({ media: d as MediaState }));
    on("mcp:clients", (d: unknown) => set({ aiClients: (d as { count: number }).count }));

    void (async () => {
      try {
        const st = await api.agent.status();
        set({ status: st as StudioState["status"] });
        if (st.controlConnected) await get().refresh();
      } catch (e) { get().notify(errText(e), "error"); }
    })();

    return () => offs.forEach((f) => f());
  },

  async refresh() {
    try {
      const [hello, devices, approvals, policy, session] = await Promise.all([
        get().call("hello"),
        get().call("devices/list"),
        get().call("approvals/list"),
        get().call("policy/get"),
        get().call("session/current"),
      ]);
      set({
        hello: hello as ControlSnapshot,
        aiClients: (hello as ControlSnapshot).aiClients ?? 0,
        devices: (devices as { devices: DeviceInfo[] }).devices,
        approvals: (approvals as { approvals: ApprovalRequest[] }).approvals,
        policy: (policy as { policy: PolicyFile }).policy,
        session: (session as { session: Session | null }).session,
        selected: get().selected ?? (devices as { devices: DeviceInfo[] }).devices.find((d) => d.state === "online")?.serial ?? null,
      });
    } catch (e) { get().notify(errText(e), "error"); }
  },

  selectDevice(serial) { set({ selected: serial }); },
  setPage(p) { set({ page: p }); },

  async setMode(mode) {
    try { await get().call("policy/set_mode", { mode }); await get().refresh(); }
    catch (e) {
      if ((e as { code?: string }).code === "APPROVAL_REQUIRED") {
        // ask for the confirmation word inside the app (never a browser prompt)
        const { word } = (await get().call("policy/mode_word", { mode })) as { word: string };
        set({ wordPrompt: { mode: mode as Mode, word, value: "", error: null } });
        return;
      }
      get().notify(errText(e), "error");
    }
  },
  /** called by the typed-word dialog */
  async confirmMode(word: string) {
    const prompt = get().wordPrompt;
    if (!prompt) return;
    if (word.trim() !== prompt.word) { set({ wordPrompt: { ...prompt, error: translate("toast.mode_word_bad") } }); return; }
    try {
      await get().call("policy/set_mode", { mode: prompt.mode, typed: word.trim() });
      set({ wordPrompt: null });
      await get().refresh();
      get().notify(translate("toast.mode_entered", { mode: prompt.mode }));
    } catch (e) { set({ wordPrompt: { ...prompt, error: errText(e) } }); }
  },
  cancelModePrompt() { set({ wordPrompt: null }); },

  /** one-click presets so a human never has to hunt through 9 toggles */
  async applyPreset(preset: "read" | "test" | "repair" | "bootloader") {
    const presets = {
      read: { mode: "observe", features: {} },
      test: { mode: "develop", features: { input: true, install: true, files: true } },
      repair: { mode: "repair", features: {} },
      bootloader: { mode: "bootloader", features: {} },
    } as const;
    const p = presets[preset];
    for (const [k, v] of Object.entries(p.features)) await get().call("policy/set_features", { features: { [k]: v } }).catch(() => undefined);
    await get().setMode(p.mode);           // repair/bootloader ask for the word here
    get().notify(translate("preset.applied", { preset: translate(`preset.${preset}`) }));
  },
  /** Read-only security/hygiene scan of the connected device. */
  async runScan() {
    set({ scan: { loading: true, report: null, error: null } });
    try {
      const r = (await get().runTool("security_scan")) as unknown as { data: unknown };
      set({ scan: { loading: false, report: r.data, error: null } });
    } catch (e) { set({ scan: { loading: false, report: null, error: errText(e) } }); }
  },
  async setRole(role) { await get().call("policy/set_role", { role }); await get().refresh(); },
  async setFeatures(features) { await get().call("policy/set_features", { features }); await get().refresh(); },
  async setTargets(targets) { await get().call("policy/set_targets", { targets }); await get().refresh(); },
  async safeMode() { await get().call("policy/safe_mode"); get().notify(translate("toast.safe_mode")); await get().refresh(); },

  async killSwitch(trigger) {
    if (trigger) {
      await get().call("killswitch/trigger", { source: "ui" });
      get().notify(translate("toast.kill_pressed"), "error");
    } else await get().call("killswitch/release");
    await get().refresh();
  },

  async decide(id, action, typed) {
    await get().call("approval/decide", { id, action, typed });
    set({ approvals: get().approvals.filter((a) => a.id !== id) });
  },

  async subscribeLogs(level) {
    try { await get().call("logs/subscribe", { level: level ?? get().logFilter.level, device: get().selected ?? undefined }); set({ logsSubscribed: true, logs: [] }); }
    catch (e) { get().notify(errText(e), "error"); }
  },
  async unsubscribeLogs() { try { await get().call("logs/unsubscribe"); } catch { /* ignore */ } set({ logsSubscribed: false }); },
  async subscribeMetrics(intervalMs = 2000) {
    try { await get().call("metrics/subscribe", { interval_ms: intervalMs }); set({ metricsSubscribed: true, metrics: [] }); }
    catch (e) { get().notify(errText(e), "error"); }
  },
  async unsubscribeMetrics() { try { await get().call("metrics/unsubscribe"); } catch { /* ignore */ } set({ metricsSubscribed: false }); },

  async startSession(name, pkg, goal) {
    await get().runTool("session_start", { name, package: pkg, goal });
    get().notify(translate("toast.session_started", { name }));
  },
  async stopSession(reason) { await get().call("session/stop", { reason: reason ?? "user" }); },
  async createReport(format) {
    const s = get().session;
    if (!s) return get().notify(translate("toast.no_session"), "warn");
    const r = (await get().runTool("report_create", { session_id: s.id, format, lang: getTranslateLang() })) as unknown as { data: { path: string } };
    get().notify(translate("toast.report_saved_path", { fmt: format.toUpperCase(), path: r.data.path }));
  },

  setTheme(theme: "system" | "light" | "dark") {
    localStorage.setItem("adbstudio.theme", theme);
    set({ theme });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    document.documentElement.classList.toggle("dark", theme === "dark" || (theme === "system" && mq.matches));
  },

  /* ---------- scrcpy / recording ---------- */
  /** Pull the real mirror/record state (used on page mount and after start/stop). */
  async refreshMedia() {
    try {
      const [sc, rec] = await Promise.all([get().call("scrcpy/status"), get().call("record/status")]) as [
        MediaState["scrcpy"], MediaState["record"],
      ];
      set({ media: { scrcpy: sc, record: rec } });
    } catch { /* keep the last known state */ }
  },
  async scrcpyStart(opts: Record<string, unknown> = {}) {
    set({ scrcpyError: null });
    try {
      await get().call("scrcpy/start", { device: get().selected ?? undefined, ...opts });
      await get().refreshMedia();
      get().notify(translate("toast.scrcpy_open"));
    } catch (e) {
      // keep the failure for the Live page (localized hint + retry), not only a toast
      set({ scrcpyError: { code: (e as { code?: string }).code, message: errText(e) } });
      get().notify(errText(e), "error");
      void get().refreshMedia();
    }
  },
  async scrcpyStop() {
    try { await get().call("scrcpy/stop"); set({ scrcpyError: null }); await get().refreshMedia(); }
    catch (e) { get().notify(errText(e), "error"); }
  },
  async recordStart(seconds = 180) {
    try { const r = (await get().call("record/start", { device: get().selected ?? undefined, seconds })) as { remotePath: string; seconds: number };
      get().notify(translate("toast.rec_start", { s: r.seconds })); set({ busy: "record" });
    } catch (e) { get().notify(errText(e), "error"); }
  },
  async recordStop() {
    try { const r = (await get().call("record/stop")) as { localPath: string; size: number; seconds: number };
      get().notify(translate("toast.rec_saved", { mb: (r.size / 1048576).toFixed(1), s: r.seconds }));
      set({ busy: null });
      const err = await window.adbstudio.agent.openPath(r.localPath);
      if (err) get().notify(translate("toast.open_failed", { path: r.localPath }), "warn");
    } catch (e) { get().notify(errText(e), "error"); set({ busy: null }); }
  },

  /* ---------- db history ---------- */
  async refreshDb() {
    try { set({ db: (await get().call("db/stats")) as DbState }); } catch { /* keep the last value */ }
  },
  async refreshFolders() {
    try { set({ folders: (await get().call("media/folders")).folders as Folders }); } catch { /* ignore */ }
  },
  /** Captures the device screen and writes the PNG into the screenshots folder. */
  async saveScreenshot() {
    try {
      set({ busy: "screenshot" });
      const r = (await get().call("media/save_screenshot", { device: get().selected ?? undefined })) as { path: string; bytes: number; folder: string };
      get().notify(translate("toast.shot_saved", { kb: (r.bytes / 1024).toFixed(0), folder: r.folder }));
      set({ busy: null, lastShot: r.path });
      const err = await window.adbstudio.agent.openPath(r.path);
      if (err) get().notify(translate("toast.open_failed", { path: r.path }), "warn");
    } catch (e) { get().notify(errText(e), "error"); set({ busy: null }); }
  },

  async refreshAudit() {
    try { const r = (await get().call("audit/tail", { limit: 100 })) as { entries: AuditRow[] }; set({ audit: r.entries }); }
    catch (e) { get().notify(errText(e), "error"); }
  },
}));

export const errMsg = errText;
