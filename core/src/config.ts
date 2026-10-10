import { existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { StudioError, type PolicyFile } from "./types.js";

/** Highest config/policy schemaVersion this build understands. */
export const SUPPORTED_CONFIG_VERSION = 1;
export const SUPPORTED_POLICY_VERSION = 1;

export function expandHome(p: string): string {
  return p.replace(/^~(?=$|[\\/])/, homedir());
}

/**
 * Discoverable media folders: screenshots go to Pictures, recordings to Videos
 * (Movies on macOS). Kept shallow and named after the app so users find them.
 */
export function mediaDir(kind: "pictures" | "videos", platform: NodeJS.Platform = process.platform): string {
  if (kind === "pictures") return path.join(homedir(), "Pictures", "ADB-AI-Test-Studio");
  if (platform === "darwin") return path.join(homedir(), "Movies", "ADB-AI-Test-Studio");
  return path.join(homedir(), "Videos", "ADB-AI-Test-Studio");
}

/**
 * Directory that holds config/. Resolved from the running script (not
 * import.meta, so the bundle stays CJS): repo layout is <root>/core/dist/cli.js,
 * the packaged bundle is <resources>/agent/agent.cjs with config next to it.
 */
export function repoConfigDir(): string {
  const self = process.argv[1] ? path.dirname(path.resolve(process.argv[1])) : process.cwd();
  const candidates = [
    path.resolve(process.cwd(), "config"),         // run from the repo root (npm scripts, tests)
    path.resolve(self, "..", "..", "config"),      // repo layout: <root>/core/dist/cli.js
    path.resolve(self, "config"),                  // packaged bundle: config next to the script
  ];
  return candidates.find((c) => existsSync(path.join(c, "app.config.json"))) ?? candidates[1];
}

/** cwd first (dev), then the repo copy next to the code. */
export function defaultConfigPath(): string {
  const cwdConfig = path.resolve(process.cwd(), "config", "app.config.json");
  if (existsSync(cwdConfig)) return cwdConfig;
  return path.join(repoConfigDir(), "app.config.json");
}

export function defaultPolicyPath(): string {
  return path.join(repoConfigDir(), "policy.default.json");
}

export interface AppConfig {
  schemaVersion: number;
  adb: { path: string; serverHost: string; commandTimeoutMs: number; installTimeoutMs: number };
  agent: { host: string; port: number; endpointFile: string; tokenBytes: number };
  storage: { dataDir: string; database: string; auditDir: string; artifactsDir: string };
  logs: { ringBufferLines: number; saveToFile: boolean };
  metrics: { defaultIntervalMs: number; allowedIntervalsMs: number[]; maxBufferPoints: number };
  scrcpy?: { path: string; extraArgs?: string[] };
  media?: { shotsDir?: string };
  recording?: { remoteDir: string; pullDir: string; maxSeconds?: number };
  [key: string]: unknown;
}

/** explicit type annotation so TS treats calls to it as terminating (never) */
const fail: (msg: string) => never = (msg) => { throw new Error(msg); };

function readJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) fail(`config file not found: ${file}`);
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (e) {
    fail(`config file is not valid JSON (${file}): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Loads app.config.json and refuses anything newer than we understand. */
export function loadConfig(file = defaultConfigPath()): AppConfig {
  const raw = readJson(file);
  const v = raw.schemaVersion;
  if (typeof v !== "number" || !Number.isInteger(v)) fail(`app.config.json: 'schemaVersion' must be an integer (got ${JSON.stringify(v)})`);
  if (v > SUPPORTED_CONFIG_VERSION) fail(`app.config.json schemaVersion ${v} is newer than this build supports (${SUPPORTED_CONFIG_VERSION}) — update the app`);
  for (const k of ["adb", "agent", "storage"]) if (!raw[k] || typeof raw[k] !== "object") fail(`app.config.json: missing section '${k}'`);
  return raw as unknown as AppConfig;
}

/** Loads the deny-by-default policy file. */
export function loadPolicyFile(file = defaultPolicyPath()): PolicyFile {
  const raw = readJson(file);
  const v = raw.schemaVersion;
  if (typeof v !== "number" || !Number.isInteger(v)) fail(`policy file: 'schemaVersion' must be an integer (got ${JSON.stringify(v)})`);
  if (v > SUPPORTED_POLICY_VERSION) fail(`policy schemaVersion ${v} is newer than this build supports (${SUPPORTED_POLICY_VERSION}) — update the app or edit the policy manually`);
  const pol = raw as unknown as PolicyFile;
  if (!Array.isArray(pol.targetPackages)) fail("policy file: 'targetPackages' must be an array (empty is fine)");
  if (!pol.features || typeof pol.features !== "object") fail("policy file: missing 'features'");
  return pol;
}

const SDK_RELATIVE = [
  ["Android", "Sdk", "platform-tools"],
  ["Library", "Android", "sdk", "platform-tools"],
  ["AppData", "Local", "Android", "Sdk", "platform-tools"],
];

/**
 * Finds the adb binary. "auto" order: $ADB_PATH → $PATH → common SDK folders → bundled copy.
 * Returns an absolute/available path; throws with an install hint when nothing is found.
 */
export function resolveAdbPath(configured = "auto", platform: NodeJS.Platform = process.platform): string {
  if (configured && configured !== "auto") {
    const p = expandHome(configured);
    if (!existsSync(p)) throw new Error(`adb not found at configured path '${p}' (adb.path in app.config.json)`);
    return p;
  }
  const exe = platform === "win32" ? "adb.exe" : "adb";
  const candidates: string[] = [];

  if (process.env.ADB_PATH) candidates.push(expandHome(process.env.ADB_PATH));
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) if (dir) candidates.push(path.join(dir, exe));
  for (const rel of SDK_RELATIVE) candidates.push(path.join(homedir(), ...rel, exe));
  for (const env of ["ANDROID_HOME", "ANDROID_SDK_ROOT"]) if (process.env[env]) candidates.push(path.join(expandHome(process.env[env]!), "platform-tools", exe));
  candidates.push(path.join("/opt", "android-sdk", "platform-tools", exe));
  candidates.push(path.join("/usr", "lib", "android-sdk", "platform-tools", exe));
  if (process.env.ADBSTUDIO_RESOURCES)
    candidates.push(path.join(process.env.ADBSTUDIO_RESOURCES, "bin", platform === "win32" ? "win" : "linux", exe));

  const found = candidates.find((c) => { try { return existsSync(c) && statSync(c).isFile(); } catch { return false; } });
  if (!found) throw new Error("adb not found — install Android platform-tools or set adb.path in app.config.json");
  return found;
}

/** adb version, used by the CLI to report which binary is in use. */
export function adbVersion(bin: string): string {
  try {
    return execFileSync(bin, ["version"], { encoding: "utf8", timeout: 10_000 }).split("\n")[0].trim();
  } catch {
    return "unknown version";
  }
}

/** Guards values arriving over the control socket. */
export function str(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) throw new StudioError("INVALID_PARAMS", `'${field}' must be a non-empty string`);
  return v;
}
export function num(v: unknown, field: string, min = -Infinity, max = Infinity): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
    throw new StudioError("INVALID_PARAMS", `'${field}' must be a number in [${min}, ${max}]`);
  return v;
}
