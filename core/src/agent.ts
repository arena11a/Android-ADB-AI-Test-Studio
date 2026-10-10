import path from "node:path";
import { expandHome, loadPolicyFile, type AppConfig } from "./config.js";
import { createStudio, type Studio } from "./wire.js";
import { startAgentServer, type AgentServerHandle } from "./server.js";
import { ControlServer, type ControlEndpoints } from "./control.js";
import type { PolicyFile } from "./types.js";

export interface AgentOptions {
  adbPath: string;
  dataDir: string;
  /** policy file path, or an already-loaded policy object */
  policy?: PolicyFile | string;
  agentPort?: number;          // MCP bridge socket (0 = random)
  controlPort?: number;        // UI socket (0 = random)
  /** where the MCP bridge reads url+token (~/.adbstudio/endpoint.json by default) */
  endpointFile?: string;
  controlEndpointFile?: string;
  pollDevicesMs?: number;      // 0 = only refresh on request
  /** optional app.config.json sections used by the studio */
  config?: AppConfig;
}

export interface AgentEndpoints {
  agent: { url: string; token: string; port: number };
  control: ControlEndpoints;
}

/**
 * Process-level composition root: one studio, two loopback servers.
 *  - agent server   → MCP bridge (AI), actor forced to "ai"
 *  - control server → desktop UI, actor "user"
 * Both go through the same router: policy → approval → audit. ADB is only
 * ever reached from inside the studio, never from a socket handler.
 */
export function createAgent(opts: AgentOptions) {
  const dataDir = expandHome(opts.dataDir);
  const policy: PolicyFile = typeof opts.policy === "string" ? loadPolicyFile(opts.policy) : opts.policy!;
  const cfg = opts.config;
  const studio = createStudio({
    adbPath: opts.adbPath, dataDir, policy,
    database: cfg?.storage?.database,
    scrcpy: cfg?.scrcpy ? { path: cfg.scrcpy.path, extraArgs: cfg.scrcpy.extraArgs } : undefined,
    recording: cfg?.recording ? { remoteDir: cfg.recording.remoteDir, pullDir: cfg.recording.pullDir } : undefined,
    media: cfg?.media ? { shotsDir: cfg.media.shotsDir } : undefined,
  });

  const control = new ControlServer(studio, {
    port: opts.controlPort,
    endpointFile: opts.controlEndpointFile,
    pollDevicesMs: opts.pollDevicesMs,
    adbPath: opts.adbPath,
  });

  // wire.ts audits anomalies already; here we only mirror them to the UI
  const prevAnomaly = studio.policy.onAnomaly;
  studio.policy.onAnomaly = (msg: string) => { prevAnomaly?.(msg); control.broadcastAnomaly(msg); };

  let agentHandle: AgentServerHandle | undefined;
  let starting: Promise<AgentEndpoints> | undefined;

  /** Idempotent: creates both servers once and resolves with their endpoints. */
  const ready = (): Promise<AgentEndpoints> => {
    starting ??= (async () => {
      const controlEp = await control.start();
      try {
        agentHandle = startAgentServer(studio.router, opts.endpointFile ?? path.join(dataDir, "endpoint.json"), opts.agentPort ?? 0);
        await agentHandle.listening;
      } catch (e) {
        control.close();
        throw e;
      }
      const agentEp = { url: agentHandle.url, token: agentHandle.token, port: agentHandle.port };
      control.broadcastReady(agentEp.url);
      return { agent: agentEp, control: controlEp };
    })();
    return starting;
  };

  control.on("shutdown", () => close());
  // mirror window closed → tell the UI through the control socket
  studio._onScrcpyExit(() => control.broadcastMedia());

  function close(): void {
    agentHandle?.close();
    control.close();
    studio.kill.terminate();     // long-lived children (logcat) must not outlive the process
  }

  return { studio, control, ready, close, get endpoints(): Promise<AgentEndpoints> { return ready(); } };
}

export type Agent = ReturnType<typeof createAgent>;
