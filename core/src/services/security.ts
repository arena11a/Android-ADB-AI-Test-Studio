import { Adb } from "../adb.js";
import { StudioError } from "../types.js";

export interface ScanFinding {
  id: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  title: string;
  detail: string;
  /** packages involved, when the finding is about specific apps */
  packages: string[];
  /** suggested, approval-gated remediation (never automatic) */
  fix?: { tool: "app_disable" | "app_uninstall" | "app_revoke"; package?: string; hint: string };
}

export interface ScanReport {
  serial: string;
  tookMs: number;
  findings: ScanFinding[];
  stats: {
    userApps: number; systemApps: number; deviceAdmins: number;
    accessibilityServices: number; notificationListeners: number;
    unknownSources: number; debugApps: number;
  };
}

/**
 * Read-only device hygiene scan. Everything here uses fixed argv (no shell
 * strings) and only parses output — nothing is changed on the device.
 * The point is to give the AI (and the human) facts, then let the human decide.
 */
export class SecurityService {
  constructor(private adb: Adb) {}

  async scan(serial: string, riskTargets: string[] = []): Promise<ScanReport> {
    const started = Date.now();
    const sh = (argv: string[]) => this.adb.run(["shell", ...argv], { serial, timeoutMs: 25_000 });
    const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

    const [userPkgs, sysPkgs, admins, access, notif, installerAll] = await Promise.all([
      sh(["pm", "list", "packages", "-3", "--user", "0"]),
      sh(["pm", "list", "packages", "-s", "--user", "0"]),
      sh(["dumpsys", "device_policy"]),
      sh(["settings", "get", "secure", "enabled_accessibility_services"]),
      sh(["settings", "get", "secure", "enabled_notification_listeners"]),
      sh(["pm", "list", "packages", "-i", "-3", "--user", "0"]),
    ]);

    const userApps = lines(userPkgs.stdout).map((l) => l.replace(/^package:/, ""));
    const systemApps = lines(sysPkgs.stdout).length;
    const installerOf = new Map<string, string>();
    for (const l of lines(installerAll.stdout)) {
      const pkg = l.match(/package:([A-Za-z0-9_.]+)/)?.[1];
      const inst = l.match(/installerName=([^\s]+)/)?.[1];
      if (pkg && inst) installerOf.set(pkg, inst);
    }

    const adminLines = lines(admins.stdout).filter((l) => /admin=/.test(l) || /Active admin/i.test(l));
    const deviceAdmins = [...new Set(adminLines.map((l) => l.match(/([A-Za-z0-9_.]+)\/[A-Za-z0-9_.$]+/)?.[1]).filter(Boolean))] as string[];

    const accessibility = (access.stdout.match(/[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+/g) ?? []).filter((s) => s !== "null");
    const listeners = (notif.stdout.match(/[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+/g) ?? []).filter((s) => s !== "null");

    // unknown-source installs (anything not installed by the Play Store)
    const unknownSources = [...installerOf.entries()].filter(([, inst]) => !/com\.android\.vending/.test(inst));

    // apps the policy treats as targets get extra scrutiny
    const debugApps = userApps.filter((p) => riskTargets.includes(p));

    const findings: ScanFinding[] = [];

    if (deviceAdmins.length) {
      findings.push({
        id: "device_admins", severity: "high", title: "App holds Device Admin",
        detail: `${deviceAdmins.length} app(s): ${deviceAdmins.join(", ")} — most malware wants this permission to wipe data or lock the screen`,
        packages: deviceAdmins,
        fix: { tool: "app_uninstall", hint: "Uninstall unfamiliar apps (needs approval)" },
      });
    }
    if (accessibility.length > 3) {
      findings.push({
        id: "accessibility_many", severity: "medium", title: "Many accessibility services enabled",
        detail: `${accessibility.length} enabled — malware abuses these to read the screen and tap for you`,
        packages: accessibility.map((s) => s.split("/")[0]),
      });
    }
    if (unknownSources.length) {
      findings.push({
        id: "unknown_sources", severity: "medium", title: "Apps installed outside the Play Store",
        detail: `${unknownSources.length} app(s) (e.g. ${unknownSources.slice(0, 8).map(([p, i]) => `${p} ← ${i}`).join(", ")}) — check these are APKs you meant to install`,
        packages: unknownSources.map(([p]) => p),
      });
    }
    if (listeners.length) {
      findings.push({
        id: "notification_listeners", severity: "low", title: "Apps reading notifications",
        detail: `${listeners.map((s) => s.split("/")[0]).join(", ")} — these services see every notification`,
        packages: listeners.map((s) => s.split("/")[0]),
      });
    }
    // malware loves dangerous permission combos: SMS + accessibility/overlay/admin
    const suspicious = userApps.filter((p) => {
      const hasAdmin = deviceAdmins.some((a) => a === p);
      const hasAccess = accessibility.some((s) => s.startsWith(p + "/"));
      const unknown = unknownSources.some(([u]) => u === p);
      return (hasAdmin && unknown) || (hasAccess && unknown);
    });
    if (suspicious.length) {
      findings.push({
        id: "suspicious_combo", severity: "critical", title: "Suspicious packages (sideloaded + dangerous permissions)",
        detail: `${suspicious.join(", ")} — this combination is common in malware; uninstall or disable right away`,
        packages: suspicious,
        fix: { tool: "app_disable", hint: "Disable first (reversible after a reboot) or uninstall outright" },
      });
    }

    findings.push({
      id: "hint", severity: "info", title: "General advice",
      detail: "Update Android/apps from the Play Store · uninstall apps you don't use · enable Play Protect (Play Store → profile → Play Protect) · avoid APKs from untrusted sites",
      packages: [],
    });

    return {
      serial, tookMs: Date.now() - started, findings,
      stats: {
        userApps: userApps.length, systemApps, deviceAdmins: deviceAdmins.length,
        accessibilityServices: accessibility.length, notificationListeners: listeners.length,
        unknownSources: unknownSources.length, debugApps: debugApps.length,
      },
    };
  }

  /** Runtime permissions of one package: requested vs actually granted (read-only). */
  async permissions(serial: string, pkg: string): Promise<{ package: string; requested: string[]; granted: string[] }> {
    const r = await this.adb.shell(serial, ["dumpsys", "package", pkg]);
    const requested = [...new Set((r.stdout.match(/android\.permission\.[A-Z_]+/g) ?? []))];
    const granted = [...new Set((r.stdout.match(/^\s*(android\.permission\.[A-Z_]+): granted=true/gm) ?? []))]
      .map((l) => l.trim().replace(/: granted=true$/, ""));
    return { package: pkg, requested, granted };
  }
}
