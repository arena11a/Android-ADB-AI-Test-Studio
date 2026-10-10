import WebSocket from "ws";
import type { ControlEvent } from "../shared/types.js";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/**
 * Speaks the agent's control-plane protocol: `{id, method, params}` in,
 * `{id, result|error}` out, plus server-pushed `{event, data}` frames.
 * The main process holds the only socket — the renderer goes through IPC.
 */
export class ControlClient {
  private ws?: WebSocket;
  private token = "";
  private url = "";
  private next = 1;
  private pending = new Map<number, Pending>();

  constructor(private onEvent: (e: ControlEvent) => void, private onState: (connected: boolean) => void) {}

  get connected(): boolean { return this.ws?.readyState === 1; }

  async connect(url: string, token: string): Promise<void> {
    this.disconnect();
    this.url = url; this.token = token;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
      const timer = setTimeout(() => { reject(new Error("control socket did not open within 15s")); try { ws.terminate(); } catch { /* ignore */ } }, 15_000);
      ws.once("open", () => { clearTimeout(timer); this.onState(true); resolve(); });
      ws.once("error", (e) => { clearTimeout(timer); this.onState(false); reject(e); });
      ws.on("message", (raw) => this.onMessage(String(raw)));
      ws.on("close", () => { this.onState(false); this.failPending("control socket closed"); });
      ws.on("error", () => { this.onState(false); });
      this.ws = ws;
    });
  }

  private onMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw); } catch { return; }
    if (typeof msg.event === "string") return this.onEvent(msg as unknown as ControlEvent);
    const id = msg.id as number;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (msg.error) {
      const e = msg.error as { code?: string; message?: string };
      const err = new Error(e.message ?? "control error");
      (err as Error & { code?: string }).code = e.code;
      p.reject(err);
    } else p.resolve(msg.result);
  }

  async call(method: string, params: Record<string, unknown> = {}, timeoutMs = 600_000): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== 1) throw new Error("agent is not connected");
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`'${method}' timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ id, method, params }), (err) => {
        if (err) { clearTimeout(timer); this.pending.delete(id); reject(err); }
      });
    });
  }

  private failPending(reason: string): void {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    this.pending.clear();
  }

  disconnect(): void {
    if (!this.ws) return;
    this.failPending("control socket closed");
    try { this.ws.close(); } catch { /* ignore */ }
    this.ws = undefined;
  }

  get endpoints(): { url: string; token: string } { return { url: this.url, token: this.token }; }
}
