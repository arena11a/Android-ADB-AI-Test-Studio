import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PolicyEngine } from "../../core/src/policy.js";
import { TOOL_MAP } from "../../core/src/tools.js";
import { AuditLogger, redact } from "../../core/src/audit.js";
import { parseUiHierarchy, parseForegroundPackage } from "../../core/src/adb.js";
import type { PolicyFile, ToolRequest } from "../../core/src/types.js";

const base = (): PolicyFile => JSON.parse(readFileSync("config/policy.default.json", "utf8"));
const eng = (o: Partial<PolicyFile> = {}) => new PolicyEngine({ ...base(), targetPackages: ["com.example.app"], ...o });
const ev = (e: PolicyEngine, tool: string, params: Record<string, unknown> = {}, actor: "ai" | "user" = "ai") => {
  const req: ToolRequest = { tool, params, actor, reason: "test" };
  const def = TOOL_MAP.get(tool);
  const parsed = def ? (def.schema.parse(params) as Record<string, unknown>) : params;
  return e.evaluate(def, req, parsed);
};
const dev = (e: PolicyEngine, f: Partial<PolicyFile["features"]>) => { Object.assign(e.policy.features, f); return e; };

describe("advanced modes (repair / bootloader)", () => {
  const enable = (mode: string, feats: Record<string, boolean> = {}) =>
    new PolicyEngine({ ...base(), mode: mode as never, role: "admin", targetPackages: ["com.example.app"],
      features: { files: true, install: true, delete: true, input: true, power: true, advancedMode: true, liveView: true, repair: true, bootloader: true, ...feats } });

  it("repair mode: the AI may read diagnostics but never act", () => {
    const e = enable("repair");
    expect(ev(e, "security_scan", {}, "ai").kind).toBe("allow");
    expect(ev(e, "device_admins", {}, "ai").kind).toBe("allow");
    expect(ev(e, "app_permissions", { package: "com.example.app" }, "ai").kind).toBe("allow");
    for (const [tool, params] of [
      ["app_disable", { package: "com.example.app" }],
      ["app_revoke", { package: "com.example.app", permission: "android.permission.READ_SMS" }],
      ["app_uninstall", { package: "com.example.app" }],
      ["app_clear_data", { package: "com.example.app" }],
    ] as Array<[string, Record<string, unknown>]>) {
      const d = ev(e, tool, params, "ai");
      expect(d.kind, tool).toBe("ask");   // AI never silently changes the device
    }
  });

  it("repair mode: a human acts only after approval", () => {
    const e = enable("repair");
    expect(ev(e, "app_disable", { package: "com.example.app" }, "user").kind).toBe("ask");
    expect(ev(e, "app_force_stop", { package: "com.example.app" }, "user").kind).toBe("ask");
  });

  it("bootloader mode: AI is denied every tool, in every mode", () => {
    for (const mode of ["safe", "observe", "develop", "automation", "approve_all", "plan_only", "repair", "bootloader"]) {
      const e = enable(mode);
      for (const tool of ["boot_reboot_target", "fastboot_info", "fastboot_reboot", "fastboot_unlock", "adb_sideload"]) {
        const params = tool === "boot_reboot_target" ? { target: "bootloader" } : tool === "fastboot_reboot" ? { to: "system" }
          : tool === "fastboot_unlock" ? { expect: "WIPE-ALL-DATA" } : tool === "adb_sideload" ? { zip: "/x.zip", expect: "SIDELOAD" } : { sub: "devices" };
        const d = ev(e, tool, params, "ai");
        expect(`${d.kind}:${d.code ?? ""}`, `${mode}/${tool}`).toMatch(/deny:POLICY_DENIED/);
      }
    }
  });

  it("bootloader mode: a human gets an approval request, not a silent run", () => {
    const e = enable("bootloader");
    expect(ev(e, "fastboot_info", { sub: "devices" }, "user").kind).toBe("allow");   // read-only stays read-only
    for (const tool of ["boot_reboot_target", "fastboot_reboot", "fastboot_unlock", "adb_sideload"]) {
      const params = tool === "boot_reboot_target" ? { target: "bootloader" } : tool === "fastboot_reboot" ? { to: "system" }
        : tool === "fastboot_unlock" ? { expect: "WIPE-ALL-DATA" } : { zip: "/x.zip", expect: "SIDELOAD" };
      expect(ev(e, tool, params, "user").kind, tool).toBe("ask");
    }
  });

  it("bootloader tools are refused while the feature is off", () => {
    const e = enable("bootloader", { bootloader: false });
    expect(ev(e, "fastboot_reboot", { to: "system" }, "user").kind).toBe("deny");
    const r = enable("repair", { repair: false });
    expect(ev(r, "app_disable", { package: "com.example.app" }, "user").kind).toBe("deny");
  });

  it("both modes require the typed confirmation word", () => {
    expect(enable("repair").confirmWord("repair")).toBe("ซ่อม");
    expect(enable("bootloader").confirmWord("bootloader")).toBe("BOOTLOADER");
    expect(enable("develop").confirmWord("develop")).toBeNull();
  });

  it("safe mode never exposes the new tools", () => {
    const e = enable("safe");
    expect(ev(e, "security_scan", {}, "user").kind).toBe("deny");
    expect(ev(e, "fastboot_info", { sub: "devices" }, "user").kind).toBe("deny");
  });
});

describe("policy", () => {
  it("unknown / raw shell tools are denied", () => {
    expect(ev(eng(), "raw_shell").kind).toBe("deny");
    expect(ev(eng(), "adb_shell", { cmd: "id" }).kind).toBe("deny");
  });
  it("safe mode allows read-only only", () => {
    expect(ev(eng(), "device_list").kind).toBe("allow");
    expect(ev(eng(), "screenshot").kind).toBe("deny");
    expect(ev(eng(), "tap", { selector: { text: "x" } }).kind).toBe("deny");
  });
  it("uninstall of non-target / system app is out of scope", () => {
    const e = dev(eng({ mode: "develop" }), { install: true });
    const d = ev(e, "app_uninstall", { package: "com.android.settings" });
    expect(d.kind).toBe("deny"); expect(d.code).toBe("OUT_OF_SCOPE");
  });
  it("install of target needs approval", () => {
    const e = dev(eng({ mode: "develop" }), { install: true });
    expect(ev(e, "app_install", { apk_path: "/tmp/a.apk" }).kind).toBe("ask");
  });
  it("blocks system paths and traversal", () => {
    const e = dev(eng({ mode: "develop" }), { files: true });
    for (const p of ["/system/build.prop", "/data/data/other.app/x", "/sdcard/Download/adbstudio/../../DCIM", "/sdcard/DCIM"]) {
      const d = ev(e, "file_list", { path: p }, "user"); // user actor: AI repeats would (correctly) trip auto Safe Mode
      expect(d.kind, p).toBe("deny"); expect(d.code, p).toBe("PATH_FORBIDDEN");
    }
    expect(ev(e, "file_list", { path: "/data/local/tmp/adbstudio/x" }).kind).toBe("allow");
  });
  it("reboot disabled by default; critical needs ask when enabled", () => {
    expect(ev(eng({ mode: "develop", role: "admin" }), "power_request_reboot").kind).toBe("deny");
    const e = dev(eng({ mode: "develop", role: "admin" }), { power: true });
    expect(ev(e, "power_request_reboot").kind).toBe("ask");
  });
  it("AI can never request bootloader/recovery", () => {
    const e = dev(eng({ mode: "develop", role: "admin" }), { power: true, advancedMode: true });
    expect(ev(e, "power_request_reboot", { mode: "bootloader" }, "ai").kind).toBe("deny");
  });
  it("AI raw coordinates denied by default", () => {
    const e = dev(eng({ mode: "develop" }), { input: true });
    expect(ev(e, "tap", { x: 1, y: 2 }).kind).toBe("deny");
    expect(ev(e, "tap", { selector: { text: "OK" } }).kind).toBe("allow");
  });
  it("AI must give a reason for mutating calls", () => {
    const e = dev(eng({ mode: "develop" }), { input: true });
    const def = TOOL_MAP.get("press_key")!;
    const d = e.evaluate(def, { tool: "press_key", params: {}, actor: "ai" }, { key: "BACK" });
    expect(d.kind).toBe("deny");
  });
  it("repeated forbidden attempts trigger safe mode", () => {
    const e = dev(eng({ mode: "develop" }), { input: true });
    let msg = ""; e.onAnomaly = (m) => (msg = m);
    for (let i = 0; i < 3; i++) ev(e, "raw_shell");
    expect(msg).toMatch(/repeatedly/); expect(e.policy.mode).toBe("safe");
  });
  it("input rate limit", () => {
    const e = dev(eng({ mode: "develop" }), { input: true });
    const r = Array.from({ length: 8 }, () => ev(e, "press_key", { key: "BACK" }));
    expect(r.some((d) => d.code === "RATE_LIMITED")).toBe(true);
  });
  it("viewer role cannot run medium tools", () => {
    const e = dev(eng({ mode: "develop", role: "viewer" }), { input: true });
    expect(ev(e, "press_key", { key: "BACK" }).kind).toBe("deny");
  });
});

describe("schemas reject injection", () => {
  it.each(["com.a; rm -rf /", "com.a$(id)", "x"])("package %s", (p) => {
    expect(TOOL_MAP.get("app_launch")!.schema.safeParse({ package: p }).success).toBe(false);
  });
  it("unknown keys rejected", () => {
    expect(TOOL_MAP.get("device_list")!.schema.safeParse({ shell: "id" }).success).toBe(false);
  });
});

describe("audit", () => {
  it("redacts secrets and detects tampering", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "audit-"));
    const a = new AuditLogger(dir);
    a.write({ ts: "t", actor: "ai", tool: "x", risk: "low", decision: "allow", ok: true, params: { password: "hunter2", note: "token=abc123 mail me a@b.com" } });
    a.write({ ts: "t", actor: "user", tool: "y", risk: "low", decision: "allow", ok: true });
    const raw = readFileSync(path.join(dir, "audit.jsonl"), "utf8");
    expect(raw).not.toContain("hunter2"); expect(raw).not.toContain("abc123"); expect(raw).not.toContain("a@b.com");
    expect(a.verify().ok).toBe(true);
    const fs = await import("node:fs");
    fs.writeFileSync(path.join(dir, "audit.jsonl"), raw.replace('"tool":"x"', '"tool":"z"'));
    expect(a.verify().ok).toBe(false);
  });
  it("redact(): emails, phone numbers, JWTs and bearer tokens", () => {
    expect(redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).not.toContain("abcdefghijkl");
    expect(redact("mail me at a@b.com")).toBe("mail me at [EMAIL]");
    expect(redact("token=abcdef123456 hunter2")).not.toContain("abcdef123456");
  });

  it("redactDeep(): typed text and passwords are dropped, coordinates kept", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "audit-"));
    const a = new AuditLogger(dir);
    a.write({ ts: "t", actor: "user", tool: "type_text", risk: "medium", decision: "allow", ok: true, params: { text: "Hunter2!myPassword" } });
    a.write({ ts: "t", actor: "user", tool: "tap", risk: "medium", decision: "allow", ok: true, params: { x: 684, y: 2588, context: "keep me" } });
    const raw = readFileSync(path.join(dir, "audit.jsonl"), "utf8");
    expect(raw).not.toContain("Hunter2");
    expect(raw).toContain('"x":684');
    expect(raw).toContain("keep me");            // exact key matching: "context" is not "text"
    expect(raw).not.toContain('"text":"Hunter2');
    expect(a.verify().ok).toBe(true);
  });
});

describe("parsers", () => {
  it("foreground", () => {
    expect(parseForegroundPackage("  topResumedActivity=ActivityRecord{1 u0 com.example.app/.Main t5}")).toBe("com.example.app");
  });
  it("ui hierarchy", () => {
    const xml = `<hierarchy><node text="OK" resource-id="a:id/ok" content-desc="" class="Button" package="com.example.app" clickable="true" enabled="true" bounds="[0,0][100,50]"/></hierarchy>`;
    expect(parseUiHierarchy(xml)[0]).toMatchObject({ text: "OK", bounds: [0, 0, 100, 50] });
  });
});
