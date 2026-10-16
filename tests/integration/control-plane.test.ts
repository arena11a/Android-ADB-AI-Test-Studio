import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { ControlServer } from "../../core/src/control.js";
import { createStudio, type Studio } from "../../core/src/wire.js";
import { createAgent } from "../../core/src/agent.js";
import type { PolicyFile } from "../../core/src/types.js";

const FAKE = path.resolve("tests/integration/fake-adb.mjs");
const TOKEN = "test-token";

let dir: string, studio: Studio, stateFile: string, apk: string;
let control: ControlServer;
let url = "", token = "";

function make() {
  dir = mkdtempSync(path.join(tmpdir(), "ctl-"));
  stateFile = path.join(dir, "state.json");
  writeFileSync(stateFile, JSON.stringify({
    devices: [{ serial: "ABC123", state: "device" }],
    foreground: "com.example.app", locked: false,
    user: ["com.example.app", "com.other.app"], apkPackage: "com.example.app",
  }));
  process.env.FAKE_ADB_STATE = stateFile;
  mkdirSync(path.join(dir, "apk"));
  apk = path.join(dir, "apk", "app.apk");
  writeFileSync(apk, "apk-bytes");

  const base: PolicyFile = JSON.parse(readFileSync("config/policy.default.json", "utf8"));
  studio = createStudio({
    adbPath: FAKE, dataDir: path.join(dir, "data"),
    policy: {
      ...base, mode: "develop", role: "admin", targetPackages: ["com.example.app"],
      localApkDirs: [path.join(dir, "apk")],
      features: { ...base.features, input: true, install: true, power: true, delete: true, files: true },
    },
  });
}

const calls = () => (existsSync(stateFile + ".calls")
  ? readFileSync(stateFile + ".calls", "utf8").split("\n").filter(Boolean).map((l) => { const a = JSON.parse(l) as string[]; return a[0] === "-s" ? a.slice(2) : a; })
  : []);

/** Minimal JSON-RPC-ish client that also collects pushed events. */
class Ctl {
  ws: WebSocket;
  events: Array<{ event: string; data: unknown }> = [];
  private next = 1;
  private pending = new Map<number, (m: Record<string, unknown>) => void>();
  private waiters: Array<{ pred: (e: { event: string; data: unknown }) => boolean; resolve: (e: { event: string; data: unknown }) => void }> = [];

  static async open(target: string, tok?: string): Promise<Ctl> {
    const c = new Ctl();
    c.ws = new WebSocket(target, tok ? { headers: { Authorization: `Bearer ${tok}` } } : {});
    await new Promise<void>((resolve, reject) => { c.ws.once("open", resolve); c.ws.once("error", reject); });
    c.ws.on("message", (d: Buffer) => {
      const m = JSON.parse(String(d)) as Record<string, unknown>;
      if (typeof m.event === "string") {
        const e = { event: m.event, data: m.data };
        c.events.push(e);
        for (const w of [...c.waiters]) if (w.pred(e)) { c.waiters.splice(c.waiters.indexOf(w), 1); w.resolve(e); }
        return;
      }
      c.pending.get(m.id as number)?.(m);
      c.pending.delete(m.id as number);
    });
    return c;
  }

  /** Resolves with `result`; rejects with an Error carrying `.code` on an error reply. */
  call(method: string, params: Record<string, unknown> = {}, timeoutMs = 8000): Promise<any> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`timeout on '${method}'`)); }, timeoutMs);
      this.pending.set(id, (m) => {
        clearTimeout(t);
        const err = m.error as { code: string; message: string } | undefined;
        if (err) {
          const e = new Error(`${method}: [${err.code}] ${err.message}`);
          (e as unknown as { code: string }).code = err.code;
          reject(e);
        } else resolve(m.result);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  waitFor(pred: (e: { event: string; data: unknown }) => boolean, timeoutMs = 8000): Promise<{ event: string; data: unknown }> {
    const hit = this.events.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for event")), timeoutMs);
      this.waiters.push({ pred, resolve: (e) => { clearTimeout(t); resolve(e); } });
    });
  }

  /** event counter, so a test can wait only for events that arrive after this point */
  mark(): number { return this.events.length; }

  async waitForFrom(mark: number, pred: (e: { event: string; data: unknown }) => boolean, timeoutMs = 8000): Promise<{ event: string; data: unknown }> {
    const seen = this.events.slice(mark);
    const hit = seen.find(pred);
    if (hit) return hit;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for event")), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (e) => {
          clearTimeout(t);
          // ignore events that were already buffered before `mark`
          if (this.events.indexOf(e) < mark) return;
          resolve(e);
        },
      });
    });
  }

  close(): void { this.ws.close(); }
}

const expectRejected = async (target: string, tok?: string) => {
  await expect(new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(target, tok ? { headers: { Authorization: `Bearer ${tok}` } } : {});
    ws.once("open", () => { ws.close(); resolve(); });
    ws.once("error", () => reject(new Error("rejected")));
  })).rejects.toThrow();
};

beforeEach(async () => {
  make();
  control = new ControlServer(studio, { port: 0, adbPath: FAKE });
  ({ url, token } = await control.start());
});

afterEach(() => {
  control.close();
  studio.kill.release();
});

describe("control server — authentication", () => {
  it("rejects no token, wrong token and browser origins; accepts the right token", async () => {
    await expectRejected(url);
    await expectRejected(url, "wrong-token");
    await expectRejected(url, TOKEN);        // correct value but the server minted its own
    const ok = await Ctl.open(url, token);
    expect((await ok.call("hello")).version).toBe("0.1.0");
    ok.close();
  });

  it("binds loopback only", () => {
    expect(url.startsWith("ws://127.0.0.1:")).toBe(true);
  });
});

describe("control server — tools and policy", () => {
  it("runs tools as the user actor and records them in the audit log", async () => {
    const ctl = await Ctl.open(url, token);
    const r = await ctl.call("tool/call", { tool: "device_list" });
    expect(r.ok).toBe(true);
    expect(r.data.devices[0].serial).toBe("ABC123");

    const tail = await ctl.call("audit/tail", { limit: 5 });
    expect(tail.entries.some((e: { tool: string; actor: string }) => e.tool === "device_list" && e.actor === "user")).toBe(true);
    expect((await ctl.call("audit/verify")).ok).toBe(true);
    const csv = await ctl.call("audit/export", { format: "csv" });
    expect(csv.text.startsWith("seq,ts,")).toBe(true);
    ctl.close();
  });

  it("policy: mode change is enforced and broadcast", async () => {
    const ctl = await Ctl.open(url, token);
    expect((await ctl.call("tool/call", { tool: "screenshot" })).ok).toBe(true);
    const p = ctl.call("policy/set_mode", { mode: "safe" });
    await p;
    expect((await ctl.waitFor((e) => e.event === "policy:update")).data).toMatchObject({ mode: "safe" });
    const r = await ctl.call("tool/call", { tool: "screenshot" });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("POLICY_DENIED");
    await expect(ctl.call("policy/set_mode", { mode: "wat" })).rejects.toThrow(/INVALID_PARAMS/);
    ctl.close();
  });

  it("policy: rejects unknown targets / features, safe mode turns everything off", async () => {
    const ctl = await Ctl.open(url, token);
    expect((await ctl.call("policy/set_targets", { targets: ["com.example.app", "com.two.app"] })).targets).toHaveLength(2);
    await expect(ctl.call("policy/set_targets", { targets: ["bad;pkg"] })).rejects.toThrow(/INVALID_PARAMS/);
    await expect(ctl.call("policy/set_features", { features: { nope: true } })).rejects.toThrow(/INVALID_PARAMS/);
    const safe = await ctl.call("policy/safe_mode");
    expect(safe.mode).toBe("safe");
    expect((await ctl.call("policy/get")).policy.features).toMatchObject({ input: false, install: false });
    ctl.close();
  });

  it("policy: local APK folders must be absolute and exist", async () => {
    const ctl = await Ctl.open(url, token);
    expect((await ctl.call("policy/set_local_apk_dirs", { dirs: [dir] })).localApkDirs).toContain(dir);
    await expect(ctl.call("policy/set_local_apk_dirs", { dirs: ["relative/path"] })).rejects.toThrow(/absolute/);
    await expect(ctl.call("policy/set_local_apk_dirs", { dirs: [path.join(dir, "nope")] })).rejects.toThrow(/folder not found/);
    ctl.close();
  });
});

describe("control server — approvals", () => {
  it("high-risk call waits for a decision over the socket", async () => {
    const ctl = await Ctl.open(url, token);
    const running = ctl.call("tool/call", { tool: "app_install", params: { apk_path: apk, reason: "ui install" } });
    const added = await ctl.waitFor((e) => e.event === "approval:added");
    const req = added.data as { id: string; risk: string; tool: string };
    expect(req.risk).toBe("high");
    expect(req.tool).toBe("app_install");

    expect((await ctl.call("approval/decide", { id: req.id, action: "deny" })).decided).toBe("deny");
    const r = await running;
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("APPROVAL_DENIED");
    expect(calls().some((c) => c[0] === "install")).toBe(false);

    // approve path (wait only for events raised from here on)
    const mark = ctl.mark();
    const running2 = ctl.call("tool/call", { tool: "app_install", params: { apk_path: apk, reason: "ui install" } });
    const added2 = await ctl.waitForFrom(mark, (e) => e.event === "approval:added" && (e.data as { tool: string }).tool === "app_install");
    await ctl.call("approval/decide", { id: (added2.data as { id: string }).id, action: "approve" });
    expect((await running2).ok).toBe(true);
    expect(calls().some((c) => c[0] === "install")).toBe(true);
    await ctl.waitForFrom(mark, (e) => e.event === "approval:settled");
    ctl.close();
  });

  it("critical reboot needs the exact typed confirmation", async () => {
    const ctl = await Ctl.open(url, token);
    const running = ctl.call("tool/call", { tool: "power_request_reboot", params: { reason: "ui reboot" } });
    const added = await ctl.waitFor((e) => e.event === "approval:added");
    const id = (added.data as { id: string; typedConfirm?: string }).id;
    expect((added.data as { typedConfirm?: string }).typedConfirm).toBe("CONFIRM");
    await expect(ctl.call("approval/decide", { id, action: "approve", typed: "yes" })).rejects.toThrow(/INVALID_PARAMS/);
    expect((await ctl.call("approval/decide", { id, action: "approve", typed: "CONFIRM" })).decided).toBe("approve");
    expect((await running).ok).toBe(true);
    expect(calls().some((c) => c[0] === "reboot")).toBe(true);
    ctl.close();
  });
});

describe("control server — kill switch", () => {
  it("blocks every call and can only be released by a human", async () => {
    const ctl = await Ctl.open(url, token);
    await ctl.call("killswitch/trigger", { source: "test" });
    expect((await ctl.waitFor((e) => e.event === "killswitch")).data).toEqual({ active: true });
    const blocked = await ctl.call("tool/call", { tool: "device_list" });
    expect(blocked.ok).toBe(false);
    expect(blocked.error.code).toBe("KILL_SWITCH");
    await ctl.call("killswitch/release");
    expect((await ctl.call("tool/call", { tool: "device_list" })).ok).toBe(true);
    ctl.close();
  });
});

describe("control server — streams", () => {
  it("logs: subscribe receives lines, query reads the ring buffer, unsubscribe stops adb", async () => {
    const ctl = await Ctl.open(url, token);
    const mark = ctl.mark();
    const sub = await ctl.call("logs/subscribe");
    expect(sub.subscribed).toBe("ABC123");
    const line = await ctl.waitForFrom(mark, (e) => e.event === "log:line");
    expect((line.data as { msg: string }).msg).toContain("hello from logcat");
    // wait until the second streamed line landed, then query the ring buffer
    await ctl.waitForFrom(mark, (e) => e.event === "log:line" && String((e.data as { msg: string }).msg).includes("warning"));
    const q = await ctl.call("logs/query", { contains: "warning" });
    expect(q.lines.length).toBeGreaterThan(0);
    await ctl.call("logs/unsubscribe");
    ctl.close();
  });

  it("metrics: subscribe receives samples", async () => {
    const ctl = await Ctl.open(url, token);
    const sub = await ctl.call("metrics/subscribe", { package: "com.example.app", interval_ms: 1000 });
    expect(sub.subscribed).toBe("ABC123");
    const s = await ctl.waitFor((e) => e.event === "metrics:sample");
    const sample = s.data as { ts: number; batt_pct?: number; ram_app_kb?: number };
    expect(sample.ts).toBeGreaterThan(0);
    expect(sample.batt_pct).toBe(77);
    expect(sample.ram_app_kb).toBe(123456);
    expect((await ctl.call("metrics/recent", { lines: 5 })).samples.length).toBeGreaterThan(0);
    await ctl.call("metrics/unsubscribe");
    ctl.close();
  });
});

describe("control server — sessions and shutdown", () => {
  it("session lifecycle and history", async () => {
    const ctl = await Ctl.open(url, token);
    const start = await ctl.call("tool/call", { tool: "session_start", params: { name: "ctl-session", package: "com.example.app" } });
    expect(start.ok).toBe(true);
    const upd = await ctl.waitFor((e) => e.event === "session:update");
    expect((upd.data as { name: string }).name).toBe("ctl-session");
    await ctl.call("tool/call", { tool: "screenshot" });
    expect((await ctl.call("session/current")).session.steps.length).toBeGreaterThan(0);
    const stopped = await ctl.call("session/stop", { reason: "done" });
    expect(stopped.session.stopReason).toBe("done");
    expect((await ctl.call("sessions/history")).sessions[0].name).toBe("ctl-session");
    ctl.close();
  });

  it("shutdown closes the server and the clients", async () => {
    const ctl = await Ctl.open(url, token);
    await ctl.call("shutdown");
    await new Promise((r) => ctl.ws.once("close", r));
    await expectRejected(url, token);
  });
});

describe("agent — both sockets", () => {
  it("MCP socket speaks tools/list + tools/call and rejects other tokens", async () => {
    const agent = createAgent({
      adbPath: FAKE, dataDir: path.join(dir, "data2"),
      policy: JSON.parse(readFileSync("config/policy.default.json", "utf8")),
      endpointFile: path.join(dir, "endpoint.json"),
      pollDevicesMs: 0,
    });
    const ep = await agent.ready();
    expect(ep.agent.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    expect(ep.control.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    expect(ep.agent.token).toMatch(/^[0-9a-f]{64}$/);
    // endpoint file the MCP bridge reads exists and is readable
    expect(JSON.parse(readFileSync(path.join(dir, "endpoint.json"), "utf8"))).toMatchObject({ token: ep.agent.token });

    await expectRejected(ep.agent.url);                        // no token
    await expectRejected(ep.agent.url, ep.control.token);      // wrong token
    await expectRejected(ep.control.url, ep.agent.token);      // sockets do not share tokens

    const bridge = await Ctl.open(ep.agent.url, ep.agent.token);
    const tools = await bridge.call("tools/list");
    expect(tools.some((t: { name: string }) => t.name === "device_list")).toBe(true);
    const r = await bridge.call("tools/call", { name: "device_list", arguments: {}, client: "test" });
    expect(r.ok).toBe(true);
    expect(r.data.devices[0].serial).toBe("ABC123");

    const ui = await Ctl.open(ep.control.url, ep.control.token);
    expect((await ui.call("hello")).mode).toBe("safe");
    agent.close();
  });
});
