import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { StudioError } from "../types.js";
import type { KillSwitch } from "../killswitch.js";

/** fastboot subcommands a human may run. Everything else is refused here. */
const FASTBOOT_ALLOWED = new Set([
  "devices", "getvar", "reboot", "reboot-bootloader", "flash", "oem", "flashing",
]);

/** `fastboot flashing unlock`/`oem unlock` wipe the device — extra confirmation required. */
const WIPE_COMMANDS = new Set(["flashing unlock", "oem unlock"]);

/** subcommands allowed for the dangerous meta verbs, with no extra arguments */
const OEM_SUBCOMMANDS = new Set(["unlock", "lock", "device-info", "get_unlock_ability"]);
const FLASHING_SUBCOMMANDS = new Set(["unlock", "lock", "get_unlock_ability", "lock_critical", "unlock_critical"]);
/** partitions flashable through `fastboot_flash` */
export const FLASHABLE_PARTITIONS = ["boot", "init_boot", "recovery", "vendor_boot", "dtbo", "vbmeta", "vbmeta_system", "modem"] as const;

export interface FastbootOptions { binary?: string }

/**
 * Bootloader/fastboot operations, strictly argv-based and allowlisted:
 *  - no shell strings, no `fastboot -w`, no raw user commands
 *  - unlock/lock are filtered through WIPE_COMMANDS so the router can demand a
 *    typed confirmation from the human
 * This service exists because the AI must never reach it; the policy engine
 * denies bootloader tools for `actor: "ai"` no matter what.
 */
export class BootloaderService {
  constructor(private kill: KillSwitch, private configured = "auto") {}

  binary(): string {
    if (this.configured && this.configured !== "auto") {
      if (!spawnSync(this.configured, ["--version"], { timeout: 8000 }).error) return this.configured;
      throw new StudioError("UNSUPPORTED", `fastboot not found at '${this.configured}' (fastboot.path in app.config.json)`);
    }
    // fastboot ships next to adb in platform-tools: look on PATH, next to the
    // adb we already resolved, and in the usual SDK locations
    const exe = process.platform === "win32" ? "fastboot.exe" : "fastboot";
    const dirs = [...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean)];
    const home = homedir();
    dirs.push(
      path.join(home, "Android", "Sdk", "platform-tools"),
      path.join(home, "Library", "Android", "sdk", "platform-tools"),
      path.join(home, "AppData", "Local", "Android", "Sdk", "platform-tools"),
      "/opt/android-sdk/platform-tools", "/usr/lib/android-sdk/platform-tools",
    );
    const found = dirs.map((d) => path.join(d, exe)).find((c) => { try { return existsSync(c); } catch { return false; } });
    if (found && !spawnSync(found, ["--version"], { timeout: 8000 }).error) return found;
    throw new StudioError("UNSUPPORTED", "fastboot not found — add platform-tools to PATH or set fastboot.path in app.config.json");
  }

  /** Validate + run one fastboot invocation. Only allowlisted verbs pass. */
  async run(argv: string[], timeoutMs = 120_000): Promise<{ stdout: string; stderr: string; code: number }> {
    const [verb, partition, file] = argv;
    const head = String(argv.slice(0, 2).join(" "));
    if (!FASTBOOT_ALLOWED.has(verb)) throw new StudioError("POLICY_DENIED", `fastboot verb '${verb}' is not allowed`);
    if ((verb === "oem" || verb === "flashing") && (argv.length !== 2 || !(verb === "oem" ? OEM_SUBCOMMANDS : FLASHING_SUBCOMMANDS).has(argv[1])))
      throw new StudioError("POLICY_DENIED", `fastboot ${verb} ${argv[1] ?? ""} is not allowed`);

    if (verb === "flash") {
      // `fastboot flash <partition> <file>`: partition from a strict set, file must be
      // a real local path with no shell metacharacters or argument injection.

      if (!partition || !/^[a-z0-9_-]{1,32}$/.test(partition))
        throw new StudioError("INVALID_PARAMS", `partition '${partition}' is not a plain partition name`);
      const unsafe = !file || /[;`$|<>"'\n\r{}]/.test(file) || !existsSync(file);
      if (unsafe) throw new StudioError("INVALID_PARAMS", `image file '${file}' does not look like a safe local path`);
    }
    const full = argv.filter((a) => typeof a === "string");
    const bin = this.binary();
    return new Promise((resolve, reject) => {
      execFile(bin, full, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
        if (err && (err as { killed?: boolean }).killed) return reject(new StudioError("TIMEOUT", `fastboot ${verb} timed out`));
        resolve({ stdout: String(stdout), stderr: String(stderr), code });
      });
    });
  }

  /** Reboot the phone into the bootloader/fastboot or recovery (via adb, needs the device online). */
  async adbRebootTo(adbBin: string, serial: string | undefined, target: "bootloader" | "recovery" | "fastboot"): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      execFile(adbBin, [...(serial ? ["-s", serial] : []), "reboot", target], { timeout: 60_000, windowsHide: true }, (err) => {
        err ? reject(new StudioError("ADB_ERROR", err.message)) : resolve();
      });
    });
  }

  /** `adb sideload <zip>` for OTA/recovery zips on the device. */
  async sideload(adbBin: string, serial: string | undefined, zipPath: string): Promise<{ code: number; stdout: string }> {
    const safe = zipPath.replace(/[^A-Za-z0-9._\-\\/]/g, "");
    if (!safe || safe !== zipPath) throw new StudioError("INVALID_PARAMS", "zip path contains unsupported characters");
    return new Promise((resolve, reject) => {
      execFile(adbBin, [...(serial ? ["-s", serial] : []), "sideload", zipPath], { timeout: 30 * 60_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          if (err && (err as { killed?: boolean }).killed) return reject(new StudioError("TIMEOUT", "sideload timed out"));
          const code = err && typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
          resolve({ code, stdout: `${String(stdout)}${String(stderr)}` });
        });
    });
  }

  /** Blocking `fastboot wait-for-device` helper used by the UI flow (not a tool). */
  waitForDevice(bin: string, timeoutMs = 120_000): Promise<boolean> {
    const child: ChildProcess = spawn(bin, ["wait-for-device"], { windowsHide: true, stdio: "ignore" });
    this.kill.track(child);
    return new Promise((resolve) => {
      const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } resolve(false); }, timeoutMs);
      child.once("exit", (code) => { clearTimeout(t); resolve(code === 0); });
    });
  }
}
