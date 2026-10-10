import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

/**
 * Global emergency stop. Once triggered, every new request is rejected and
 * all tracked child processes are killed. Only a human (UI) can release it —
 * there is intentionally no tool that does this.
 */
export class KillSwitch extends EventEmitter {
  private _active = false;
  private children = new Set<ChildProcess>();
  private abort = new AbortController();

  get active(): boolean { return this._active; }
  get signal(): AbortSignal { return this.abort.signal; }

  track(child: ChildProcess): void {
    if (this._active) { child.kill("SIGKILL"); return; }
    this.children.add(child);
    child.once("exit", () => this.children.delete(child));
  }

  trigger(source: string): void {
    if (this._active) return;
    this._active = true;           // set synchronously before anything else
    this.abort.abort();
    for (const c of this.children) {
      try { c.kill("SIGKILL"); } catch { /* already gone */ }
    }
    this.children.clear();
    this.emit("triggered", source);
  }

  /** Human-only. Callers must be the UI IPC handler, never the tool router. */
  release(): void {
    this._active = false;
    this.abort = new AbortController();
    this.emit("released");
  }

  /**
   * Kill tracked children WITHOUT latching the emergency stop — used when the
   * agent process itself shuts down (e.g. logcat would otherwise keep running).
   */
  terminate(): void {
    for (const c of this.children) {
      try { c.kill("SIGKILL"); } catch { /* already gone */ }
    }
    this.children.clear();
  }
}
