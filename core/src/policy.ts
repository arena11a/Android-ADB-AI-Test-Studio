import path from "node:path";
import type { Actor, Decision, Mode, PolicyFile, Risk, ToolDef, ToolRequest } from "./types.js";

const READ_ONLY_SAFE = new Set(["device_list", "device_info", "app_list"]);
const OBSERVE_EXTRA = new Set(["screenshot", "ui_hierarchy", "logs_read", "metrics_read", "report_create", "session_stop"]);
const INPUT_TOOLS = new Set(["tap", "swipe", "type_text", "press_key"]);
/**
 * Read-only diagnostics an AI may run in `repair` mode to help diagnose a broken
 * or infected device. Anything that *changes* the device is never in this list.
 */
const REPAIR_READ_TOOLS = new Set([
  "device_list", "device_info", "app_list", "app_permissions", "device_admins",
  "security_scan", "logs_read", "metrics_read", "screenshot", "ui_hierarchy", "session_stop", "report_create",
]);
/** Tools only a human may run, and only in `bootloader` mode with advancedMode on. */
const BOOTLOADER_TOOLS = new Set([
  "boot_reboot_target", "fastboot_info", "fastboot_reboot", "fastboot_unlock", "fastboot_lock", "adb_sideload",
]);
/** of those, the ones that change state — the read-only ones stay read-only */
const BOOTLOADER_MUTATING = new Set(["boot_reboot_target", "fastboot_reboot", "fastboot_unlock", "fastboot_lock", "adb_sideload"]); // NOSONAR
/** Every mutating action available in `repair` mode — all are asked, never silent. */
const REPAIR_ACTIONS = new Set(["app_disable", "app_revoke", "app_uninstall", "app_clear_data", "app_force_stop"]);
const FEATURE_OF: Record<string, keyof PolicyFile["features"]> = {
  file_list: "files", file_pull: "files", file_push: "files", file_delete: "delete",
  app_install: "install", app_uninstall: "install", app_clear_data: "delete",
  tap: "input", swipe: "input", type_text: "input", press_key: "input",
  power_request_reboot: "power",
};
const ROLE_MAX: Record<PolicyFile["role"], Risk[]> = {
  viewer: ["low"],
  tester: ["low", "medium", "high"],
  admin: ["low", "medium", "high", "critical"],
};

/** Sliding-window counter. */
class Window {
  private hits: number[] = [];
  constructor(private ms: number, private max: number) {}
  tryHit(now = Date.now()): boolean {
    this.hits = this.hits.filter((t) => now - t < this.ms);
    if (this.hits.length >= this.max) return false;
    this.hits.push(now);
    return true;
  }
}

export class PolicyEngine {
  private calls: Window;
  private inSec: Window;
  private inMin: Window;
  private installs: Window;
  private deletes = new Map<string, number>();
  private denials: number[] = [];
  public onAnomaly?: (msg: string) => void;

  constructor(public policy: PolicyFile) {
    this.calls = new Window(60_000, policy.rateLimits.toolCallsPerMinute);
    this.inSec = new Window(1_000, policy.rateLimits.inputPerSecond);
    this.inMin = new Window(60_000, policy.rateLimits.inputPerMinute);
    this.installs = new Window(3_600_000, policy.rateLimits.installsPerHour);
  }

  setMode(mode: Mode): void { this.policy.mode = mode; }
  /** Safe Mode = back to safe with every risky feature off. */
  enterSafeMode(): void {
    this.policy.mode = "safe";
    this.policy.features = { files: false, install: false, delete: false, input: false, power: false, advancedMode: false, liveView: false, repair: false, bootloader: false };
  }

  isTarget(pkg: string | undefined): boolean {
    return !!pkg && this.policy.targetPackages.includes(pkg);
  }

  /** Decide allow / ask / deny. Order matches PLAN.md §8. Does not touch the device. */
  evaluate(def: ToolDef | undefined, req: ToolRequest, parsed: Record<string, unknown>): Decision {
    const p = this.policy;
    const deny = (code: NonNullable<Decision["code"]>, message: string, risk: Risk = def?.risk ?? "forbidden"): Decision => {
      this.noteDenial(req);
      return { kind: "deny", risk, code, message };
    };

    if (!def) return deny("POLICY_DENIED", `Unknown tool '${req.tool}' — only registered tools are allowed`, "forbidden");
    if (p.forbiddenTools.includes(def.name)) return deny("POLICY_DENIED", "Tool is forbidden by policy");
    if (req.actor === "ai" && p.ai.requireReason && def.mutates && !req.reason)
      return deny("INVALID_PARAMS", "AI must give a reason for state-changing requests");

    // mode gate
    if (!this.modeAllows(p.mode, def, req.actor))
      return deny("POLICY_DENIED", `Mode '${p.mode}' does not allow '${def.name}'`);

    // feature flag
    const feat = FEATURE_OF[def.name];
    if (feat && !p.features[feat]) return deny("POLICY_DENIED", `Feature '${feat}' is disabled in settings`);

    // role
    if (!ROLE_MAX[p.role].includes(def.risk)) return deny("POLICY_DENIED", `Role '${p.role}' cannot run ${def.risk}-risk tools`);

    // hard rule: no AI may run a bootloader tool, in any mode, ever
    if (BOOTLOADER_TOOLS.has(def.name) && req.actor === "ai")
      return deny("POLICY_DENIED", "Bootloader tools are human-only — an AI can never run them");

    // repair/bootloader require the matching feature (advanced human setup)
    if (BOOTLOADER_TOOLS.has(def.name) && !p.features.bootloader)
      return deny("POLICY_DENIED", "Bootloader feature is disabled — enable it in Settings (Advanced)");
    if (def.category === "security" && REPAIR_ACTIONS.has(def.name) && !p.features.repair)
      return deny("POLICY_DENIED", "Repair feature is disabled — enable it in Settings (Advanced)");

    // critical extras
    if (def.name === "power_request_reboot") {
      const mode = parsed.mode as string | undefined;
      if (mode && mode !== "normal" && (!p.features.advancedMode || req.actor === "ai"))
        return deny("POLICY_DENIED", "bootloader/recovery needs Advanced Mode and a human request");
    }

    // scope
    const pkg = parsed.package as string | undefined;
    if (pkg !== undefined && !this.isTarget(pkg) && def.category !== "metrics")
      return deny("OUT_OF_SCOPE", `Package '${pkg}' is not a target app`);
    if (def.name === "session_start" && !this.isTarget(pkg)) return deny("OUT_OF_SCOPE", "Session package must be a target app");

    // paths (remote)
    for (const k of ["path", "remote"]) {
      const v = parsed[k];
      if (typeof v === "string") {
        const why = this.checkRemotePath(v);
        if (why) return deny("PATH_FORBIDDEN", why);
      }
    }

    // raw coordinates
    if (def.name === "tap" && req.actor === "ai" && !parsed.selector && !p.ai.allowRawCoordinates)
      return deny("POLICY_DENIED", "Raw coordinates are disabled for AI — use a selector");

    // rate limits
    if (!this.calls.tryHit()) return deny("RATE_LIMITED", "Too many tool calls per minute");
    if (INPUT_TOOLS.has(def.name) && !(this.inSec.tryHit() && this.inMin.tryHit())) return deny("RATE_LIMITED", "Input rate limit exceeded");
    if (def.name === "app_install" && !this.installs.tryHit()) return deny("RATE_LIMITED", "Install quota per hour exceeded");
    if (def.name === "file_delete") {
      const n = (this.deletes.get(req.sessionId ?? "-") ?? 0) + 1;
      if (n > p.rateLimits.deletesPerSession) return deny("RATE_LIMITED", "Delete quota for this session exceeded");
      this.deletes.set(req.sessionId ?? "-", n);
      if (n >= p.anomaly.massDeleteThreshold) this.onAnomaly?.(`Many deletes requested (${n}) in one session`);
    }

    if (req.params && (req.params as { dry_run?: boolean }).dry_run) return { kind: "dry_run", risk: def.risk };

    // final: ask or allow
    const mustAsk =
      def.risk === "high" || def.risk === "critical" ||
      p.alwaysApprove.includes(def.name) ||
      BOOTLOADER_MUTATING.has(def.name) ||
      REPAIR_ACTIONS.has(def.name) ||
      (p.mode === "approve_all" && def.mutates) ||
      (p.mode === "automation" && req.actor === "ai" && def.risk !== "low" && def.risk !== "medium");
    return { kind: mustAsk ? "ask" : "allow", risk: def.risk };
  }

  private modeAllows(mode: Mode, def: ToolDef, actor: Actor): boolean {
    switch (mode) {
      case "safe": return READ_ONLY_SAFE.has(def.name);
      case "observe": return READ_ONLY_SAFE.has(def.name) || OBSERVE_EXTRA.has(def.name);
      case "plan_only": return actor === "user" ? true : READ_ONLY_SAFE.has(def.name) || OBSERVE_EXTRA.has(def.name);
      case "automation":
        // AI: low/medium only, in scope. High/critical are asked (never silently allowed).
        return actor === "user" || def.risk !== "critical";
      case "develop":
      case "approve_all":
        return true;
      case "repair":
        // Only what the `repair` feature unlocks: the AI may read diagnostics or
        // *request* a fix (which becomes an approval request); it may never run
        // installs, file writes, input or anything else from this mode.
        if (!this.policy.features.repair) return false;
        if (BOOTLOADER_TOOLS.has(def.name)) return false;      // never mixed with repair
        if (actor === "user") return true;
        return REPAIR_READ_TOOLS.has(def.name) || REPAIR_ACTIONS.has(def.name);
      case "bootloader":
        // Humans only. An AI can never even enter here — there is no tool to switch
        // modes, and any bootloader tool from an AI is denied below regardless.
        if (!this.policy.features.bootloader) return false;
        return actor === "user" && BOOTLOADER_TOOLS.has(def.name);
    }
  }

  /** `bootloader`/`repair` modes are dangerous: entering them needs a typed word from the human. */
  confirmWord(mode: Mode): string | null {
    if (mode === "bootloader") return "BOOTLOADER";
    if (mode === "repair") return "REPAIR";
    return null;
  }

  /** Returns a reason string if the device path is not allowed, else null. */
  checkRemotePath(p0: string): string | null {
    const norm = path.posix.normalize(p0);
    if (p0.includes("..") || p0.includes("\0")) return "Path traversal is not allowed";
    for (const d of this.policy.files.deny) if (norm === d || norm.startsWith(d + "/")) return `Path is under forbidden area '${d}'`;
    const allowed = this.policy.files.allow.flatMap((a) =>
      a.includes("{target}") ? this.policy.targetPackages.map((t) => a.replace("{target}", t)) : [a]);
    if (!allowed.some((a) => norm === a || norm.startsWith(a + "/"))) return "Path is outside the allowed folders";
    return null;
  }

  private noteDenial(req: ToolRequest): void {
    const now = Date.now();
    const a = this.policy.anomaly;
    this.denials = this.denials.filter((t) => now - t < a.forbiddenWindowSeconds * 1000);
    this.denials.push(now);
    if (req.actor === "ai" && this.denials.length >= a.forbiddenRepeatThreshold) {
      this.onAnomaly?.(`AI repeatedly attempted blocked actions (${this.denials.length} in ${a.forbiddenWindowSeconds}s), last: ${req.tool}`);
      if (a.autoSafeModeOnAnomaly) this.enterSafeMode();
    }
  }
}
