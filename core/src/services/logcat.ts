import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { Adb } from "../adb.js";
import { redact } from "../audit.js";

export interface LogLine { ts: string; level: string; tag: string; pid: number; msg: string; highlight?: "crash" | "anr" | "error" }

const LINE = /^(\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+(.*?):\s?(.*)$/;
const CRASH = /FATAL EXCEPTION|AndroidRuntime.*(?:FATAL|Exception)|Process: .* PID: \d+/;
const ANR = /ANR in ([A-Za-z0-9_.]+)/;

export function parseLogLine(raw: string, redactOn = true): LogLine | null {
  const m = raw.match(LINE);
  if (!m) return null;
  const msg = redactOn ? redact(m[6]) : m[6];
  const line: LogLine = { ts: m[1], pid: Number(m[3]), level: m[4], tag: m[5], msg };
  if (CRASH.test(raw)) line.highlight = "crash";
  else if (ANR.test(raw)) line.highlight = "anr";
  else if (/Exception|Fatal|Error/i.test(raw) && (m[4] === "E" || m[4] === "F")) line.highlight = "error";
  return line;
}

/** Streams logcat, keeps a ring buffer, emits "crash"/"anr" events for session stop conditions. */
export class LogService extends EventEmitter {
  private child?: ChildProcess;
  private ring: LogLine[] = [];

  constructor(private adb: Adb, private ringSize = 5000, private redactOn = true) { super(); }

  async clear(serial: string): Promise<void> { await this.adb.must(["logcat", "-c"], { serial }); }

  async start(serial: string, targetPkg?: string): Promise<void> {
    this.stop();
    const args = ["-v", "threadtime"];
    if (targetPkg) {
      // --pid only works for a running app; crash/ANR are caught by the global pattern below regardless
      const r = await this.adb.run(["shell", "pidof", targetPkg], { serial });
      const pid = r.stdout.trim().split(/\s+/)[0];
      if (/^\d+$/.test(pid)) args.push("--pid", pid);
    }
    this.child = this.adb.streamLogcat(serial, args);
    let buf = "";
    this.child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) this.ingest(l, targetPkg);
    });
    this.child.once("exit", () => this.emit("ended"));
  }

  private ingest(raw: string, targetPkg?: string): void {
    const line = parseLogLine(raw, this.redactOn);
    if (!line) return;
    this.ring.push(line);
    if (this.ring.length > this.ringSize) this.ring.shift();
    this.emit("line", line);
    // crash lines don't always name the package, so any crash while a target session runs stops it
    if (line.highlight === "crash") this.emit("crash", line);
    const anr = raw.match(ANR);
    if (anr && (!targetPkg || anr[1] === targetPkg)) this.emit("anr", line);
  }

  query(opts: { level?: string; tag?: string; contains?: string; lines?: number }): LogLine[] {
    const order = "VDIWEF";
    const min = order.indexOf(opts.level ?? "V");
    return this.ring
      .filter((l) => order.indexOf(l.level) >= min)
      .filter((l) => !opts.tag || l.tag === opts.tag)
      .filter((l) => !opts.contains || l.msg.toLowerCase().includes(opts.contains.toLowerCase()))
      .slice(-(opts.lines ?? 200));
  }

  stop(): void { this.child?.kill("SIGTERM"); this.child = undefined; }
}
