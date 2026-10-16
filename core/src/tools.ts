import { z } from "zod";
import type { Category, Risk, ToolDef } from "./types.js";

export const SERIAL_RE = /^[A-Za-z0-9._:\-]{1,64}$/;
export const PKG_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const REMOTE_PATH = z.string().min(1).max(512).regex(/^\/[^\0\r\n]*$/, "absolute device path required");
const LOCAL_PATH = z.string().min(1).max(1024).regex(/^[^\0\r\n]+$/);

export const KEYS = [
  "BACK", "HOME", "APP_SWITCH", "VOLUME_UP", "VOLUME_DOWN", "ENTER", "TAB", "DEL",
  "DPAD_UP", "DPAD_DOWN", "DPAD_LEFT", "DPAD_RIGHT", "DPAD_CENTER",
] as const;

const common = {
  device: z.string().regex(SERIAL_RE).optional(),
  reason: z.string().max(500).optional(),
  dry_run: z.boolean().optional(),
};
const pkg = z.string().regex(PKG_RE).max(200);

export const Selector = z
  .object({
    text: z.string().max(200).optional(),
    resource_id: z.string().max(200).optional(),
    content_desc: z.string().max(200).optional(),
  })
  .strict()
  .refine((s) => Object.values(s).some(Boolean), "selector needs at least one field");

function def(
  name: string, category: Category, risk: Risk, mutates: boolean,
  description: string, shape: z.ZodRawShape = {},
): ToolDef {
  return { name, category, risk, mutates, description, schema: z.object({ ...common, ...shape }).strict() };
}

export const TOOLS: ToolDef[] = [
  // device
  def("device_list", "device", "low", false, "List connected Android devices and their states."),
  def("device_info", "device", "low", false, "Model, manufacturer, Android version, battery, IP."),
  def("device_connect", "device", "medium", true, "Connect to a device over Wi-Fi ADB (trusted network only).", {
    host: z.string().regex(/^[A-Za-z0-9.\-]{1,253}$/), port: z.number().int().min(1024).max(65535).default(5555),
  }),
  def("device_disconnect", "device", "low", true, "Disconnect a Wi-Fi ADB device."),
  // app
  def("app_list", "app", "low", false, "List installed apps.", { scope: z.enum(["target", "user"]).default("target") }),
  def("app_launch", "app", "medium", true, "Launch a target app.", { package: pkg }),
  def("app_stop", "app", "medium", true, "Force-stop a target app.", { package: pkg }),
  def("app_install", "app", "high", true, "Install an APK from an allowed local folder.", {
    apk_path: LOCAL_PATH, replace: z.boolean().default(true), debug: z.boolean().default(false),
  }),
  def("app_uninstall", "app", "high", true, "Uninstall a target app.", { package: pkg }),
  def("app_clear_data", "app", "high", true, "Clear data of a target app.", { package: pkg }),
  // files
  def("file_list", "file", "low", false, "List a folder inside the allowed sandbox.", { path: REMOTE_PATH }),
  def("file_pull", "file", "medium", true, "Copy a file from the device to the computer.", { remote: REMOTE_PATH, local: LOCAL_PATH.optional() }),
  def("file_push", "file", "high", true, "Copy a file from the computer to the device.", { local: LOCAL_PATH, remote: REMOTE_PATH }),
  def("file_delete", "file", "high", true, "Delete a file/folder inside the sandbox.", { path: REMOTE_PATH, recursive: z.boolean().default(false) }),
  // screen & input
  def("screenshot", "screen", "low", false, "Capture a screenshot (PNG)."),
  def("ui_hierarchy", "screen", "low", false, "Dump UI hierarchy as JSON elements."),
  def("tap", "input", "medium", true, "Tap an element or coordinate (target app must be in foreground).", {
    selector: Selector.optional(), x: z.number().int().min(0).max(10000).optional(), y: z.number().int().min(0).max(10000).optional(),
  }),
  def("swipe", "input", "medium", true, "Swipe between two points.", {
    x1: z.number().int().min(0), y1: z.number().int().min(0), x2: z.number().int().min(0), y2: z.number().int().min(0),
    duration_ms: z.number().int().min(50).max(5000).default(300),
  }),
  def("type_text", "input", "medium", true, "Type ASCII text into the focused field (max 200 chars).", { text: z.string().min(1).max(200) }),
  def("press_key", "input", "medium", true, "Press a navigation/system key.", { key: z.enum(KEYS) }),
  // logs / metrics
  def("logs_read", "logs", "low", false, "Read recent logcat lines (redacted).", {
    level: z.enum(["V", "D", "I", "W", "E", "F"]).default("W"),
    tag: z.string().max(100).optional(), contains: z.string().max(200).optional(),
    lines: z.number().int().min(1).max(1000).default(200), target_only: z.boolean().default(true),
  }),
  def("metrics_read", "metrics", "low", false, "Sample CPU/RAM/battery/storage metrics.", {
    package: pkg.optional(), seconds: z.number().int().min(1).max(60).default(5), interval_ms: z.union([z.literal(1000), z.literal(2000), z.literal(5000)]).default(2000),
  }),
  // sessions / report
  def("session_start", "session", "medium", true, "Start a test session.", {
    name: z.string().min(1).max(120), goal: z.string().max(1000).optional(), package: pkg,
    max_steps: z.number().int().min(1).max(1000).optional(), max_seconds: z.number().int().min(10).max(7200).optional(),
  }),
  def("session_stop", "session", "low", true, "Stop the current test session.", { stop_reason: z.string().max(200).optional() }),
  def("report_create", "report", "low", false, "Generate a report for a session.", {
    session_id: z.string().max(64), format: z.enum(["html", "md", "json"]).default("html"),
    lang: z.enum(["th", "en"]).optional(),
  }),
  // power (never bootloader/recovery for AI)
  def("power_request_reboot", "power", "critical", true, "Request a normal reboot (always needs human approval).", {
    mode: z.enum(["normal", "bootloader", "recovery"]).default("normal"),
  }),

  // ---------- security / repair (read-only diagnostics: AI may use these in `repair` mode) ----------
  def("security_scan", "security", "low", false,
    "Read-only hygiene scan: device admins, accessibility/notification listeners, unknown-source installs, suspicious combos.",
    { packages: z.array(pkg).max(50).optional() }),
  def("device_admins", "security", "low", false, "List active device-admin apps (what can lock/wipe the device)."),
  def("app_permissions", "security", "low", false, "Requested vs granted runtime permissions of a package.", { package: pkg }),

  // ---------- repair actions (human-initiated, always approved) ----------
  def("app_disable", "security", "high", true, "Disable a target package for its user (keep data, reversible).", {
    package: pkg, keep_data: z.boolean().default(true),
  }),
  def("app_revoke", "security", "high", true, "Revoke one runtime permission of a target app.", {
    package: pkg,
    permission: z.string().regex(/^android\.permission\.[A-Z_0-9]+$/),
  }),
  def("app_force_stop", "security", "medium", true, "Force-stop a target app.", { package: pkg }),

  // ---------- bootloader mode (HUMAN ONLY — the policy engine denies these for AI in any mode) ----------
  def("boot_reboot_target", "bootloader", "critical", true,
    "Reboot the device into the bootloader (fastboot) or recovery via adb.", {
      target: z.enum(["bootloader", "recovery"]), device: z.string().regex(SERIAL_RE).optional(),
    }),
  def("fastboot_info", "bootloader", "low", false, "Read-only fastboot info (devices, getvar).", {
    sub: z.enum(["devices", "getvar_current_slot"]),
  }),
  def("fastboot_reboot", "bootloader", "critical", true, "Reboot from fastboot back into the system/recovery/bootloader.", {
    to: z.enum(["system", "recovery", "bootloader"]),
  }),
  def("fastboot_unlock", "bootloader", "critical", true,
    "Unlock the bootloader. THIS WIPES THE DEVICE. Requires typed confirmation and a human.", {
    expect: z.literal("WIPE-ALL-DATA"),
  }),
  def("adb_sideload", "bootloader", "critical", true,
    "Apply an OTA/recovery zip with `adb sideload`. Requires typed confirmation and a human.", {
    zip: LOCAL_PATH, expect: z.literal("SIDELOAD"),
    wipe_data: z.boolean().default(false),
  }),

  // ---------- more bootloader operations (all human-only) ----------
  /**
   * Partitions we allow flashing. Deliberately narrow: nothing that can brick
   * the device in one typo (no `boot`+`system` in one go, no raw partition names).
   */
  def("fastboot_flash", "bootloader", "critical", true,
    "Flash a partition image (boot/init_boot/recovery/vendor_boot/dtbo/vbmeta/modem).",
    {
      partition: z.enum(["boot", "init_boot", "recovery", "vendor_boot", "dtbo", "vbmeta", "vbmeta_system", "modem"]),
      image: LOCAL_PATH,
      expect: z.literal("FLASH"),
      wipe: z.boolean().default(false),
    }),
  def("fastboot_set_active", "bootloader", "high", true, "Set the active A/B slot.", {
    slot: z.enum(["a", "b"]),
  }),
  def("fastboot_lock", "bootloader", "critical", true,
    "Re-lock the bootloader. Requires typed confirmation.", { expect: z.literal("RE-LOCK") }),
  def("fastboot_erase", "bootloader", "critical", true,
    "Erase userdata or cache. Requires typed confirmation; userdata erases all data.",
    {
      partition: z.enum(["userdata", "cache", "metadata"]),
      expect: z.literal("ERASE"),
    }),
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));
