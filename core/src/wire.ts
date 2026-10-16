import { readFileSync } from "node:fs";
import path from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { Adb } from "./adb.js";
import { ApprovalQueue } from "./approval.js";
import { AuditLogger } from "./audit.js";
import { KillSwitch } from "./killswitch.js";
import { PolicyEngine } from "./policy.js";
import { ToolRouter } from "./router.js";
import { StudioError, type PolicyFile, type ToolRequest, type ToolResult } from "./types.js";
import { DeviceManager } from "./services/devices.js";
import { AppService } from "./services/apps.js";
import { FileService } from "./services/files.js";
import { InputService } from "./services/input.js";
import { LogService } from "./services/logcat.js";
import { MetricsCollector } from "./services/metrics.js";
import { SessionManager } from "./services/session.js";
import { writeReport } from "./services/report.js";
import { StudioDB } from "./db.js";
import { ScrcpyService } from "./services/scrcpy.js";
import { ScreenRecordService } from "./services/screen.js";
import { SecurityService } from "./services/security.js";
import { BootloaderService } from "./services/bootloader.js";
import { mediaDir } from "./config.js";

export interface StudioOptions {
  adbPath: string;
  dataDir: string;
  policy: PolicyFile | string;
  /** optional: SQLite file inside dataDir (disabled when the native module is unavailable) */
  database?: string;
  scrcpy?: { path?: string; extraArgs?: string[] };
  fastboot?: { path?: string };
  recording?: { remoteDir?: string; pullDir?: string };
  media?: { shotsDir?: string };   // "auto" (default) → ~/Pictures/ADB-AI-Test-Studio
}

const expand = (p: string) => p.replace(/^~/, homedir());

/** Composition root: builds every service and registers every tool handler. */
export function createStudio(opts: StudioOptions) {
  const dataDir = expand(opts.dataDir);
  const policyFile: PolicyFile = typeof opts.policy === "string" ? JSON.parse(readFileSync(opts.policy, "utf8")) : opts.policy;

  const kill = new KillSwitch();
  const adb = new Adb(opts.adbPath, kill);
  const policy = new PolicyEngine(policyFile);
  const audit = new AuditLogger(path.join(dataDir, "audit"));
  const approvals = new ApprovalQueue();
  const router = new ToolRouter(policy, audit, approvals, kill);

  const devices = new DeviceManager(adb);
  const apps = new AppService(adb, policy);
  const files = new FileService(adb, policy, expand(policyFile.files.localDownloadDir));
  const input = new InputService(adb, policy);
  const logs = new LogService(adb, 5000, policyFile.privacy.redactLogs);
  const metrics = new MetricsCollector(adb);
  const sessions = new SessionManager(path.join(dataDir, "sessions"), () => policy.policy);
  const db = new StudioDB(path.join(dataDir, opts.database ?? "studio.sqlite"));
  const scrcpy = new ScrcpyService(kill, opts.scrcpy?.path ?? "auto", opts.scrcpy?.extraArgs ?? ["--no-audio"]);
  // when the mirror window closes, the UI learns about it from the control server
  let onScrcpyExit: (() => void) | undefined;
  scrcpy.onExit = () => onScrcpyExit?.();
  // discoverable media folders: ~/Pictures/… and ~/Videos/… (Movies on macOS)
  const shotsDir = !opts.media?.shotsDir || opts.media.shotsDir === "auto" ? mediaDir("pictures") : expand(opts.media.shotsDir);
  const videoDir = !opts.recording?.pullDir || opts.recording.pullDir === "auto" ? mediaDir("videos") : expand(opts.recording.pullDir);
  const recorder = new ScreenRecordService(adb, kill, videoDir, opts.recording?.remoteDir);
  const security = new SecurityService(adb);
  const bootloader = new BootloaderService(kill, opts.fastboot?.path ?? "auto");

  /** Capture + write the PNG next to the other media (never inside a hidden folder). */
  async function saveScreenshot(serial: string): Promise<{ path: string; bytes: number }> {
    const png = await input.screenshot(serial);
    mkdirSync(shotsDir, { recursive: true });
    const file = path.join(shotsDir, `screen-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
    writeFileSync(file, png, { mode: 0o600 });
    return { path: file, bytes: png.length };
  }

  const target = (p: Record<string, unknown>) => (p.package as string | undefined) ?? sessions.active?.package ?? policy.policy.targetPackages[0];
  const dev = (p: Record<string, unknown>) => devices.resolve(p.device as string | undefined);

  // --- devices
  router.register("device_list", async () => ({ devices: await devices.list() }));
  router.register("device_info", async (p) => devices.info(await dev(p)));
  router.register("device_connect", async (p) => ({ result: await devices.connect(p.host as string, p.port as number) }));
  router.register("device_disconnect", async (p) => { await devices.disconnect(await dev(p)); return { disconnected: true }; });

  // --- apps
  router.register("app_list", async (p) => apps.list(await dev(p), p.scope as "target" | "user"));
  router.register("app_launch", async (p) => apps.launch(await dev(p), p.package as string));
  router.register("app_stop", async (p) => apps.stop(await dev(p), p.package as string));
  router.register("app_install", async (p) => apps.install(await dev(p), p.apk_path as string, { replace: p.replace as boolean, debug: p.debug as boolean }));
  router.register("app_uninstall", async (p) => apps.uninstall(await dev(p), p.package as string));
  router.register("app_clear_data", async (p) => apps.clearData(await dev(p), p.package as string));

  // --- files
  router.register("file_list", async (p) => ({ entries: await files.list(await dev(p), p.path as string) }));
  router.register("file_pull", async (p) => files.pull(await dev(p), p.remote as string, p.local as string | undefined));
  router.register("file_push", async (p) => files.push(await dev(p), p.local as string, p.remote as string));
  router.register("file_delete", async (p) => files.remove(await dev(p), p.path as string, p.recursive as boolean));

  // --- screen / input
  router.register("screenshot", async (p) => {
    const png = await input.screenshot(await dev(p));
    return { png_base64: png.toString("base64"), bytes: png.length };
  });
  router.register("ui_hierarchy", async (p) => ({ elements: (await input.dumpUi(await dev(p))).slice(0, 400) }));
  router.register("tap", async (p) => input.tap(await dev(p), target(p), p as never));
  router.register("swipe", async (p) => input.swipe(await dev(p), target(p), p as never));
  router.register("type_text", async (p) => input.typeText(await dev(p), target(p), p.text as string));
  router.register("press_key", async (p) => input.pressKey(await dev(p), target(p), p.key as string));

  // --- logs / metrics
  router.register("logs_read", async (p) => {
    const serial = await dev(p);
    if (!logs.query({ lines: 1 }).length) {
      // one-shot snapshot when no stream is running
      const r = await adb.must(["logcat", "-d", "-v", "threadtime", "-t", "2000"], { serial });
      const { parseLogLine } = await import("./services/logcat.js");
      const lines = r.stdout.split("\n").map((l) => parseLogLine(l, policy.policy.privacy.redactLogs)).filter((x) => x !== null);
      const pkg = target(p);
      const only = (p.target_only as boolean) || policy.policy.ai.logsTargetOnly;
      const order = "VDIWEF";
      return { lines: lines.filter((l) => order.indexOf(l.level) >= order.indexOf(p.level as string))
        .filter((l) => !only || !pkg || l.msg.includes(pkg) || l.tag.includes("AndroidRuntime") || l.tag === "ActivityManager")
        .filter((l) => !p.contains || l.msg.toLowerCase().includes(String(p.contains).toLowerCase()))
        .slice(-(p.lines as number)) };
    }
    return { lines: logs.query({ level: p.level as string, tag: p.tag as string | undefined, contains: p.contains as string | undefined, lines: p.lines as number }) };
  });
  router.register("metrics_read", async (p) => {
    const serial = await dev(p);
    const out = [];
    const n = Math.max(1, Math.floor(((p.seconds as number) * 1000) / (p.interval_ms as number)));
    for (let i = 0; i < n; i++) {
      out.push(await metrics.sample(serial, (p.package as string | undefined) ?? target(p)));
      if (i < n - 1) await new Promise((r) => setTimeout(r, p.interval_ms as number));
    }
    return { samples: out };
  });

  // --- sessions / report
  router.register("session_start", async (p) => {
    const serial = await dev(p);
    const s = sessions.start({ name: p.name as string, goal: p.goal as string | undefined, device: serial, package: p.package as string, maxSteps: p.max_steps as number | undefined, maxSeconds: p.max_seconds as number | undefined });
    devices.acquire(serial, s.id);
    return { session_id: s.id, max_steps: s.maxSteps, max_seconds: s.maxSeconds };
  });
  router.register("session_stop", async (p) => {
    const s = sessions.stop((p.stop_reason as string | undefined) ?? "user");
    if (s) devices.release(s.device, s.id);
    return { session_id: s?.id, stop_reason: s?.stopReason };
  });
  router.register("report_create", async (p) => {
    const s = sessions.active;
    if (!s || s.id !== p.session_id) throw new StudioError("INVALID_PARAMS", "Unknown or non-current session id");
    return { path: writeReport({ session: s, metrics: metrics.data(), lang: (p.lang as "th" | "en" | undefined) ?? "th" }, p.format as "html" | "md" | "json") };
  });

  // --- security / repair -------------------------------------------------
  router.register("security_scan", async (p) => security.scan(await dev(p), Array.isArray(p.packages) ? p.packages as string[] : policy.policy.targetPackages));
  router.register("device_admins", async (p) => security.scan(await dev(p)).then((r) => ({
    admins: r.findings.filter((f) => f.id === "device_admins").flatMap((f) => f.packages),
  })));
  router.register("app_permissions", async (p) => security.permissions(await dev(p), p.package as string));

  router.register("app_disable", async (p) => {
    const serial = await dev(p);
    const state = (p.keep_data as boolean) ? "disable" : "disable-until-used";
    await adb.shell(serial, ["pm", state, p.package as string]);
    return { disabled: p.package, state };
  });
  router.register("app_revoke", async (p) => {
    const serial = await dev(p);
    await adb.shell(serial, ["pm", "revoke", p.package as string, p.permission as string]);
    return { revoked: p.permission, package: p.package };
  });
  router.register("app_force_stop", async (p) => {
    const serial = await dev(p);
    await adb.shell(serial, ["am", "force-stop", p.package as string]);
    return { force_stopped: p.package };
  });

  // --- bootloader mode (human-only; policy denies these for AI) ----------
  router.register("boot_reboot_target", async (p) => {
    const serial = await dev(p);
    await bootloader.adbRebootTo(adb.binary, serial, p.target as "bootloader" | "recovery");
    return { rebooting_to: p.target, device: serial };
  });
  router.register("fastboot_info", async (p) => {
    if (p.sub === "devices") return { devices: (await bootloader.run(["devices"], 30_000)).stdout.trim() };
    const r = await bootloader.run(["getvar", "current-slot"], 30_000);
    return { current_slot: (r.stdout + r.stderr).match(/current-slot:\s*(\w+)/)?.[1] ?? "unknown" };
  });
  router.register("fastboot_reboot", async (p) => ({
    result: (await bootloader.run(["reboot", p.to as string], 120_000) ? "rebooting" : "failed"),
  }));
  router.register("fastboot_unlock", async () => {
    const r = await bootloader.run(["flashing", "unlock"], 300_000);
    return { stdout: r.stdout.trim().slice(0, 400), stderr: r.stderr.trim().slice(0, 400), code: r.code };
  });
  router.register("fastboot_flash", async (p) => {
    const image = p.image as string;
    if (!existsSync(image)) throw new StudioError("INVALID_PARAMS", `image file not found on this computer: ${image}`);
    const argv = ["flash", p.partition as string, image, ...(p.wipe ? ["--wipe"] : [])];
    if (p.wipe) argv.splice(argv.indexOf("--wipe"), 1);   // only `fastboot -w` has --wipe; flash does not
    const r = await bootloader.run(argv, 600_000);
    return { partition: p.partition, code: r.code, output: `${r.stdout}${r.stderr}`.trim().slice(0, 600) };
  });
  router.register("fastboot_set_active", async (p) => ({
    result: (await bootloader.run(["--set-active", p.slot as string], 60_000)) ? "ok" : "failed",
  }));
  router.register("fastboot_lock", async () => {
    const r = await bootloader.run(["flashing", "lock"], 300_000);
    return { code: r.code, output: `${r.stdout}${r.stderr}`.trim().slice(0, 400) };
  });
  router.register("fastboot_erase", async (p) => {
    const r = await bootloader.run(["erase", p.partition as string], 300_000);
    return { partition: p.partition, code: r.code, output: `${r.stdout}${r.stderr}`.trim().slice(0, 400) };
  });
  router.register("adb_sideload", async (p) => {
    const serial = await dev(p);
    if (p.wipe_data) throw new StudioError("POLICY_DENIED", "sideload with wipe_data is refused — wipe manually from recovery instead");
    const r = await bootloader.sideload(adb.binary, serial, p.zip as string);
    return { code: r.code, output: r.stdout.trim().slice(0, 600) };
  });

  // --- power (human-approved; the only reboot we ever issue is a plain `adb reboot`)
  router.register("power_request_reboot", async (p) => {
    const serial = await dev(p);
    const mode = p.mode as string;
    await adb.must(mode === "normal" ? ["reboot"] : ["reboot", mode], { serial });
    return { rebooting: mode };
  });

  // --- crash/ANR → session stop conditions
  logs.on("crash", (l: { msg: string }) => sessions.noteCrash(l.msg));
  sessions.on("started", (s) => db.recordSession(s));
  sessions.on("stopped", (s) => db.recordSession(s));
  metrics.on("sample", (m) => db.recordMetric(m as unknown as Record<string, unknown>, sessions.active?.id, sessions.active?.device));
  logs.on("anr", (l: { msg: string }) => sessions.noteAnr(l.msg));
  approvals.on("settled", (_r, outcome: string) => {
    if (outcome === "approved" || outcome === "denied") sessions.noteApproval(outcome);
    db.recordApproval(_r, outcome as "approved" | "denied");
  });
  approvals.on("added", (r) => db.recordApproval(r));

  // --- kill switch fan-out
  kill.on("triggered", (source: string) => {
    approvals.cancelAll();
    logs.stop(); metrics.pause(); scrcpy.stop(); recorder.stop().catch(() => undefined);

    const s = sessions.stop("kill_switch");
    if (s) devices.release(s.device, s.id);
    audit.write({ ts: new Date().toISOString(), actor: "system", tool: "kill_switch", params: { source }, risk: "critical", decision: "allow", ok: true });
  });

  policy.onAnomaly = (msg) => audit.write({ ts: new Date().toISOString(), actor: "system", tool: "anomaly", params: { msg }, risk: "high", decision: "alert", ok: true });

  /** Public entry: records session steps, then delegates to the router. */
  async function call(req: ToolRequest): Promise<ToolResult> {
    const sess = sessions.active;
    const res = await router.call({ ...req, sessionId: req.sessionId ?? sess?.id });
    const params = req.params as Record<string, unknown>;
    const device = (typeof params.device === "string" ? params.device : sess?.device) ?? "";

    // queryable history (audit stays the append-only JSONL source of truth)
    if (res.ok && req.tool.startsWith("app_")) {
      db.recordAppOp(req.tool, typeof params.package === "string" ? params.package : "", device, true);
    } else if (res.ok && req.tool.startsWith("file_")) {
      const target = typeof params.path === "string" ? params.path : typeof params.remote === "string" ? params.remote : "";
      db.recordFileOp(req.tool, target, typeof params.local === "string" ? params.local : undefined, 0, "", undefined, device);
    }
    if (res.ok && req.tool === "report_create")
      db.recordReport(sess?.id ?? "-", String(params.format ?? "html"), String((res.data as { path: string }).path));
    if (sess?.status === "running" && !req.tool.startsWith("session_") && req.tool !== "report_create") {
      let shot: Buffer | undefined;
      if (res.ok && req.tool === "screenshot") shot = Buffer.from((res.data as { png_base64: string }).png_base64, "base64");
      if (!res.ok && res.error.code === "FOREGROUND_MISMATCH") sessions.noteLeftTarget("other");
      if (sessions.active?.status === "running") {
        const step = sessions.record({
          tool: req.tool, params: req.params, reason: req.reason, risk: res.risk,
          result: res.ok ? ((res as { dry_run?: boolean }).dry_run ? "dry_run" : "success")
            : res.error.code === "APPROVAL_DENIED" || res.error.code === "APPROVAL_EXPIRED" ? "denied"
            : ["POLICY_DENIED", "OUT_OF_SCOPE", "PATH_FORBIDDEN", "RATE_LIMITED", "FOREGROUND_MISMATCH", "DEVICE_LOCKED"].includes(res.error.code) ? "blocked" : "failed",
          error_code: res.ok ? undefined : res.error.code,
        }, shot);
        if (step?.idx) db.recordStep(sessions.active!.id, step);
      }
    }
    return res;
  }

  return {
    call, router, policy, audit, approvals, kill, adb, devices, apps, files, input, logs, metrics, sessions, db, scrcpy, recorder, security, bootloader,
    /** internal: lets the control plane push state changes (e.g. mirror window closed) */
    _onScrcpyExit: (fn: () => void) => { onScrcpyExit = fn; },
    saveScreenshot,
    folders: { screenshots: shotsDir, recordings: videoDir, data: dataDir, audit: audit.dir, sessions: sessions.sessionsDir },
  };
}
export type Studio = ReturnType<typeof createStudio>;
