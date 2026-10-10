#!/usr/bin/env node
/**
 * Local Agent entrypoint. Run it standalone (foreground process) — the Electron
 * main process spawns it and reads the ADBSTUDIO_READY line from stdout.
 *
 *   node core/dist/cli.js [--config f] [--adb-path p] [--policy f] [--data-dir d]
 *                         [--poll-devices-ms 5000]
 *
 * stdout carries exactly one line: ADBSTUDIO_READY {json}. Everything else
 * (warnings, adb errors) goes to stderr so a parent can parse it safely.
 */
import { adbVersion, defaultConfigPath, defaultPolicyPath, expandHome, loadConfig, loadPolicyFile, resolveAdbPath } from "./config.js";
import { createAgent } from "./agent.js";
import path from "node:path";

const log = (...a: unknown[]) => console.error("[adbstudio-agent]", ...a);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const configFile = arg("config") ?? process.env.ADBSTUDIO_CONFIG ?? defaultConfigPath();
  const cfg = loadConfig(configFile);

  let adbPath: string;
  try {
    adbPath = resolveAdbPath(arg("adb-path") ?? cfg.adb?.path ?? "auto");
  } catch (e) {
    log(String(e instanceof Error ? e.message : e));
    process.exit(2);
  }
  const dataDir = expandHome(arg("data-dir") ?? cfg.storage?.dataDir ?? "~/.adbstudio");
  const policyFile = arg("policy") ?? process.env.ADBSTUDIO_POLICY ?? defaultPolicyPath();
  const endpointFile = expandHome(arg("endpoint-file") ?? cfg.agent?.endpointFile ?? "~/.adbstudio/endpoint.json");
  const controlEndpointFile = expandHome(arg("control-endpoint-file") ?? path.join(path.dirname(endpointFile), "control.json"));
  const pollDevicesMs = Number(arg("poll-devices-ms") ?? 5000);

  let policy;
  try { policy = loadPolicyFile(policyFile); } catch (e) { log(String(e instanceof Error ? e.message : e)); process.exit(2); }

  const agent = createAgent({ adbPath, dataDir, policy, config: cfg, endpointFile, controlEndpointFile, pollDevicesMs });

  const shutdown = (signal: string) => {
    log(`${signal} received — shutting down`);
    agent.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (e) => log("uncaughtException:", e));

  try {
    const ep = await agent.ready();
    log(`adb: ${adbPath} (${adbVersion(adbPath)})`);
    log(`policy: ${policyFile} mode=${policy.mode} role=${policy.role} targets=${policy.targetPackages.join(",") || "(none)"}`);
    log(`data: ${dataDir}`);
  log(`screenshots → ${agent.studio.folders.screenshots}`);
  log(`recordings  → ${agent.studio.folders.recordings}${cfg.scrcpy ? ` · scrcpy=${cfg.scrcpy.path}` : ""}`);
    log(`sqlite: ${agent.studio.db.available ? "available (studio.sqlite)" : "unavailable — continuing with JSON files"}`);
  // one machine-readable line for a parent process (Electron main); logs go to stderr
    console.log(`ADBSTUDIO_READY ${JSON.stringify({
      ready: true, pid: process.pid, adbPath,
      agent: { url: ep.agent.url, token: ep.agent.token, port: ep.agent.port, endpointFile },
      control: { url: ep.control.url, token: ep.control.token, port: ep.control.port, endpointFile: controlEndpointFile },
    })}`);
  } catch (e) {
    log("failed to start:", e);
    process.exit(1);
  }
}

void main().catch((e) => { log(String(e instanceof Error ? e.message : e)); process.exit(1); });
