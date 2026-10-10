import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { homedir } from "node:os";
import { Adb } from "../adb.js";
import { StudioError } from "../types.js";
import type { PolicyEngine } from "../policy.js";

export class AppService {
  constructor(private adb: Adb, private policy: PolicyEngine) {}

  /** Targets must be listed in policy AND never be a system app. Checked again at execution time. */
  private async assertTarget(serial: string, pkg: string): Promise<void> {
    if (!this.policy.isTarget(pkg)) throw new StudioError("OUT_OF_SCOPE", `'${pkg}' is not a target app`);
    const sys = await this.adb.shell(serial, ["pm", "list", "packages", "-s", "--user", "0"]);
    if (sys.stdout.split("\n").some((l) => l.trim() === `package:${pkg}`))
      throw new StudioError("POLICY_DENIED", "System apps can never be modified");
  }

  async list(serial: string, scope: "target" | "user") {
    // --user 0 is required: OEMs with a second profile (Samsung Secure Folder = user 150)
    // make plain `pm list packages` throw "Shell does not have permission to access user 150"
    const user = (await this.adb.shell(serial, ["pm", "list", "packages", "-3", "--user", "0"])).stdout;
    const all = user.split("\n").map((l) => l.trim().replace(/^package:/, "")).filter(Boolean);
    const system = (await this.adb.shell(serial, ["pm", "list", "packages", "-s", "--user", "0"])).stdout.split("\n").length - 1;
    const targets = this.policy.policy.targetPackages;
    return { user: scope === "target" ? all.filter((p) => targets.includes(p)) : all, system_count: Math.max(0, system), targets };
  }

  async launch(serial: string, pkg: string) {
    await this.assertTarget(serial, pkg);
    const r = await this.adb.must(["shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"], { serial });
    if (/No activities found/i.test(r.stdout + r.stderr)) throw new StudioError("ADB_ERROR", "App has no launcher activity");
    return { launched: pkg };
  }

  async stop(serial: string, pkg: string) {
    await this.assertTarget(serial, pkg);
    await this.adb.shell(serial, ["am", "force-stop", pkg]);
    return { stopped: pkg };
  }

  async clearData(serial: string, pkg: string) {
    await this.assertTarget(serial, pkg);
    const r = await this.adb.shell(serial, ["pm", "clear", pkg]);
    if (!/Success/i.test(r.stdout)) throw new StudioError("ADB_ERROR", r.stdout.trim() || "clear failed");
    return { cleared: pkg };
  }

  async uninstall(serial: string, pkg: string) {
    await this.assertTarget(serial, pkg);
    const r = await this.adb.must(["uninstall", pkg], { serial });
    if (!/Success/i.test(r.stdout)) throw new StudioError("ADB_ERROR", r.stdout.trim() || "uninstall failed");
    return { uninstalled: pkg };
  }

  /** Pre-install facts shown in the approval dialog. */
  preflight(apkPath: string) {
    const real = this.checkApkPath(apkPath);
    const buf = readFileSync(real);
    return { file: path.basename(real), size: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
  }

  private checkApkPath(apkPath: string): string {
    const expand = (p: string) => p.replace(/^~/, homedir());
    if (!existsSync(apkPath) || !statSync(apkPath).isFile()) throw new StudioError("INVALID_PARAMS", "APK file not found");
    if (!apkPath.toLowerCase().endsWith(".apk")) throw new StudioError("INVALID_PARAMS", "Only .apk files can be installed");
    const real = realpathSync(apkPath); // resolves symlinks so a link can't escape the allowed folder
    const ok = this.policy.policy.localApkDirs.some((d) => {
      const dir = path.resolve(expand(d));
      return existsSync(dir) && (real === dir || real.startsWith(realpathSync(dir) + path.sep));
    });
    if (!ok) throw new StudioError("PATH_FORBIDDEN", "APK is outside the allowed local folders (policy.localApkDirs)");
    return real;
  }

  /** Install, then verify the installed package is a target (otherwise roll back). */
  async install(serial: string, apkPath: string, opts: { replace: boolean; debug: boolean }) {
    const real = this.checkApkPath(apkPath);
    const before = new Set((await this.adb.shell(serial, ["pm", "list", "packages", "-3", "--user", "0"])).stdout.split("\n"));
    const args = ["install", ...(opts.replace ? ["-r"] : []), ...(opts.debug ? ["-t"] : []), real];
    const r = await this.adb.must(args, { serial, timeoutMs: 300_000 });
    if (!/Success/i.test(r.stdout)) throw new StudioError("ADB_ERROR", r.stdout.trim().slice(0, 300) || "install failed");
    const after = (await this.adb.shell(serial, ["pm", "list", "packages", "-3", "--user", "0"])).stdout.split("\n");
    const added = after.filter((l) => l && !before.has(l)).map((l) => l.replace("package:", "").trim());
    const stray = added.filter((p) => !this.policy.isTarget(p));
    if (stray.length) {
      for (const p of stray) await this.adb.run(["uninstall", p], { serial });
      throw new StudioError("OUT_OF_SCOPE", `APK installed non-target package(s) ${stray.join(", ")} — rolled back`);
    }
    return { installed: real, newPackages: added };
  }
}
