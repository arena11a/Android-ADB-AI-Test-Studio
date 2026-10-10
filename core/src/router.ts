import { TOOL_MAP } from "./tools.js";
import { StudioError, type ErrorCode, type Risk, type ToolRequest, type ToolResult } from "./types.js";
import type { PolicyEngine } from "./policy.js";
import type { AuditLogger } from "./audit.js";
import type { ApprovalQueue } from "./approval.js";
import type { KillSwitch } from "./killswitch.js";

export type Handler = (params: Record<string, unknown>, ctx: { req: ToolRequest; signal: AbortSignal }) => Promise<unknown>;

/**
 * Single entry point for every action (UI and AI alike):
 *   kill switch → schema → policy → (approval) → per-device queue → handler → audit
 * Nothing reaches ADB without passing through here.
 */
export class ToolRouter {
  private handlers = new Map<string, Handler>();
  private queues = new Map<string, Promise<unknown>>();

  constructor(
    private policy: PolicyEngine,
    private audit: AuditLogger,
    private approvals: ApprovalQueue,
    private kill: KillSwitch,
  ) {}

  register(tool: string, h: Handler): void {
    if (!TOOL_MAP.has(tool)) throw new Error(`No tool definition for '${tool}'`);
    this.handlers.set(tool, h);
  }

  async call(req: ToolRequest): Promise<ToolResult> {
    const def = TOOL_MAP.get(req.tool);
    const base = { ts: new Date().toISOString(), actor: req.actor, client: req.client, tool: req.tool, session_id: req.sessionId };
    const fail = (code: ErrorCode, message: string, risk: Risk, decision: string, params?: unknown, device?: string): ToolResult => {
      const audit_id = this.audit.write({ ...base, params, risk, decision, ok: false, error_code: code, error_msg: message, device });
      return { ok: false, error: { code, message }, risk, audit_id };
    };

    if (this.kill.active) return fail("KILL_SWITCH", "Kill switch is active — a human must release it", def?.risk ?? "forbidden", "deny");

    // 1) schema
    let parsed: Record<string, unknown> = {};
    if (def) {
      const r = def.schema.safeParse(req.params ?? {});
      if (!r.success) return fail("INVALID_PARAMS", r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), def.risk, "deny", req.params);
      parsed = r.data as Record<string, unknown>;
    }
    const device = parsed.device as string | undefined;

    // 2) policy
    const decision = this.policy.evaluate(def, req, parsed);
    if (decision.kind === "deny") return fail(decision.code ?? "POLICY_DENIED", decision.message ?? "Denied", decision.risk, "deny", parsed, device);
    if (decision.kind === "dry_run") {
      const audit_id = this.audit.write({ ...base, params: parsed, risk: decision.risk, decision: "dry_run", ok: true, device });
      return { ok: true, data: { would_run: req.tool, params: parsed }, risk: decision.risk, audit_id, dry_run: true };
    }

    // 3) approval
    let decisionLabel = "allow";
    if (decision.kind === "ask") {
      const { outcome } = this.approvals.request(
        {
          requestedBy: req.actor, client: req.client, tool: req.tool, params: parsed, reason: req.reason,
          risk: decision.risk, impact: def!.description, device, package: parsed.package as string | undefined,
          typedConfirm: decision.risk === "critical" ? "ยืนยัน" : undefined,
        },
        this.policy.policy.approval.ttlSeconds,
      );
      const result = await outcome;
      if (result !== "approved") {
        const code: ErrorCode = result === "expired" ? "APPROVAL_EXPIRED" : "APPROVAL_DENIED";
        return fail(code, `Request ${result}`, decision.risk, result, parsed, device);
      }
      if (this.kill.active) return fail("KILL_SWITCH", "Kill switch triggered while waiting", decision.risk, "deny", parsed, device);
      decisionLabel = "approved";
    }

    // 4) execute (serialised per device so commands never collide)
    const handler = this.handlers.get(req.tool);
    if (!handler) return fail("UNSUPPORTED", `No handler for '${req.tool}'`, decision.risk, decisionLabel, parsed, device);
    try {
      const data = await this.enqueue(device ?? "_", () => handler(parsed, { req, signal: this.kill.signal }));
      const audit_id = this.audit.write({ ...base, params: parsed, risk: decision.risk, decision: decisionLabel, ok: true, device });
      return { ok: true, data, risk: decision.risk, audit_id };
    } catch (e) {
      const code = e instanceof StudioError ? e.code : "INTERNAL";
      return fail(code, e instanceof Error ? e.message : String(e), decision.risk, decisionLabel, parsed, device);
    }
  }

  private enqueue<T>(key: string, job: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(job);
    this.queues.set(key, next);
    return next;
  }
}
