import { EventEmitter } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expandHome, num, str } from "./config.js";
import { StudioError, type Mode, type PolicyFile, type Role } from "./types.js";
import { PKG_RE } from "./tools.js";
import type { StoredEntry } from "./audit.js";
import type { Studio } from "./wire.js";
import type { ApprovalRequest } from "./approval.js";
import type { DeviceInfo } from "./services/devices.js";
import type { LogLine } from "./services/logcat.js";
import type { MetricSample } from "./services/metrics.js";
import type { Session } from "./services/session.js";
import { MAX_RECORD_SECONDS } from "./services/screen.js";

const MODES: Mode[] = ["safe", "observe", "develop", "automation", "approve_all", "plan_only", "repair", "bootloader"];
const ROLES: Role[] = ["viewer", "tester", "admin"];
const INTERVALS = [1000, 2000, 5000];
const VERSION = "0.1.0";

export type ControlEvent =
  | { event: "hello"; data: ControlSnapshot }
  | { event: "agent:ready"; data: { agent_url: string; control_url: string } }
  | { event: "approval:added"; data: ApprovalRequest }
  | { event: "approval:settled"; data: { id: string; tool: string; outcome: string } }
  | { event: "killswitch"; data: { active: boolean } }
  | { event: "log:line"; data: LogLine }
  | { event: "metrics:sample"; data: MetricSample }
  | { event: "metrics:error"; data: { message: string } }
  | { event: "session:update"; data: Session | null }
  | { event: "policy:update"; data: PolicyFile }
  | { event: "audit:entry"; data: { seq: number; ts: string; actor: string; tool: string; risk: string; decision: string; ok: boolean; error_code?: string; device?: string; session_id?: string } }
  | { event: "devices"; data: DeviceInfo[] }
  | { event: "anomaly"; data: { message: string } }
  | { event: "media:update"; data: { scrcpy: ReturnType<ControlServer["studio"] extends never ? never : Studio["scrcpy"]["status"]>; record: { running: boolean; seconds?: number } } }
  | { event: "bye"; data: { reason: string } };

export interface ControlSnapshot {
  version: string;
  adbPath: string;
  mode: Mode;
  role: Role;
  targets: string[];
  features: PolicyFile["features"];
  killSwitch: boolean;
  pendingApprovals: number;
  session: Session | null;
}

export interface ControlEndpoints { url: string; token: string; port: number }

interface Client {
  ws: WebSocket;
  logs?: { level?: string; tag?: string; contains?: string };
  metrics: boolean;
}

/**
 * Control plane for the desktop UI (and only the UI):
 *  - loopback + per-launch bearer token + no browser Origin, same rules as the MCP server
 *  - request/response JSON-RPC-ish `{id, method, params}` and server-pushed `{event, data}`
 *  - every tool call made here goes through the SAME router → policy → approval → audit path,
 *    with actor "user" (a human is behind it)
 */
export class ControlServer extends EventEmitter {
  private wss?: WebSocketServer;
  private token = randomBytes(32).toString("hex");
  private clients = new Set<Client>();
  private poll?: NodeJS.Timeout;
  private lastDevices = "";
  private logSerial?: string;
  private metricsSerial?: string;

  constructor(private studio: Studio, private opts: { port?: number; endpointFile?: string; pollDevicesMs?: number; adbPath?: string } = {}) {
    super();
    this.wire();
  }

  /** Forwards studio events to subscribed UI clients. */
  private wire(): void {
    const s = this.studio;
    s.approvals.on("added", (r: ApprovalRequest) => this.broadcast({ event: "approval:added", data: r }));
    s.approvals.on("settled", (r: ApprovalRequest, outcome: string) =>
      this.broadcast({ event: "approval:settled", data: { id: r.id, tool: r.tool, outcome } }));
    s.kill.on("triggered", () => this.broadcast({ event: "killswitch", data: { active: true } }));
    s.kill.on("released", () => this.broadcast({ event: "killswitch", data: { active: false } }));
    s.logs.on("line", (l: LogLine) => {
      for (const c of this.clients) if (this.wantsLog(c, l)) this.send(c, { event: "log:line", data: l });
    });
    s.metrics.on("sample", (m: MetricSample) => {
      for (const c of this.clients) if (c.metrics) this.send(c, { event: "metrics:sample", data: m });
    });
    s.metrics.on("error", (e: unknown) => this.broadcast({ event: "metrics:error", data: { message: e instanceof Error ? e.message : String(e) } }));
    s.sessions.on("started", () => this.broadcast({ event: "session:update", data: s.sessions.active ?? null }));
    s.sessions.on("stopped", () => this.broadcast({ event: "session:update", data: s.sessions.active ?? null }));
    s.audit.on("entry", (e: StoredEntry) => this.broadcast({ event: "audit:entry", data: e }));
  }

  start(): Promise<ControlEndpoints> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        host: "127.0.0.1", port: this.opts.port ?? 0,
        verifyClient: ({ origin, req }, done) => {
          if (origin) return done(false, 403, "browser origins not allowed");
          const got = Buffer.from(String(req.headers["authorization"] ?? "").replace(/^Bearer /, ""));
          const want = Buffer.from(this.token);
          if (got.length !== want.length || !timingSafeEqual(got, want)) return done(false, 401, "bad token");
          done(true);
        },
      });
      wss.once("error", reject);
      wss.on("listening", () => {
        this.wss = wss;
        const addr = wss.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        if (this.opts.endpointFile) {
          mkdirSync(path.dirname(this.opts.endpointFile), { recursive: true, mode: 0o700 });
          writeFileSync(this.opts.endpointFile, JSON.stringify({ url: `ws://127.0.0.1:${port}`, token: this.token }), { mode: 0o600 });
        }
        this.lastDevices = "";
        resolve({ url: `ws://127.0.0.1:${port}`, token: this.token, port });
      });
      wss.on("connection", (ws) => this.onConnection(ws));
    });
  }

  private onConnection(ws: WebSocket): void {
    const client: Client = { ws, metrics: false };
    this.clients.add(client);
    this.send(client, { event: "hello", data: this.snapshot() });
    this.ensurePolling();
    ws.on("message", (raw) => void this.onMessage(client, String(raw)));
    ws.on("close", () => this.onDisconnect(client));
    ws.on("error", () => this.onDisconnect(client));
  }

  private onDisconnect(client: Client): void {
    this.clients.delete(client);
    if (!this.clients.size) {
      this.studio.logs.stop(); this.logSerial = undefined;
      this.studio.metrics.pause(); this.metricsSerial = undefined;
      if (this.poll) { clearInterval(this.poll); this.poll = undefined; }
    }
  }

  private async onMessage(client: Client, raw: string): Promise<void> {
    let msg: { id?: string | number; method?: string; params?: Record<string, unknown> };
    try { msg = JSON.parse(raw); } catch { client.ws.close(1003); return; }
    const reply = (r: unknown) => this.send(client, { id: msg.id, result: r });
    const fail = (e: unknown) => this.send(client, {
      id: msg.id,
      error: { code: e instanceof StudioError ? e.code : "INTERNAL", message: e instanceof Error ? e.message : String(e) },
    });
    try {
      if (typeof msg.method !== "string") return fail(new StudioError("INVALID_PARAMS", "missing method"));
      reply(await this.dispatch(msg.method, msg.params ?? {}, client));
    } catch (e) { fail(e); }
  }

  snapshot(): ControlSnapshot {
    const p = this.studio.policy.policy;
    return {
      version: VERSION, adbPath: this.opts.adbPath ?? "adb",
      mode: p.mode, role: p.role, targets: p.targetPackages, features: p.features,
      killSwitch: this.studio.kill.active,
      pendingApprovals: this.studio.approvals.list().length,
      session: this.studio.sessions.active ?? null,
    };
  }

  /** One method table: everything the UI can ask the agent to do. */
  private async dispatch(method: string, p: Record<string, unknown>, client: Client): Promise<unknown> {
    const s = this.studio;
    const device = async () => s.devices.resolve(typeof p.device === "string" ? p.device : undefined);

    switch (method) {
      case "hello": return this.snapshot();
      case "devices/list": return { devices: await s.devices.list() };
      case "devices/info": return s.devices.info(await device());
      case "devices/connect": return { result: await s.devices.connect(str(p.host, "host"), num(p.port, "port", 1, 65535)) };
      case "devices/disconnect": await s.devices.disconnect(await device()); return { disconnected: true };
      case "devices/pair": return { result: await s.devices.pair(str(p.host, "host"), num(p.port, "port", 1, 65535), str(p.code, "code")) };
      case "devices/discover": return { services: await s.devices.discover() };

      case "approvals/list": return { approvals: s.approvals.list() };
      case "approval/decide": {
        const id = str(p.id, "id");
        const action = str(p.action, "action");
        const ok = action === "approve"
          ? s.approvals.approve(id, typeof p.typed === "string" ? p.typed : undefined)
          : action === "deny" ? s.approvals.deny(id) : s.approvals.cancel(id);
        if (!ok) throw new StudioError("INVALID_PARAMS", "No pending approval with that id (or wrong typed confirmation)");
        return { decided: action };
      }

      case "killswitch/status": return { active: s.kill.active };
      case "killswitch/trigger": s.kill.trigger(typeof p.source === "string" ? p.source : "ui"); return { active: true };
      case "killswitch/release": {
        s.kill.release();
        s.audit.write({ ts: new Date().toISOString(), actor: "user", client: "ui", tool: "killswitch_release", risk: "critical", decision: "allow", ok: true });
        return { active: false };
      }

      case "policy/get": return { policy: s.policy.policy };
      case "policy/set_mode": {
        const mode = str(p.mode, "mode") as Mode;
        if (!MODES.includes(mode)) throw new StudioError("INVALID_PARAMS", `mode must be one of ${MODES.join(", ")}`);
        // dangerous modes are entered only with the typed confirmation word — that
        // word is also what arms the matching feature, so it is a single deliberate act
        const word = s.policy.confirmWord(mode);
        if (word && p.typed !== word)
          throw new StudioError("APPROVAL_REQUIRED", `Type '${word}' to enter ${mode} mode`);
        if (mode === "repair") s.policy.policy.features.repair = true;
        if (mode === "bootloader") s.policy.policy.features.bootloader = true;
        s.policy.setMode(mode); this.policyChanged(); return { mode, confirm_required: !!word };
      }
      case "policy/mode_word": {
        const mode = str(p.mode, "mode") as Mode;
        return { word: s.policy.confirmWord(mode) };
      }
      case "policy/set_role": {
        const role = str(p.role, "role") as Role;
        if (!ROLES.includes(role)) throw new StudioError("INVALID_PARAMS", `role must be one of ${ROLES.join(", ")}`);
        s.policy.policy.role = role; this.policyChanged(); return { role };
      }
      case "policy/set_targets": {
        const list = p.targets;
        if (!Array.isArray(list) || list.some((t) => typeof t !== "string" || !PKG_RE.test(t)))
          throw new StudioError("INVALID_PARAMS", "targets must be an array of package names");
        s.policy.policy.targetPackages = list as string[]; this.policyChanged(); return { targets: list };
      }
      case "policy/set_features": {
        const f = p.features;
        if (!f || typeof f !== "object") throw new StudioError("INVALID_PARAMS", "features object required");
        for (const [k, v] of Object.entries(f)) {
          if (!(k in s.policy.policy.features)) throw new StudioError("INVALID_PARAMS", `unknown feature '${k}'`);
          if (typeof v !== "boolean") throw new StudioError("INVALID_PARAMS", `feature '${k}' must be boolean`);
          s.policy.policy.features[k as keyof PolicyFile["features"]] = v;
        }
        this.policyChanged(); return { features: s.policy.policy.features };
      }
      case "policy/set_local_apk_dirs": {
        // where APKs may come from — a human decision, so it is validated and broadcast like the rest
        const list = p.dirs;
        if (!Array.isArray(list) || list.some((d) => typeof d !== "string" || !path.isAbsolute(expandHome(d))))
          throw new StudioError("INVALID_PARAMS", "dirs must be an array of absolute paths (~ is expanded)");
        for (const d of list as string[]) {
          const abs = expandHome(d);
          if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new StudioError("INVALID_PARAMS", `folder not found: ${abs}`);
        }
        s.policy.policy.localApkDirs = list as string[];
        this.policyChanged(); return { localApkDirs: s.policy.policy.localApkDirs };
      }
      case "policy/set_privacy": {
        const p2 = p.privacy;
        if (!p2 || typeof p2 !== "object") throw new StudioError("INVALID_PARAMS", "privacy object required");
        for (const [k, v] of Object.entries(p2)) {
          if (typeof v !== "boolean") throw new StudioError("INVALID_PARAMS", `privacy.${k} must be boolean`);
          s.policy.policy.privacy[k as keyof PolicyFile["privacy"]] = v;
        }
        this.policyChanged();
        return { privacy: s.policy.policy.privacy };
      }
      case "policy/safe_mode": s.policy.enterSafeMode(); this.policyChanged(); return { mode: s.policy.policy.mode };

      case "audit/tail": return { entries: s.audit.tail(num(p.limit ?? 100, "limit", 1, 1000)) };
      case "audit/verify": return s.audit.verify();
      case "audit/export": {
        const format = str(p.format ?? "json", "format");
        if (!["json", "jsonl", "csv"].includes(format)) throw new StudioError("INVALID_PARAMS", "format must be json|jsonl|csv");
        return { format, text: s.audit.export(format as "json" | "jsonl" | "csv") };
      }
      case "audit/rotate": return { archived: s.audit.rotate() };

      case "session/current": return { session: s.sessions.active ?? null };
      case "session/stop": {
        // a human can always stop a test — this bypasses the policy gate, but is still audited
        const ses = s.sessions.stop(typeof p.reason === "string" ? p.reason : "user");
        if (ses) s.audit.write({
          ts: new Date().toISOString(), actor: "user", client: "ui", tool: "session_stop",
          params: { reason: ses.stopReason }, risk: "low", decision: "allow", ok: true,
          device: ses.device, session_id: ses.id,
        });
        return { session: ses ?? null };
      }
      case "sessions/history": {
        const limit = num(p.limit ?? 20, "limit", 1, 200);
        const dir = s.sessions.sessionsDir;
        if (!existsSync(dir)) return { sessions: [] };
        const files = readdirSync(dir).filter((d) => existsSync(path.join(dir, d, "session.json")));
        const rows = files.map((d) => JSON.parse(readFileSync(path.join(dir, d, "session.json"), "utf8")) as Session)
          .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, limit);
        return { sessions: rows };
      }

      case "logs/subscribe": {
        const serial = await device();
        const filter = {
          level: typeof p.level === "string" ? p.level : undefined,
          tag: typeof p.tag === "string" ? p.tag : undefined,
          contains: typeof p.contains === "string" ? p.contains : undefined,
        };
        const pkg = typeof p.package === "string" ? p.package : s.policy.policy.targetPackages[0];
        if (this.logSerial !== serial) { this.logSerial = serial; await s.logs.start(serial, pkg); }
        client.logs = filter;   // only after the stream is up, so a failure leaves no stale filter
        return { subscribed: serial, buffer: s.logs.query({ ...filter, lines: 50 }) };
      }
      case "logs/unsubscribe": {
        client.logs = undefined;
        if (![...this.clients].some((c) => c.logs)) { s.logs.stop(); this.logSerial = undefined; }
        return { unsubscribed: true };
      }
      case "logs/query": return { lines: s.logs.query({
        level: typeof p.level === "string" ? p.level : undefined,
        tag: typeof p.tag === "string" ? p.tag : undefined,
        contains: typeof p.contains === "string" ? p.contains : undefined,
        lines: num(p.lines ?? 200, "lines", 1, 5000),
      }) };
      case "logs/clear": await s.logs.clear(await device()); return { cleared: true };

      // ---------- live mirror (scrcpy) ----------
      case "scrcpy/status": return s.scrcpy.status();
      case "scrcpy/start": {
        // human-only feature; the mirror window is outside the renderer by design
        if (!s.policy.policy.features.liveView)
          throw new StudioError("POLICY_DENIED", "Live view is disabled — enable the 'liveView' feature in Settings");
        const serial = await device();
        return s.scrcpy.start(serial, {
          maxSize: typeof p.maxSize === "number" ? p.maxSize : undefined,
          bitrate: typeof p.bitrate === "string" ? p.bitrate : undefined,
          noAudio: p.noAudio !== false,
          stayAwake: p.stayAwake === true,
          turnScreenOff: p.turnScreenOff === true,
          showTouches: p.showTouches === true,
          windowTitle: typeof p.windowTitle === "string" ? p.windowTitle : `ADB Studio — ${serial}`,
        });
      }
      case "scrcpy/stop": s.scrcpy.stop(); this.mediaChanged(); return s.scrcpy.status();

      // ---------- screen recording (max 180 s per file) ----------
      case "record/status": return s.recorder.status();
      case "record/start": {
        if (!s.policy.policy.privacy.recordVideo)
          throw new StudioError("POLICY_DENIED", "Video recording is disabled by policy (privacy.recordVideo)");
        const serial = await device();
        const res = await s.recorder.start(
          serial,
          typeof p.seconds === "number" ? p.seconds : MAX_RECORD_SECONDS,
          { bitrate: typeof p.bitrate === "string" ? p.bitrate : undefined, size: typeof p.size === "string" ? p.size : undefined },
        );
        this.mediaChanged();
        return res;
      }
      case "record/stop": {
        const res = await s.recorder.stop();
        this.mediaChanged();
        return res;
      }

      // ---------- media: where files land on this machine ----------
      case "media/folders": return { folders: s.folders };
      case "media/save_screenshot": {
        const serial = await device();
        const r = await s.saveScreenshot(serial);
        return { ...r, folder: s.folders.screenshots };
      }

      // ---------- SQLite history (query layer; audit stays the source of truth) ----------
      case "db/stats": return { available: s.db.available, schemaVersion: s.db.schemaVersion, stats: s.db.stats() };
      case "db/sessions": return { sessions: s.db.sessions(num(p.limit ?? 50, "limit", 1, 500)) };
      case "db/steps": return { steps: s.db.steps(str(p.session_id, "session_id")) };
      case "db/metrics": return { metrics: s.db.metrics(typeof p.session_id === "string" ? p.session_id : undefined, num(p.limit ?? 300, "limit", 1, 5000)) };
      case "db/export": return { json: JSON.stringify({ sessions: s.db.sessions(100), approvals: s.db.approvals(100) }, null, 2) };

      case "metrics/subscribe": {
        const serial = await device();
        const interval = num(p.interval_ms ?? 2000, "interval_ms", 1, 60000);
        if (!INTERVALS.includes(interval)) throw new StudioError("INVALID_PARAMS", `interval_ms must be one of ${INTERVALS.join(", ")}`);
        client.metrics = true;
        const pkg = typeof p.package === "string" ? p.package : s.policy.policy.targetPackages[0];
        if (this.metricsSerial !== serial) { this.metricsSerial = serial; s.metrics.start(serial, pkg, interval); }
        return { subscribed: serial, recent: s.metrics.data().slice(-30) };
      }
      case "metrics/unsubscribe": {
        client.metrics = false;
        if (![...this.clients].some((c) => c.metrics)) { s.metrics.pause(); this.metricsSerial = undefined; }
        return { unsubscribed: true };
      }
      case "metrics/recent": return { samples: s.metrics.data().slice(-num(p.lines ?? 60, "lines", 1, 3600)) };
      case "metrics/csv": return { csv: s.metrics.toCsv() };

      case "tool/call": return s.call({
        tool: str(p.tool, "tool"),
        params: p.params ?? {},
        actor: "user",            // a human drives the UI
        client: "ui",
        reason: typeof p.reason === "string" ? p.reason : undefined,
      });

      case "shutdown": this.emit("shutdown"); setImmediate(() => this.close()); return { shutting_down: true };

      default: throw new StudioError("INVALID_PARAMS", `Unknown method '${method}'`);
    }
  }

  private policyChanged(): void { this.broadcast({ event: "policy:update", data: this.studio.policy.policy }); }

  /** scrcpy/recording state after a start/stop, so the UI does not have to poll. */
  broadcastMedia(): void { this.mediaChanged(); }
  private mediaChanged(): void {
    this.broadcast({
      event: "media:update",
      data: { scrcpy: this.studio.scrcpy.status(), record: { running: this.studio.recorder.status().running, seconds: this.studio.recorder.status().seconds } },
    });
  }

  /** Anomaly alerts (wire.ts already audits them; here we just show them in the UI). */
  broadcastAnomaly(message: string): void { this.broadcast({ event: "anomaly", data: { message } }); }

  broadcastReady(agentUrl: string): void {
    this.broadcast({ event: "agent:ready", data: { agent_url: agentUrl, control_url: `ws://127.0.0.1:${this.wss ? (this.wss.address() as { port: number }).port : 0}` } });
  }

  private ensurePolling(): void {
    if (this.poll || !(this.opts.pollDevicesMs && this.opts.pollDevicesMs > 0)) return;
    this.poll = setInterval(() => void this.pollDevices(), this.opts.pollDevicesMs);
  }

  private async pollDevices(): Promise<void> {
    try {
      const devices = await this.studio.devices.list();
      const json = JSON.stringify(devices);
      if (json !== this.lastDevices) { this.lastDevices = json; this.broadcast({ event: "devices", data: devices }); }
    } catch { /* device list can fail while adb restarts — keep polling */ }
  }

  private wantsLog(c: Client, l: LogLine): boolean {
    const f = c.logs;
    if (!f) return false;
    const order = "VDIWEF";
    if (f.level && order.indexOf(l.level) < order.indexOf(f.level)) return false;
    if (f.tag && l.tag !== f.tag) return false;
    if (f.contains && !l.msg.toLowerCase().includes(f.contains.toLowerCase())) return false;
    return true;
  }

  private send(client: Client, obj: unknown): void {
    if (client.ws.readyState === 1) client.ws.send(JSON.stringify(obj));
  }

  private broadcast(e: ControlEvent): void {
    for (const c of this.clients) this.send(c, e);
  }

  close(): void {
    if (this.poll) { clearInterval(this.poll); this.poll = undefined; }
    this.studio.logs.stop();
    this.studio.metrics.pause();
    for (const c of this.clients) this.send(c, { event: "bye", data: { reason: "agent closed" } });
    for (const c of this.clients) c.ws.close(1001);
    this.clients.clear();
    this.wss?.close();
    this.wss = undefined;
  }
}
