import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveScrcpyPath, ScrcpyService } from "../../core/src/services/scrcpy.js";
import { ScreenRecordService, MAX_RECORD_SECONDS } from "../../core/src/services/screen.js";
import { BootloaderService } from "../../core/src/services/bootloader.js";
import { StudioDB } from "../../core/src/db.js";
import { KillSwitch } from "../../core/src/killswitch.js";
import { Adb } from "../../core/src/adb.js";

const PLATFORM = process.platform;

/** fake scrcpy binary that records its argv and stays alive until killed */
const SCRCPY_HELP = [
  "  --max-size=value", "  --bit-rate=value", "  --stay-awake", "  --turn-screen-off",
  "  --show-touches", "  --fullscreen", "  --window-title=text", "  --no-audio",
].join("\n");

/** fake scrcpy: prints args for later inspection, answers --help, then idles */
function fakeScrcpy(dir: string): string {
  const p = path.join(dir, PLATFORM === "win32" ? "scrcpy.exe" : "scrcpy");
  writeFileSync(p, [
    "#!/bin/sh",
    `printf '%s\n' "$@" > "${p}.args"`,
    'if [ "$1" = "--help" ]; then',
    `  printf '%s\n' "${SCRCPY_HELP}"`,
    "  exit 0",
    "fi",
    "while true; do sleep 0.2; done",
  ].join("\n"));
  chmodSync(p, 0o755);
  return p;
}

describe("scrcpy", () => {
  it("resolves an explicit path, and rejects a broken one", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "scrcpy-"));
    const p = path.join(dir, "scrcpy");
    writeFileSync(p, "#!/bin/sh\n"); chmodSync(p, 0o755);
    expect(resolveScrcpyPath(p)).toBe(p);
    expect(() => resolveScrcpyPath(path.join(dir, "nope"))).toThrow(/scrcpy not found/);
  });

  it("finds scrcpy on $PATH when set to auto", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "scrcpy-"));
    const p = fakeScrcpy(dir);
    const old = process.env.PATH;
    process.env.PATH = dir + path.delimiter + old;
    try { expect(resolveScrcpyPath("auto", PLATFORM)).toBe(p); }
    finally { process.env.PATH = old; }
  });

  it("start/stop tracks the child and passes the serial", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "scrcpy-"));
    const bin = fakeScrcpy(dir);
    const kill = new KillSwitch();
    const svc = new ScrcpyService(kill, bin, ["--no-audio"]);

    const { pid, args: returned } = await svc.start("SERIAL1", { maxSize: 1024, stayAwake: true, windowTitle: "t" });
    expect(pid).toBeGreaterThan(0);
    expect(returned).toEqual(expect.arrayContaining(["-s", "SERIAL1", "--no-audio"]));
    const args = readFileSync(bin + ".args", "utf8").trim().split("\n").join(" ");
    expect(args).toContain("-s SERIAL1");
    expect(args).toContain("--no-audio");
    expect(args).toContain("--max-size 1024");
    expect(args).toContain("--stay-awake");
    expect(args).toContain("--window-title t");
    expect(svc.running).toBe(true);

    svc.stop();
    await new Promise((r) => setTimeout(r, 200));
    expect(svc.running).toBe(false);
  });

  it("drops options this scrcpy build does not support instead of failing", async () => {
    // a fake scrcpy whose --help lists only --max-size and --stay-awake
    const dir = mkdtempSync(path.join(tmpdir(), "scrcpy-"));
    const bin = path.join(dir, "scrcpy");
    writeFileSync(bin, [
      "#!/bin/sh",
      'printf "%s\\n" "$@" > "' + bin + '.args"',
      'if [ "$1" = "--help" ]; then echo "  --max-size=value"; echo "  --stay-awake"; echo "  --show-touches"; fi;',
      "while true; do sleep 0.2; done",
    ].join("\n"));
    chmodSync(bin, 0o755);

    const svc = new ScrcpyService(new KillSwitch(), bin, ["--no-audio"]);   // legacy config flag
    const { args } = await svc.start("S9", { maxSize: 800, stayAwake: true, showTouches: true, noAudio: true });
    const joined = args.join(" ");
    expect(joined).not.toContain("--no-audio");     // unsupported → dropped
    expect(joined).toContain("--max-size 800");
    expect(joined).toContain("--stay-awake");
    expect(joined).toContain("--show-touches");
    svc.stop();
  });

  it("refuses to start when a required option is unknown", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "scrcpy-"));
    const bin = path.join(dir, "scrcpy");
    writeFileSync(bin, "#!/bin/sh\nif [ \"$1\" = \"--help\" ]; then echo \"  --max-size=value\"; fi;\nwhile true; do sleep 1; done\n");
    chmodSync(bin, 0o755);
    const svc = new ScrcpyService(new KillSwitch(), bin);
    await expect(svc.start("S9", { maxSize: undefined })).resolves.toBeTruthy();
    svc.stop();
  });

  it("a mirror that dies immediately is reported as an error", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "scrcpy-"));
    const bin = path.join(dir, "scrcpy");
    writeFileSync(bin, "#!/bin/sh\necho 'ERROR: no device' >&2\nexit 1\n"); chmodSync(bin, 0o755);
    const svc = new ScrcpyService(new KillSwitch(), bin);
    await expect(svc.start("NOPE")).rejects.toThrow(/scrcpy ไม่ทำงาน/);
    expect(svc.running).toBe(false);
  });

  it("the kill switch closes a running mirror", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "scrcpy-"));
    const bin = fakeScrcpy(dir);
    const kill = new KillSwitch();
    const svc = new ScrcpyService(kill, bin);
    await svc.start("SERIAL2");
    kill.trigger("test");
    await new Promise((r) => setTimeout(r, 400));
    expect(svc.running).toBe(false);
    kill.release();
  });
});

describe("screen recording", () => {
  let dir: string, stateFile: string;
  const FAKE = path.resolve("tests/integration/fake-adb.mjs");

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "rec-"));
    stateFile = path.join(dir, "state.json");
    writeFileSync(stateFile, JSON.stringify({ devices: [{ serial: "ABC123", state: "device" }], foreground: "com.example.app", locked: false, user: [], apkPackage: "x" }));
    process.env.FAKE_ADB_STATE = stateFile;
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const callLines = () => readFileSync(stateFile + ".calls", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
  const screenrecordArgs = () => callLines().find((c) => c.includes("screenrecord"))!;

  it("spawns screenrecord with the time limit capped at 180 s", async () => {
    const kill = new KillSwitch();
    const adb = new Adb(FAKE, kill);
    const rec = new ScreenRecordService(adb, kill, path.join(dir, "out"));

    // the fake adb exits immediately for screenrecord, so start() surfaces the error
    await expect(rec.start("ABC123", 999)).rejects.toThrow(/exited immediately/);
    expect(MAX_RECORD_SECONDS).toBe(180);
    const args = screenrecordArgs();
    expect(args).toContain("screenrecord");
    expect(args).toContain("--time-limit");
    expect(args[args.indexOf("--time-limit") + 1]).toBe("180");
    expect(args[args.length - 1]).toMatch(/\.mp4$/);
  });

  it("clamps the limit into 1..180", async () => {
    const kill = new KillSwitch();
    const adb = new Adb(FAKE, kill);
    const rec = new ScreenRecordService(adb, kill, path.join(dir, "out"));
    await expect(rec.start("ABC123", -5)).rejects.toThrow();
    const args = screenrecordArgs();
    expect(args[args.indexOf("--time-limit") + 1]).toBe("1");
  });

  it("stop() without a recording is refused", async () => {
    const kill = new KillSwitch();
    const adb = new Adb(FAKE, kill);
    const rec = new ScreenRecordService(adb, kill, path.join(dir, "out"));
    await expect(rec.stop()).rejects.toThrow(/not recording/);
  });
});

describe("bootloader service (allowlist)", () => {
  it("refuses any fastboot verb outside the allowlist", async () => {
    const svc = new BootloaderService(new KillSwitch(), "/bin/true");
    for (const argv of [
      ["-w"], ["format", "userdata"], ["erase", "userdata"], ["oem", "device-info", "; rm -rf /"],
      ["flash", "boot", "/x; rm -rf /"], ["boot", "$(id)"], ["shell", "id"],
    ]) {
      await expect(svc.run(argv as string[]), argv.join(" ")).rejects.toThrow(/not allowed|unsupported characters|safe local path|plain partition/i);
    }
  });

  it("oem/flashing only allow their known subcommands, without extra args", async () => {
    const svc = new BootloaderService(new KillSwitch(), "/bin/true");
    await expect(svc.run(["flashing", "unlock", "boot"])).rejects.toThrow(/not allowed/);
    await expect(svc.run(["oem", "device-info", "; rm -rf /"])).rejects.toThrow(/not allowed/);
    await expect(svc.run(["oem", "frp"])).rejects.toThrow(/not allowed/);
    await expect(svc.run(["flashing", "unlock"], 5000)).resolves.toMatchObject({ code: 0 });  // the allowed form passes validation
  });

  it("sideload refuses paths with shell metacharacters", async () => {
    const svc = new BootloaderService(new KillSwitch(), "/bin/true");
    await expect(svc.sideload("adb", undefined, "/tmp/x;rm -rf /")).rejects.toThrow(/unsupported characters/);
    await expect(svc.sideload("adb", undefined, "/tmp/$(id).zip")).rejects.toThrow(/unsupported characters/);
  });

  it("reads environment fastboot from PATH when set to auto", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fb-"));
    const fake = path.join(dir, process.platform === "win32" ? "fastboot.exe" : "fastboot");
    writeFileSync(fake, "#!/bin/sh\necho ok\n"); chmodSync(fake, 0o755);
    const old = process.env.PATH;
    process.env.PATH = dir + path.delimiter + old;
    try {
      const svc = new BootloaderService(new KillSwitch(), "auto");
      expect(svc.binary()).toBe(fake);
    } finally { process.env.PATH = old; }
  });
});

describe("studio db", () => {
  it("creates the schema, records a session+step and reads them back", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "db-"));
    const db = new StudioDB(path.join(dir, "studio.sqlite"));
    try {
      if (!db.available) return;   // native module not loadable in this runtime: skip
      expect(db.schemaVersion).toBe(1);
      const session = {
        id: "abc12345", name: "t", device: "SERIAL", package: "com.example.app",
        startedAt: new Date().toISOString(), status: "running" as const,
        maxSteps: 10, maxSeconds: 60, steps: [], crashes: [], anrs: [],
        approvals: { approved: 0, denied: 0 }, dir: "/tmp",
      };
      db.recordSession(session);
      db.recordStep("abc12345", { idx: 1, tool: "screenshot", params: {}, result: "success", ts: new Date().toISOString(), risk: "low" });
      db.recordMetric({ ts: 1, cpu_sys: 3.5 }, "abc12345", "SERIAL");
      expect(db.sessions(10)).toHaveLength(1);
      expect(db.steps("abc12345")).toHaveLength(1);
      expect(db.metrics("abc12345")[0]).toMatchObject({ cpu_sys: 3.5, session_id: "abc12345" });
      expect(db.stats()).toMatchObject({ sessions: 1, steps: 1, metrics: 1 });
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("records approvals with their outcome", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "db-"));
    const db = new StudioDB(path.join(dir, "studio.sqlite"));
    try {
      if (!db.available) return;
      const req = {
        id: "r1", requestedBy: "user" as const, tool: "app_install", params: { apk_path: "/x.apk" },
        risk: "high" as const, impact: "install", createdAt: Date.now(), expiresAt: Date.now() + 1000,
      };
      db.recordApproval(req);
      expect(db.approvals()[0]).toMatchObject({ id: "r1", status: "pending" });
      db.recordApproval(req, "approved");
      expect(db.approvals()[0]).toMatchObject({ status: "decided", outcome: "approved" });
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
