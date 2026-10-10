import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { StudioError } from "../types.js";
import type { KillSwitch } from "../killswitch.js";

const CANDIDATES = [
  "/usr/bin/scrcpy", "/usr/local/bin/scrcpy",
  path.join(homedir(), ".local", "bin", "scrcpy"),
  "/opt/homebrew/bin/scrcpy",
  "C:\\Program Files\\scrcpy\\scrcpy.exe",
  path.join(process.env.LOCALAPPDATA ?? "", "Programs", "scrcpy", "scrcpy.exe"),
];

/** Finds scrcpy: explicit path → $PATH → common install locations. */
export function resolveScrcpyPath(configured = "auto", platform: NodeJS.Platform = process.platform): string {
  if (configured && configured !== "auto") {
    const p = configured.replace(/^~/, homedir());
    if (!existsSync(p)) throw new StudioError("UNSUPPORTED", `scrcpy not found at '${p}' (scrcpy.path in app.config.json)`);
    return p;
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const c = path.join(dir, platform === "win32" ? "scrcpy.exe" : "scrcpy");
    try { if (existsSync(c) && statSync(c).isFile()) return c; } catch { /* keep looking */ }
  }
  const found = CANDIDATES.find((c) => { try { return existsSync(c) && statSync(c).isFile(); } catch { return false; } });
  if (!found) throw new StudioError("UNSUPPORTED", "scrcpy not found — install it (winget/apt/brew) or set scrcpy.path in app.config.json");
  return found;
}

export interface ScrcpyOptions {
  maxSize?: number; bitrate?: string; noAudio?: boolean; stayAwake?: boolean;
  turnScreenOff?: boolean; showTouches?: boolean; fullscreen?: boolean; windowTitle?: string;
}

/**
 * Live mirror as its own OS window (never inside the web UI, per design: the
 * renderer must stay policy-gated, and scrcpy needs raw input).
 */
/** Options this scrcpy build actually supports, parsed once from `--help`. */
function supportedFlags(bin: string): Set<string> {
  const cacheKey = `scrcpy-flags:${bin}`;
  const cached = (globalThis as Record<string, unknown>)[cacheKey] as Set<string> | undefined;
  if (cached) return cached;
  const flags = new Set<string>();
  try {
    const help = spawnSync(bin, ["--help"], { timeout: 4000 }).stdout?.toString() ?? "";
    for (const m of help.matchAll(/^\s{2,}(?:-[a-zA-Z], )?(--[a-z0-9-]+)/gm)) flags.add(m[1]);
  } catch { /* unknown set → assume permissive */ }
  (globalThis as Record<string, unknown>)[cacheKey] = flags;
  return flags;
}

/** Throws when an option is not supported by this scrcpy build. */
function assertSupported(bin: string, args: string[]): void {
  const flags = supportedFlags(bin);
  if (!flags.size) return;                     // could not read help → let the binary decide
  const bad = args.filter((a) => a.startsWith("--") && !flags.has(a));
  if (bad.length) throw new StudioError("UNSUPPORTED", `scrcpy does not support ${bad.join(", ")} in this build`);
}

export class ScrcpyService {
  private child?: ChildProcess;
  private serial?: string;
  private startedAt?: number;
  private extraArgs: string[];
  /** called when the mirror window closes (by the user or by a crash) */
  onExit?: () => void;

  constructor(private kill: KillSwitch, private configured = "auto", extraArgs: string[] = ["--no-audio"]) {
    this.extraArgs = extraArgs;
  }

  get running(): boolean { return !!this.child && this.child.exitCode === null; }
  status(): { running: boolean; serial?: string; seconds?: number } {
    return { running: this.running, serial: this.serial, seconds: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : undefined };
  }

  async start(serial: string, opts: ScrcpyOptions = {}): Promise<{ pid: number; args: string[] }> {
    if (this.running) throw new StudioError("SESSION_LIMIT", "scrcpy is already running — stop it first");
    const bin = resolveScrcpyPath(this.configured);
    // configuration may carry legacy flags the installed scrcpy lacks — filter them
    // out instead of failing (an old config must not break the Live view)
    const extra = this.extraArgs.filter((a) => !a.startsWith("--") || supportedFlags(bin).has(a));
    const args = ["-s", serial, ...extra];
    const flags = supportedFlags(bin);
    const push2 = (flag: string, short: string, value?: string | number | boolean) => {
      const use = flags.has(flag) || flags.has(short);
      if (flags.size && !use) return;                       // not in this build → skip silently
      if (value === true || value === undefined) args.push(flags.has(flag) ? flag : short);
      else args.push(flags.has(flag) ? flag : short, String(value));
    };
    push2("--max-size", "-m", opts.maxSize);
    push2("--bit-rate", "-b", opts.bitrate);
    if (opts.noAudio && flags.has("--no-audio")) args.push("--no-audio");   // only when supported
    if (opts.stayAwake) push2("--stay-awake", "-w");
    if (opts.turnScreenOff) push2("--turn-screen-off", "-S");
    if (opts.showTouches) push2("--show-touches", "-t");
    if (opts.fullscreen) push2("--fullscreen", "-f");
    if (opts.windowTitle && flags.has("--window-title")) args.push("--window-title", opts.windowTitle);
    assertSupported(bin, args);

    const child = spawn(bin, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); if (stderr.length > 600) stderr = stderr.slice(-600); });
    child.on("exit", (code) => {
      this.child = undefined; this.startedAt = undefined;
      this.onExit?.();
      if (code !== 0 && code !== null) console.error(`[scrcpy] exited with ${code}: ${stderr.trim().slice(0, 300)}`);
    });
    child.on("error", (e) => {
      this.child = undefined; this.startedAt = undefined;
      this.onExit?.();
      console.error(`[scrcpy] failed to launch: ${e.message}`);
    });
    this.kill.track(child);
    this.child = child; this.serial = serial; this.startedAt = Date.now();

    // fail loudly instead of pretending a window opened (missing device, no adb server, …)
    await new Promise((r) => setTimeout(r, 700));
    if (!this.running) {
      this.stop();
      throw new StudioError("ADB_ERROR", `scrcpy ไม่ทำงาน: ${stderr.trim().slice(0, 300) || "process exited ทันที (ตรวจอุปกรณ์/adb server)"}`);
    }
    return { pid: child.pid!, args };
  }

  stop(): void {
    if (!this.child) return;
    try { this.child.kill("SIGTERM"); } catch { /* already gone */ }
    this.child = undefined; this.startedAt = undefined;
  }
}
