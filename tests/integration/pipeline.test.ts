import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStudio, type Studio } from "../../core/src/wire.js";
import type { PolicyFile } from "../../core/src/types.js";

const FAKE = path.resolve("tests/integration/fake-adb.mjs");
let dir: string, studio: Studio, stateFile: string;
const setState = (o: object) => writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(readFileSync(stateFile, "utf8")), ...o }));
const calls = () => (existsSync(stateFile + ".calls") ? readFileSync(stateFile + ".calls", "utf8").split("\n").filter(Boolean).map((l) => { const a = JSON.parse(l) as string[]; return a[0] === "-s" ? a.slice(2) : a; }) : []);

function make(over: Partial<PolicyFile> = {}, feats: Partial<PolicyFile["features"]> = {}) {
  dir = mkdtempSync(path.join(tmpdir(), "studio-"));
  stateFile = path.join(dir, "state.json");
  writeFileSync(stateFile, JSON.stringify({ devices: [{ serial: "ABC123", state: "device" }], foreground: "com.example.app", locked: false, user: ["com.example.app", "com.other.app"], apkPackage: "com.example.app" }));
  process.env.FAKE_ADB_STATE = stateFile;
  mkdirSync(path.join(dir, "apk")); writeFileSync(path.join(dir, "apk", "app.apk"), "apk-bytes");
  const base: PolicyFile = JSON.parse(readFileSync("config/policy.default.json", "utf8"));
  studio = createStudio({
    adbPath: FAKE, dataDir: path.join(dir, "data"),
    policy: { ...base, mode: "develop", role: "admin", targetPackages: ["com.example.app"], localApkDirs: [path.join(dir, "apk")], features: { ...base.features, input: true, install: true, power: true, delete: true, files: true, ...feats }, ...over },
  });
}
const ai = (tool: string, params: object = {}) => studio.call({ tool, params: { reason: "test", ...params }, actor: "ai", client: "test", reason: "test" });
const approveNext = () => new Promise<void>((res) => studio.approvals.once("added", (r: { id: string; typedConfirm?: string }) => { studio.approvals.approve(r.id, r.typedConfirm); res(); }));
const denyNext = () => studio.approvals.once("added", (r: { id: string }) => studio.approvals.deny(r.id));

beforeEach(() => make());

describe("end-to-end through fake adb", () => {
  it("app_list uses --user 0 (second-profile devices break plain `pm list`)", async () => {
    const r = await ai("app_list", { scope: "user" });
    expect(r.ok).toBe(true);
    expect(calls().some((c) => c.join(" ").includes("pm list packages -3 --user 0"))).toBe(true);
  });

  it("lists devices and reads info", async () => {
    const r = await ai("device_list"); expect(r.ok).toBe(true);
    const i = await ai("device_info"); expect(i.ok && (i.data as { model: string }).model).toBe("Pixel 8");
  });

  it("tap by selector works when target is foreground, and hits the right coordinates", async () => {
    const r = await ai("tap", { selector: { text: "Login" } });
    expect(r.ok).toBe(true);
    expect(calls().some((c) => c.join(" ").includes("input tap 200 250"))).toBe(true);
  });

  it("ui_hierarchy dumps via exec-out (plain `adb shell` loses the XML on some devices)", async () => {
    const r = await ai("ui_hierarchy");
    expect(r.ok).toBe(true);
    expect((r.data as { elements: { text: string }[] }).elements.some((e) => e.text === "Login")).toBe(true);
    expect(calls().some((c) => c[0] === "exec-out" && c.includes("uiautomator"))).toBe(true);
  });

  it("tap is blocked and NOT sent when another app is foreground", async () => {
    setState({ foreground: "com.other.app" });
    const r = await ai("tap", { selector: { text: "Login" } });
    expect(!r.ok && r.error.code).toBe("FOREGROUND_MISMATCH");
    expect(calls().some((c) => c.includes("tap"))).toBe(false);
  });

  it("locked device is not touched", async () => {
    setState({ locked: true });
    const r = await ai("press_key", { key: "BACK" });
    expect(!r.ok && r.error.code).toBe("DEVICE_LOCKED");
    expect(calls().some((c) => c.includes("keyevent"))).toBe(false);
  });

  it("install needs approval; approve → installs; deny → nothing sent", async () => {
    const apk = path.join(dir, "apk", "app.apk");
    const p = approveNext(); const r = await ai("app_install", { apk_path: apk }); await p;
    expect(r.ok).toBe(true);
    expect(calls().some((c) => c[0] === "install")).toBe(true);

    make(); denyNext();
    const d = await ai("app_install", { apk_path: path.join(dir, "apk", "app.apk") });
    expect(!d.ok && d.error.code).toBe("APPROVAL_DENIED");
    expect(calls().some((c) => c[0] === "install")).toBe(false);
  });

  it("APK outside allowed folder is refused", async () => {
    writeFileSync(path.join(dir, "evil.apk"), "x");
    const p = approveNext(); const r = await ai("app_install", { apk_path: path.join(dir, "evil.apk") }); await p;
    expect(!r.ok && r.error.code).toBe("PATH_FORBIDDEN");
    expect(calls().some((c) => c[0] === "install")).toBe(false);
  });

  it("install that sneaks in a non-target package is rolled back", async () => {
    setState({ apkPackage: "com.evil.dropper" });
    const p = approveNext(); const r = await ai("app_install", { apk_path: path.join(dir, "apk", "app.apk") }); await p;
    expect(!r.ok && r.error.code).toBe("OUT_OF_SCOPE");
    expect(calls().some((c) => c[0] === "uninstall" && c[1] === "com.evil.dropper")).toBe(true);
  });

  it("cannot uninstall non-target or system apps", async () => {
    for (const pkg of ["com.other.app", "com.android.settings"]) {
      const r = await ai("app_uninstall", { package: pkg });
      expect(!r.ok && r.error.code).toBe("OUT_OF_SCOPE");
    }
    expect(calls().some((c) => c[0] === "uninstall")).toBe(false);
  });

  it("reboot: critical needs typed confirm; wrong word keeps it pending", async () => {
    const pending = ai("power_request_reboot");
    await new Promise((r) => setTimeout(r, 20));
    const [req] = studio.approvals.list();
    expect(req.typedConfirm).toBe("CONFIRM");
    expect(studio.approvals.approve(req.id, "yes")).toBe(false);
    expect(studio.approvals.approve(req.id, "CONFIRM")).toBe(true);
    expect((await pending).ok).toBe(true);
    expect(calls().some((c) => c[0] === "shell" ? false : c[0] === "reboot")).toBe(true);
  });

  it("reboot is refused while the power feature is off", async () => {
    make({}, { power: false });
    const r = await ai("power_request_reboot");
    expect(!r.ok && r.error.code).toBe("POLICY_DENIED");
  });

  it("kill switch rejects new calls, cancels pending approvals, and is audited", async () => {
    const pending = ai("app_clear_data", { package: "com.example.app" });
    await new Promise((r) => setTimeout(r, 20));
    studio.kill.trigger("test");
    expect((await pending).ok).toBe(false);
    const after = await ai("device_list");
    expect(!after.ok && after.error.code).toBe("KILL_SWITCH");
    expect(readFileSync(path.join(dir, "data", "audit", "audit.jsonl"), "utf8")).toContain("kill_switch");
    studio.kill.release();
    expect((await ai("device_list")).ok).toBe(true);
  });

  it("dry_run does not touch the device", async () => {
    const before = calls().length;
    const r = await ai("tap", { selector: { text: "x" }, dry_run: true });
    expect(r.ok && (r as { dry_run?: boolean }).dry_run).toBe(true);
    expect(calls().length).toBe(before);
  });

  // writes 8 screenshots through adb + SQLite, so it gets its own budget
  it("full session: start → steps → no-progress stop → report", async () => {
    const s = await ai("session_start", { name: "smoke", package: "com.example.app", max_steps: 50 });
    expect(s.ok).toBe(true);
    for (let i = 0; i < 8; i++) await ai("screenshot"); // identical frames → no_progress
    expect(studio.sessions.active?.status).toBe("stopped");
    expect(studio.sessions.active?.stopReason).toBe("no_progress");
    const rep = studio.sessions.active!;
    const { writeReport } = await import("../../core/src/services/report.js");
    const html = readFileSync(writeReport({ session: rep }, "html"), "utf8");
    expect(html).toContain("smoke"); expect(html).toContain("no_progress");
  }, 20_000);

  it("second session on the same device is refused while one runs", async () => {
    expect((await ai("session_start", { name: "a", package: "com.example.app" })).ok).toBe(true);
    const r = await ai("session_start", { name: "b", package: "com.example.app" });
    expect(r.ok).toBe(false);
  });

  it("crash in logcat stops the session", async () => {
    await ai("session_start", { name: "crashy", package: "com.example.app" });
    studio.logs.emit("crash", { msg: "FATAL EXCEPTION: main" });
    expect(studio.sessions.active?.stopReason).toBe("crash");
  });

  it("audit chain stays valid after a busy run", async () => {
    await ai("device_list"); await ai("raw_shell", { cmd: "id" }); await ai("tap", { x: 1, y: 1 });
    expect(studio.audit.verify().ok).toBe(true);
  });
});
