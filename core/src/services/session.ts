import { EventEmitter } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { StudioError, type Risk } from "../types.js";
import type { PolicyFile } from "../types.js";

export type StepResult = "success" | "failed" | "blocked" | "needs_approval" | "denied" | "dry_run";
export interface Step {
  idx: number; tool: string; params: unknown; reason?: string; result: StepResult;
  error_code?: string; screenshot?: string; ui_dump?: string; ts: string; risk: Risk;
}
export interface Session {
  id: string; name: string; goal?: string; device: string; package: string;
  startedAt: string; endedAt?: string; stopReason?: string; status: "running" | "stopped";
  maxSteps: number; maxSeconds: number; steps: Step[]; crashes: string[]; anrs: string[];
  approvals: { approved: number; denied: number }; appVersion?: string; dir: string;
}

/** Limits and stop-conditions. A session never outlives its step/time budget. */
export class SessionManager extends EventEmitter {
  private current?: Session;
  private timer?: NodeJS.Timeout;
  private lastSig = "";
  private sameCount = 0;

  constructor(private root: string, private policy: () => PolicyFile) { super(); }

  get active(): Session | undefined { return this.current; }
  /** Root folder where session artifacts (screenshots, session.json) live. */
  get sessionsDir(): string { return this.root; }

  start(p: { name: string; goal?: string; device: string; package: string; maxSteps?: number; maxSeconds?: number; appVersion?: string }): Session {
    if (this.current?.status === "running") throw new StudioError("SESSION_LIMIT", "A session is already running");
    const pol = this.policy().session;
    const id = randomUUID().slice(0, 8);
    const dir = path.join(this.root, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const s: Session = {
      id, name: p.name, goal: p.goal, device: p.device, package: p.package, startedAt: new Date().toISOString(), status: "running",
      maxSteps: Math.min(p.maxSteps ?? pol.defaultMaxSteps, 1000), maxSeconds: Math.min(p.maxSeconds ?? pol.defaultMaxSeconds, pol.aiSessionMaxSeconds),
      steps: [], crashes: [], anrs: [], approvals: { approved: 0, denied: 0 }, appVersion: p.appVersion, dir,
    };
    this.current = s; this.lastSig = ""; this.sameCount = 0;
    this.timer = setTimeout(() => this.stop("time_limit"), s.maxSeconds * 1000);
    this.emit("started", s);
    return s;
  }

  /** Called by the router after every action. Returns a stop reason if the budget is exhausted. */
  record(step: Omit<Step, "idx" | "ts">, screen?: Buffer): Step {
    const s = this.requireActive();
    const idx = s.steps.length + 1;
    const full: Step = { ...step, idx, ts: new Date().toISOString() };
    if (screen && this.policy().privacy.recordScreenshots) {
      const f = path.join(s.dir, `step-${String(idx).padStart(3, "0")}.png`);
      writeFileSync(f, screen); full.screenshot = f;
      // "no progress" detection: identical screen N times in a row
      const sig = createHash("sha1").update(screen).digest("hex");
      this.sameCount = sig === this.lastSig ? this.sameCount + 1 : 0;
      this.lastSig = sig;
      if (this.sameCount >= this.policy().rateLimits.sameScreenRetries) { s.steps.push(full); return this.stopWith(full, "no_progress"); }
    }
    s.steps.push(full);
    if (s.steps.length >= s.maxSteps) return this.stopWith(full, "max_steps");
    return full;
  }

  private stopWith(step: Step, reason: string): Step { this.stop(reason); return step; }

  noteApproval(outcome: "approved" | "denied"): void {
    if (this.current?.status === "running") this.current.approvals[outcome]++;
  }

  noteCrash(line: string): void {
    const s = this.current; if (!s || s.status !== "running") return;
    s.crashes.push(line);
    if (this.policy().session.stopOnCrash) this.stop("crash");
  }
  noteAnr(line: string): void {
    const s = this.current; if (!s || s.status !== "running") return;
    s.anrs.push(line);
    if (this.policy().session.stopOnAnr) this.stop("anr");
  }
  noteLeftTarget(fg: string): void {
    if (this.policy().session.stopWhenLeavingTarget && this.current?.status === "running") this.stop(`left_target:${fg}`);
  }

  stop(reason = "user"): Session | undefined {
    const s = this.current;
    if (!s || s.status !== "running") return s;
    clearTimeout(this.timer);
    s.status = "stopped"; s.stopReason = reason; s.endedAt = new Date().toISOString();
    writeFileSync(path.join(s.dir, "session.json"), JSON.stringify(s, null, 2), { mode: 0o600 });
    this.emit("stopped", s);
    return s;
  }

  private requireActive(): Session {
    if (!this.current || this.current.status !== "running") throw new StudioError("SESSION_LIMIT", "No running session");
    return this.current;
  }
}
