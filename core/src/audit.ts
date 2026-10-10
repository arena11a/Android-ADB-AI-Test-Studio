import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Actor, Risk } from "./types.js";

/** Secrets that must never reach logs, audit, or AI. */
const REDACTIONS: Array<[RegExp, string]> = [
  [/(authorization["':= ]+bearer\s+)[A-Za-z0-9._\-+/=]+/gi, "$1[REDACTED]"],
  [/\bbearer\s+[A-Za-z0-9._\-+/=]{16,}/gi, "Bearer [REDACTED]"],
  [/\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/g, "[JWT]"],
  [/((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|session(?:id)?|cookie|set-cookie)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi, "$1[REDACTED]"],
  [/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, "[EMAIL]"],
  [/(?<![\d.])(?:\+?\d{1,3}[\s-]?)?(?:\(?\d{2,4}\)?[\s-]?)\d{3,4}[\s-]?\d{3,4}(?![\d.])/g, "[PHONE]"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[AWS_KEY]"],
];

export function redact(input: string): string {
  let out = input;
  for (const [re, rep] of REDACTIONS) out = out.replace(re, rep);
  return out;
}

/**
 * Exact parameter names whose VALUE must never be persisted: secrets, cookies,
 * and `text` (anything typed on the device may be a password — the approval
 * dialog shows it live, the audit log must not keep it). Exact matching (not
 * substring) so keys like "context" or "texture" stay readable.
 */
const SENSITIVE_KEYS = new Set([
  "password", "passwd", "pwd", "secret", "token", "api_key", "apikey", "access_key",
  "secret_key", "private_key", "cookie", "set-cookie", "set_cookie", "authorization",
  "auth", "credential", "credentials", "text", "key",
]);

export function redactDeep<T>(v: T): T {
  if (typeof v === "string") return redact(v) as unknown as T;
  if (Array.isArray(v)) return v.map(redactDeep) as unknown as T;
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      o[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? "[REDACTED]" : redactDeep(val);
    }
    return o as T;
  }
  return v;
}

export interface AuditEntry {
  ts: string;
  actor: Actor | "system";
  client?: string;
  tool: string;
  params?: unknown;
  risk: Risk;
  decision: string;
  ok: boolean;
  error_code?: string;
  error_msg?: string;
  device?: string;
  session_id?: string;
}
export interface StoredEntry extends AuditEntry { seq: number; prev_hash: string; hash: string }

/**
 * Append-only JSONL with a SHA-256 hash chain. Editing or removing a line
 * breaks the chain, which verify() detects. (It cannot stop someone who
 * deletes the whole file — see SECURITY.md.)
 */
export class AuditLogger extends EventEmitter {
  private seq = 0;
  private lastHash = "GENESIS";
  private file: string;

  /** Folder that holds the audit log (surface so the UI can offer "open folder"). */
  get dir(): string { return this.auditDir; }

  constructor(private auditDir: string) {
    super();
    mkdirSync(this.auditDir, { recursive: true, mode: 0o700 });
    this.file = join(this.auditDir, "audit.jsonl");
    this.loadTail();
  }

  private loadTail(): void {
    if (!existsSync(this.file)) return;
    const lines = readFileSync(this.file, "utf8").split("\n").filter(Boolean);
    const last = lines.at(-1);
    if (last) {
      const e = JSON.parse(last) as StoredEntry;
      this.seq = e.seq;
      this.lastHash = e.hash;
    }
  }

  /** Returns the audit id (sequence number). Emits "entry" for the UI live feed. */
  write(entry: AuditEntry): number {
    const safe: AuditEntry = {
      ...entry,
      params: entry.params === undefined ? undefined : redactDeep(entry.params),
      error_msg: entry.error_msg ? redact(entry.error_msg) : undefined,
    };
    const seq = ++this.seq;
    const body = { seq, ...safe, prev_hash: this.lastHash };
    const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const stored: StoredEntry = { ...body, hash };
    appendFileSync(this.file, JSON.stringify(stored) + "\n", { mode: 0o600 });
    this.lastHash = hash;
    this.emit("entry", stored);
    return seq;
  }

  /** Newest N entries (for the UI log view). */
  tail(limit = 100): StoredEntry[] {
    if (!existsSync(this.file)) return [];
    const lines = readFileSync(this.file, "utf8").split("\n").filter(Boolean);
    return lines.slice(-Math.max(1, Math.min(limit, 1000))).map((l) => JSON.parse(l) as StoredEntry);
  }

  verify(): { ok: boolean; brokenAtSeq?: number } {
    if (!existsSync(this.file)) return { ok: true };
    let prev = "GENESIS";
    for (const line of readFileSync(this.file, "utf8").split("\n").filter(Boolean)) {
      const { hash, ...body } = JSON.parse(line) as StoredEntry;
      const calc = createHash("sha256").update(JSON.stringify(body)).digest("hex");
      if (body.prev_hash !== prev || calc !== hash) return { ok: false, brokenAtSeq: body.seq };
      prev = hash;
    }
    return { ok: true };
  }

  /** Archives the current log and starts a new chain. UI must warn the user first. */
  rotate(): string {
    const archived = join(this.dir, `audit.${Date.now()}.jsonl`);
    if (existsSync(this.file)) renameSync(this.file, archived);
    this.seq = 0;
    this.lastHash = "GENESIS";
    this.write({ ts: new Date().toISOString(), actor: "system", tool: "audit_rotate", risk: "medium", decision: "allow", ok: true, params: { archived } });
    return archived;
  }

  export(format: "json" | "jsonl" | "csv"): string {
    const rows = existsSync(this.file)
      ? readFileSync(this.file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as StoredEntry)
      : [];
    if (format === "jsonl") return rows.map((r) => JSON.stringify(r)).join("\n");
    if (format === "json") return JSON.stringify(rows, null, 2);
    const cols = ["seq", "ts", "actor", "client", "tool", "risk", "decision", "ok", "error_code", "device", "session_id"] as const;
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    return [cols.join(","), ...rows.map((r) => cols.map((c) => esc((r as unknown as Record<string, unknown>)[c])).join(","))].join("\n");
  }
}
