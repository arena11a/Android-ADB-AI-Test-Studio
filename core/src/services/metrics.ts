import { EventEmitter } from "node:events";
import { Adb, parseBattery } from "../adb.js";

export interface MetricSample {
  ts: number;
  cpu_sys?: number;          // % — from /proc/stat delta (system-wide)
  cpu_app?: number;          // % — from `dumpsys cpuinfo` (approximate)
  ram_app_kb?: number;       // PSS total
  storage_free_kb?: number;
  batt_pct?: number; batt_temp_c?: number; charging?: boolean;
  limited: string[];         // metrics unavailable without root / on this device
}

/** Polls at a user-chosen interval (1/2/5 s). pause() stops polling immediately. */
export class MetricsCollector extends EventEmitter {
  private timer?: NodeJS.Timeout;
  private prevCpu?: { idle: number; total: number };
  private buffer: MetricSample[] = [];
  private busy = false;

  constructor(private adb: Adb, private maxPoints = 3600) { super(); }

  start(serial: string, pkg: string | undefined, intervalMs: number): void {
    this.pause();
    const tick = async () => {
      if (this.busy) return; // never stack polls on a slow device
      this.busy = true;
      try { const s = await this.sample(serial, pkg); this.buffer.push(s); if (this.buffer.length > this.maxPoints) this.buffer.shift(); this.emit("sample", s); }
      catch (e) { this.emit("error", e); }
      finally { this.busy = false; }
    };
    void tick();
    this.timer = setInterval(tick, intervalMs);
  }
  pause(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  data(): MetricSample[] { return [...this.buffer]; }
  clear(): void { this.buffer = []; this.prevCpu = undefined; }

  async sample(serial: string, pkg?: string): Promise<MetricSample> {
    const limited: string[] = [];
    const s: MetricSample = { ts: Date.now(), limited };
    const sh = (argv: string[]) => this.adb.run(["shell", ...argv], { serial, timeoutMs: 8000 });

    const [bat, stat, df, mem, cpu] = await Promise.all([
      sh(["dumpsys", "battery"]), sh(["cat", "/proc/stat"]), sh(["df", "/data"]),
      pkg ? sh(["dumpsys", "meminfo", pkg]) : Promise.resolve(undefined),
      pkg ? sh(["dumpsys", "cpuinfo"]) : Promise.resolve(undefined),
    ]);

    const b = parseBattery(bat.stdout);
    s.batt_pct = b.level; s.batt_temp_c = b.tempC; s.charging = b.charging;

    const m = stat.stdout.match(/^cpu\s+(.+)$/m);
    if (m) {
      const v = m[1].trim().split(/\s+/).map(Number);
      const idle = v[3] + (v[4] ?? 0), total = v.reduce((a, c) => a + c, 0);
      if (this.prevCpu) {
        const dt = total - this.prevCpu.total, di = idle - this.prevCpu.idle;
        if (dt > 0) s.cpu_sys = Math.round((1 - di / dt) * 1000) / 10;
      }
      this.prevCpu = { idle, total };
    } else limited.push("cpu_sys (/proc/stat not readable on this Android version)");

    const dfLine = df.stdout.split("\n")[1]?.trim().split(/\s+/);
    if (dfLine && dfLine.length >= 4) s.storage_free_kb = Number(dfLine[3]); else limited.push("storage");

    if (pkg) {
      const pss = mem?.stdout.match(/TOTAL(?: PSS)?:?\s+(\d+)/);
      if (pss) s.ram_app_kb = Number(pss[1]); else limited.push("ram_app");
      const c = cpu?.stdout.match(new RegExp(`(\\d+(?:\\.\\d+)?)%\\s+\\d+/${pkg.replace(/\./g, "\\.")}`));
      if (c) s.cpu_app = Number(c[1]); else limited.push("cpu_app (approximate; app may be idle)");
    }
    return s;
  }

  toCsv(): string {
    const cols = ["ts", "cpu_sys", "cpu_app", "ram_app_kb", "storage_free_kb", "batt_pct", "batt_temp_c", "charging"] as const;
    return [cols.join(","), ...this.buffer.map((r) => cols.map((c) => r[c] ?? "").join(","))].join("\n");
  }
}
