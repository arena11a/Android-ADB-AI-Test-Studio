import path from "node:path";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import type { Session, Step } from "./services/session.js";
import type { ApprovalOutcome, ApprovalRequest } from "./approval.js";

type SqliteCtor = new (file: string) => any;

/** Works both as ESM (dev/tests) and inside the CJS bundle (packaged agent). */
function loadSqlite(): SqliteCtor | null {
  try {
    const req = typeof require === "function" ? require : createRequire(import.meta.url);
    const mod = req("better-sqlite3") as { default?: SqliteCtor } & SqliteCtor;
    return mod.default ?? mod;
  } catch {
    return null;   // missing, or built for a different Node/Electron ABI
  }
}

const MIGRATIONS: Array<{ version: number; sql: string[] }> = [
  {
    version: 1,
    sql: [
      `CREATE TABLE IF NOT EXISTS sessions(
         id TEXT PRIMARY KEY, name TEXT, goal TEXT, device_serial TEXT, target_package TEXT, mode TEXT,
         max_steps INTEGER, max_seconds INTEGER, started_at TEXT, ended_at TEXT, stop_reason TEXT,
         status TEXT, app_version TEXT, requested_by TEXT);`,
      `CREATE TABLE IF NOT EXISTS steps(
         id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, idx INTEGER, tool TEXT,
         params_json TEXT, reason TEXT, result TEXT, error_code TEXT, risk TEXT,
         screenshot_path TEXT, started_at TEXT, ended_at TEXT);`,
      `CREATE TABLE IF NOT EXISTS approvals(
         id TEXT PRIMARY KEY, request_id TEXT, requested_by TEXT, tool TEXT, params_json TEXT,
         risk TEXT, impact TEXT, device TEXT, package TEXT, status TEXT, outcome TEXT,
         created_at TEXT, decided_at TEXT);`,
      `CREATE TABLE IF NOT EXISTS ai_requests(
         id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, client TEXT, tool TEXT,
         params_json TEXT, reason TEXT, risk TEXT, decision TEXT, created_at TEXT);`,
      `CREATE TABLE IF NOT EXISTS metrics(
         id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, device_serial TEXT, ts INTEGER,
         cpu_sys REAL, cpu_app REAL, ram_app_kb INTEGER, storage_free_kb INTEGER,
         batt_pct INTEGER, batt_temp_c REAL, charging INTEGER, jank_pct REAL, net_rx INTEGER, net_tx INTEGER);`,
      `CREATE TABLE IF NOT EXISTS file_ops(
         id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, device_serial TEXT, op TEXT, path TEXT,
         local_path TEXT, size INTEGER, sha256 TEXT, backup_path TEXT, actor TEXT);`,
      `CREATE TABLE IF NOT EXISTS app_ops(
         id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, device_serial TEXT, op TEXT, package TEXT, actor TEXT, ok INTEGER);`,
      `CREATE TABLE IF NOT EXISTS reports(
         id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, format TEXT, path TEXT, created_at TEXT);`,
      `CREATE TABLE IF NOT EXISTS devices(
         serial TEXT PRIMARY KEY, nickname TEXT, model TEXT, manufacturer TEXT,
         android_version TEXT, sdk INTEGER, last_ip TEXT, last_port INTEGER,
         transport TEXT, paired_at TEXT, last_seen TEXT);`,
      `CREATE TABLE IF NOT EXISTS target_apps(
         id INTEGER PRIMARY KEY, package TEXT UNIQUE NOT NULL, label TEXT,
         debuggable INTEGER DEFAULT 0, added_at TEXT NOT NULL);`,
      `CREATE INDEX IF NOT EXISTS idx_steps_session ON steps(session_id, idx);`,
      `CREATE INDEX IF NOT EXISTS idx_metrics_sess ON metrics(session_id, ts);`,
      `CREATE INDEX IF NOT EXISTS idx_approvals_created ON approvals(created_at);`,
    ],
  },
];

/**
 * Optional SQLite store (better-sqlite3, WAL). It is a *query layer on top of*
 * the append-only JSON artifacts — never the system of record — because a
 * native module is not always loadable (packaged app vs. system node ABI).
 * Every method is safe to call when the store is unavailable: it just no-ops.
 */
export class StudioDB {
  private db?: any;

  constructor(file: string) {
    const Ctor = loadSqlite();
    if (!Ctor) return;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      this.db = new Ctor(file);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("busy_timeout = 2000");
      this.db.pragma("foreign_keys = ON");
      this.migrate();
    } catch (e) {
      this.db = undefined;
      console.error("[db] sqlite unavailable, continuing with JSON only:", e instanceof Error ? e.message : e);
    }
  }

  get available(): boolean { return !!this.db; }
  get schemaVersion(): number { return this.db ? (this.db.pragma("user_version", { simple: true }) as number) : 0; }

  private migrate(): void {
    const current = this.schemaVersion;
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      const tx = this.db.transaction((sqls: string[]) => { for (const s of sqls) this.db.exec(s); });
      tx(m.sql);
      this.db.pragma(`user_version = ${m.version}`);
    }
  }

  // ---- sessions & steps -------------------------------------------------
  recordSession(s: Session): void {
    if (!this.db) return;
    this.db.prepare(`INSERT INTO sessions(id,name,goal,device_serial,target_package,mode,max_steps,max_seconds,started_at,ended_at,stop_reason,status,app_version,requested_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET ended_at=excluded.ended_at, stop_reason=excluded.stop_reason, status=excluded.status`)
      .run(s.id, s.name, s.goal ?? null, s.device, s.package, "manual", s.maxSteps, s.maxSeconds, s.startedAt,
        s.endedAt ?? null, s.stopReason ?? null, s.status, s.appVersion ?? null, "user");
  }

  recordStep(sessionId: string, step: Step): void {
    if (!this.db) return;
    this.db.prepare(`INSERT INTO steps(session_id,idx,tool,params_json,reason,result,error_code,risk,screenshot_path,started_at,ended_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(sessionId, step.idx, step.tool, JSON.stringify(step.params), step.reason ?? null, step.result,
        step.error_code ?? null, step.risk, step.screenshot ?? null, step.ts, new Date().toISOString());
  }

  sessions(limit = 50): Array<Record<string, unknown>> {
    if (!this.db) return [];
    return this.db.prepare(`SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?`).all(limit);
  }
  steps(sessionId: string): Array<Record<string, unknown>> {
    if (!this.db) return [];
    return this.db.prepare(`SELECT * FROM steps WHERE session_id = ? ORDER BY idx`).all(sessionId);
  }

  // ---- approvals --------------------------------------------------------
  recordApproval(r: ApprovalRequest, outcome?: ApprovalOutcome): void {
    if (!this.db) return;
    this.db.prepare(`INSERT INTO approvals(id,requested_by,tool,params_json,risk,impact,device,package,status,outcome,created_at,decided_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, outcome=excluded.outcome, decided_at=excluded.decided_at`)
      .run(r.id, r.requestedBy, r.tool, JSON.stringify(r.params), r.risk, r.impact, r.device ?? null, r.package ?? null,
        outcome ? "decided" : "pending", outcome ?? null, new Date(r.createdAt).toISOString(), outcome ? new Date().toISOString() : null);
  }

  approvals(limit = 100): Array<Record<string, unknown>> {
    if (!this.db) return [];
    return this.db.prepare(`SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?`).all(limit);
  }

  // ---- metrics ----------------------------------------------------------
  recordMetric(sample: Record<string, unknown>, sessionId?: string, device?: string): void {
    if (!this.db) return;
    this.db.prepare(`INSERT INTO metrics(session_id,device_serial,ts,cpu_sys,cpu_app,ram_app_kb,storage_free_kb,batt_pct,batt_temp_c,charging)
      VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(sessionId ?? null, device ?? null, sample.ts, sample.cpu_sys ?? null, sample.cpu_app ?? null,
        sample.ram_app_kb ?? null, sample.storage_free_kb ?? null, sample.batt_pct ?? null,
        sample.batt_temp_c ?? null, sample.charging ? 1 : 0);
  }

  metrics(sessionId?: string, limit = 500): Array<Record<string, unknown>> {
    if (!this.db) return [];
    return sessionId
      ? this.db.prepare(`SELECT * FROM metrics WHERE session_id = ? ORDER BY ts DESC LIMIT ?`).all(sessionId, limit)
      : this.db.prepare(`SELECT * FROM metrics ORDER BY ts DESC LIMIT ?`).all(limit);
  }

  // ---- ops --------------------------------------------------------------
  recordAppOp(op: string, pkg: string, device: string, ok: boolean): void {
    if (!this.db) return;
    this.db.prepare(`INSERT INTO app_ops(ts,device_serial,op,package,actor,ok) VALUES(?,?,?,?,?,?)`)
      .run(new Date().toISOString(), device, op, pkg, "user", ok ? 1 : 0);
  }

  recordFileOp(op: string, remote: string, local: string | undefined, size: number, sha: string, backup: string | undefined, device: string): void {
    if (!this.db) return;
    this.db.prepare(`INSERT INTO file_ops(ts,device_serial,op,path,local_path,size,sha256,backup_path,actor) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(new Date().toISOString(), device, op, remote, local ?? null, size, sha, backup ?? null, "user");
  }

  recordReport(sessionId: string, format: string, file: string): void {
    if (!this.db) return;
    this.db.prepare(`INSERT INTO reports(session_id,format,path,created_at) VALUES(?,?,?,?)`)
      .run(sessionId, format, file, new Date().toISOString());
  }

  // ---- misc -------------------------------------------------------------
  stats(): Record<string, number> {
    if (!this.db) return {};
    const out: Record<string, number> = {};
    for (const t of ["sessions", "steps", "approvals", "metrics", "file_ops", "app_ops", "reports"]) {
      out[t] = this.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    }
    return out;
  }

  close(): void { try { this.db?.close(); } catch { /* ignore */ } }
}
