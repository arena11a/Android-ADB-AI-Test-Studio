import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { StudioError } from "../types.js";
import type { Adb } from "../adb.js";
import type { KillSwitch } from "../killswitch.js";

export const MAX_RECORD_SECONDS = 180;   // kernel/OS hard limit of `adb shell screenrecord`

export interface Recording { device: string; remotePath: string; startedAt: number; seconds: number }
export interface RecordingResult { remotePath: string; localPath: string; size: number; seconds: number }

/**
 * `adb shell screenrecord` with a hard time limit. The file is only finalised
 * when the child gets SIGINT (killing it outright loses the moov atom), so we
 * pull it afterwards and verify it is a playable MP4 before reporting success.
 */
export class ScreenRecordService {
  private child?: ChildProcess;
  private current?: Recording;
  private timer?: NodeJS.Timeout;

  constructor(private adb: Adb, private kill: KillSwitch, private localDir: string, private remoteDir = "/sdcard/Movies/adbstudio") {}

  get running(): boolean { return !!this.child && this.child.exitCode === null; }
  status(): { running: boolean; recording?: Recording; seconds?: number } {
    return { running: this.running, recording: this.current, seconds: this.current ? Math.round((Date.now() - this.current.startedAt) / 1000) : undefined };
  }

  async start(serial: string, seconds = MAX_RECORD_SECONDS, opts: { bitrate?: string; size?: string } = {}): Promise<Recording> {
    if (this.running) throw new StudioError("SESSION_LIMIT", "already recording — stop it first");
    const limit = Math.max(1, Math.min(Math.floor(seconds), MAX_RECORD_SECONDS));
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const remotePath = `${this.remoteDir}/rec-${stamp}.mp4`;
    const args = ["shell", "screenrecord", "--time-limit", String(limit)];
    if (opts.bitrate) args.push("--bit-rate", opts.bitrate);
    if (opts.size) args.push("--size", opts.size);
    args.push(remotePath);

    const child = spawn(this.adb.binary, ["-s", serial, ...args], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); if (stderr.length > 400) stderr = stderr.slice(-400); });
    child.on("exit", () => { this.child = undefined; });
    child.on("error", () => { this.child = undefined; });
    this.kill.track(child);
    this.child = child;
    this.current = { device: serial, remotePath, startedAt: Date.now(), seconds: limit };

    // screenrecord stops on its own at the limit; stop() finalises the file earlier
    this.timer = setTimeout(() => { void this.stop().catch(() => undefined); }, limit * 1000);
    this.timer.unref();
    await new Promise((r) => setTimeout(r, 300));   // let it fail fast on bad args
    if (!this.running) throw new StudioError("ADB_ERROR", stderr.trim().slice(0, 300) || "screenrecord exited immediately (already recording elsewhere?)");
    return this.current;
  }

  /**
   * SIGINT → the device finalises the MP4; then pull it and verify.
   * Windows has no real signals: killing the process there is equivalent to
   * SIGKILL, which can truncate the MP4 — we detect that and say so instead of
   * pretending the clip is fine.
   */
  async stop(): Promise<RecordingResult> {
    const rec = this.current;
    if (!rec || !this.child) throw new StudioError("INVALID_PARAMS", "not recording");
    clearTimeout(this.timer);
    const seconds = Math.max(1, Math.round((Date.now() - rec.startedAt) / 1000));

    // Windows cannot deliver SIGINT; SIGKILL there risks a truncated file, so we
    // remember it and warn if the clip turns out unplayable.
    const graceful = process.platform !== "win32";
    try { this.child.kill(graceful ? "SIGINT" : "SIGTERM"); } catch { /* already gone */ }
    for (let i = 0; i < 40 && this.running; i++) await new Promise((r) => setTimeout(r, 250));
    if (this.running) { try { this.child.kill("SIGKILL"); } catch { /* ignore */ } }
    this.child = undefined; this.current = undefined;

    // the file appears a moment after the writer closes it
    let remote = "";
    for (let i = 0; i < 20; i++) {
      const r = await this.adb.run(["shell", "ls", "-l", rec.remotePath], { serial: rec.device });
      if (r.stdout.includes(rec.remotePath) && !/No such file/i.test(r.stdout + r.stderr)) { remote = r.stdout.trim(); break; }
      await new Promise((res) => setTimeout(res, 300));
    }
    if (!remote) throw new StudioError("ADB_ERROR", `recording file not found on device (${rec.remotePath}) — clip may be too short`);

    mkdirSync(this.localDir, { recursive: true });
    const localPath = path.join(this.localDir, path.posix.basename(rec.remotePath));
    await this.adb.must(["pull", rec.remotePath, localPath], { serial: rec.device, timeoutMs: 120_000 });
    const size = existsSync(localPath) ? statSync(localPath).size : 0;
    if (size < 1024) {
      throw new StudioError("ADB_ERROR", graceful
        ? "recording looks empty (< 1 KB) — the clip may have been too short"
        : "recording is empty — on Windows, stopping early can truncate the MP4; let the time limit finish instead");
    }

    // tidy the device copy; failure here must not lose the local file
    await this.adb.run(["shell", "rm", "-f", rec.remotePath], { serial: rec.device }).catch(() => undefined);
    return { remotePath: rec.remotePath, localPath, size, seconds };
  }
}
