import { execFile, spawn, type ChildProcess } from "node:child_process";
import { StudioError } from "./types.js";
import type { KillSwitch } from "./killswitch.js";

export interface AdbResult { stdout: string; stderr: string; code: number }
export type DeviceState = "online" | "offline" | "unauthorized" | "disconnected";
export interface DeviceEntry { serial: string; state: DeviceState; model?: string; transport: "usb" | "wifi" }

/**
 * Thin ADB wrapper. Rules:
 *  - always execFile with an args array (never a shell string) → no injection
 *  - always a timeout
 *  - every child is tracked by the kill switch
 * Only services call this; AI never reaches it directly.
 */
export class Adb {
  constructor(private bin: string, private kill: KillSwitch, private defaultTimeoutMs = 30_000) {}

  /** Absolute path of the adb binary (for services that spawn streams). */
  get binary(): string { return this.bin; }

  run(args: string[], opts: { serial?: string; timeoutMs?: number; binary?: boolean } = {}): Promise<AdbResult & { raw?: Buffer }> {
    if (this.kill.active) return Promise.reject(new StudioError("KILL_SWITCH", "Kill switch is active"));
    const full = opts.serial ? ["-s", opts.serial, ...args] : args;
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.bin, full,
        { timeout: opts.timeoutMs ?? this.defaultTimeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: opts.binary ? "buffer" : "utf8", windowsHide: true },
        (err, stdout, stderr) => {
          const code = err ? ((err as NodeJS.ErrnoException & { code?: number | string }).code === "ETIMEDOUT" ? -2 : (child.exitCode ?? -1)) : 0;
          if (err && (err as { killed?: boolean }).killed) return reject(new StudioError("TIMEOUT", `adb ${args[0]} timed out`));
          if (err && typeof (err as NodeJS.ErrnoException).code === "string" && (err as NodeJS.ErrnoException).code === "ENOENT")
            return reject(new StudioError("UNSUPPORTED", "adb binary not found — set adb.path in app.config.json"));
          const out = opts.binary ? "" : String(stdout);
          resolve({ stdout: out, stderr: String(stderr), code, raw: opts.binary ? (stdout as unknown as Buffer) : undefined });
        },
      );
      this.kill.track(child);
    });
  }

  /** Run and throw ADB_ERROR on non-zero exit. */
  async must(args: string[], opts: Parameters<Adb["run"]>[1] = {}): Promise<AdbResult & { raw?: Buffer }> {
    const r = await this.run(args, opts);
    if (r.code !== 0) throw new StudioError("ADB_ERROR", (r.stderr || r.stdout || `adb exited ${r.code}`).trim().slice(0, 500));
    return r;
  }

  /** Fixed, parameter-free-or-validated device shell invocations only (callers pass argv, not strings). */
  shell(serial: string, argv: string[], timeoutMs?: number): Promise<AdbResult> {
    return this.must(["shell", ...argv], { serial, timeoutMs });
  }

  streamLogcat(serial: string, args: string[]): ChildProcess {
    if (this.kill.active) throw new StudioError("KILL_SWITCH", "Kill switch is active");
    const child = spawn(this.bin, ["-s", serial, "logcat", ...args], { windowsHide: true });
    this.kill.track(child);
    return child;
  }

  async listDevices(): Promise<DeviceEntry[]> {
    const { stdout } = await this.must(["devices", "-l"]);
    return parseDevices(stdout);
  }
}

export function parseDevices(out: string): DeviceEntry[] {
  return out.split("\n").slice(1).map((l) => l.trim()).filter(Boolean).map((line) => {
    const [serial, st, ...rest] = line.split(/\s+/);
    const state: DeviceState = st === "device" ? "online" : st === "unauthorized" ? "unauthorized" : st === "offline" ? "offline" : "disconnected";
    const model = rest.find((r) => r.startsWith("model:"))?.slice(6);
    return { serial, state, model, transport: /^(\d{1,3}\.){3}\d{1,3}:\d+$|\._adb-tls-connect\._tcp/.test(serial) ? "wifi" : "usb" } as DeviceEntry;
  });
}

/** Parse `dumpsys activity activities` for the resumed package. */
export function parseForegroundPackage(dump: string): string | null {
  const m = dump.match(/(?:topResumedActivity|mResumedActivity|ResumedActivity)[^\n]*?\s([A-Za-z0-9_.]+)\/[A-Za-z0-9_.$]+/);
  return m ? m[1] : null;
}

export function parseBattery(dump: string): { level?: number; tempC?: number; charging?: boolean } {
  const num = (k: string) => { const m = dump.match(new RegExp(`${k}:\\s*(-?\\d+)`)); return m ? Number(m[1]) : undefined; };
  const status = num("status");
  const t = num("temperature");
  return { level: num("level"), tempC: t === undefined ? undefined : t / 10, charging: status === 2 || status === 5 };
}

export interface UiElement {
  text: string; resource_id: string; content_desc: string; class: string; package: string;
  clickable: boolean; enabled: boolean; bounds: [number, number, number, number];
}

/** Parse uiautomator XML into flat elements. Text is DATA only — never treated as instructions. */
export function parseUiHierarchy(xml: string): UiElement[] {
  const out: UiElement[] = [];
  const re = /<node\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  const attr = (s: string, k: string) => {
    const a = s.match(new RegExp(`\\b${k}="([^"]*)"`));
    return a ? a[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : "";
  };
  while ((m = re.exec(xml))) {
    const s = m[1];
    const b = attr(s, "bounds").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!b) continue;
    out.push({
      text: attr(s, "text"), resource_id: attr(s, "resource-id"), content_desc: attr(s, "content-desc"),
      class: attr(s, "class"), package: attr(s, "package"),
      clickable: attr(s, "clickable") === "true", enabled: attr(s, "enabled") === "true",
      bounds: [Number(b[1]), Number(b[2]), Number(b[3]), Number(b[4])],
    });
  }
  return out;
}

export function centerOf(b: UiElement["bounds"]): { x: number; y: number } {
  return { x: Math.round((b[0] + b[2]) / 2), y: Math.round((b[1] + b[3]) / 2) };
}
