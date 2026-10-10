import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

export interface Endpoints {
  agent: { url: string; token: string; port: number; endpointFile: string };
  control: { url: string; token: string; port: number; endpointFile: string };
  pid: number;
  adbPath: string;
}

/** Where the compiled agent lives: bundled next to the app, or in the repo while developing. */
export function agentScript(): string {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, "agent", "agent.cjs");
    if (existsSync(bundled)) return bundled;
  }
  // dist-electron/main/index.js → <repo>/core/dist/cli.js
  return path.resolve(__dirname, "..", "..", "..", "core", "dist", "cli.js");
}

export function agentCwd(): string {
  return path.resolve(agentScript(), "..", "..", "..");
}

/**
 * A real node binary is preferred over "Electron as node": native modules
 * (better-sqlite3) are built for the system Node ABI, so SQLite only works
 * there. When no node exists on the machine we fall back to Electron's own
 * runtime and the agent keeps working with its JSON store (by design).
 */
function findNode(): string | undefined {
  const exe = process.platform === "win32" ? "node.exe" : "node";
  const dirs = [process.env.ADBSTUDIO_NODE, ...(process.env.PATH ?? "").split(path.delimiter)].filter(Boolean) as string[];
  for (const d of dirs) {
    const c = d.endsWith(exe) ? d : path.join(d, exe);
    try { if (existsSync(c) && statSync(c).isFile()) return c; } catch { /* keep looking */ }
  }
  return undefined;
}

/**
 * Owns the Local Agent child process. The UI never runs adb itself — only the
 * agent does, and it dies with the app (SIGTERM, which also kills its adb children).
 */
export class AgentProcess {
  private child?: ChildProcess;
  private endpoints?: Endpoints;
  private starting?: Promise<Endpoints>;
  private startedAt: number | null = null;
  private restarts = 0;
  private stopping = false;
  /** which JS runtime the agent runs under (affects native module support) */
  runtime: "node" | "electron" = "electron";

  constructor(
    private onLog: (line: string) => void,
    private onCrash: (code: number | null) => void,
  ) {}

  get running(): boolean { return !!this.child && this.child.exitCode === null; }
  get ready(): Endpoints | undefined { return this.endpoints; }

  /** node → agent script (+ explicit config paths when packaged) */
  private spawnCommand(): { bin: string; args: string[]; env: NodeJS.ProcessEnv } {
    const args = this.scriptArgs();
    const node = findNode();
    return node
      ? { bin: node, args, env: process.env }
      : { bin: process.execPath, args, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } };
  }

  /** argv for the child: in a package the config travels inside resources/agent */
  private scriptArgs(): string[] {
    if (!app.isPackaged) return [agentScript()];
    const dir = path.join(process.resourcesPath, "agent");
    return [
      agentScript(),
      "--config", path.join(dir, "config", "app.config.json"),
      "--policy", path.join(dir, "config", "policy.default.json"),
    ];
  }

  async start(): Promise<Endpoints> {
    if (this.endpoints) return this.endpoints;
    if (this.starting) return this.starting;

    this.stopping = false;
    this.starting = new Promise<Endpoints>((resolve, reject) => {
      const timer = setTimeout(() => { this.starting = undefined; reject(new Error("agent did not report ready within 30s")); }, 30_000);
      const { bin, args, env } = this.spawnCommand();
      this.runtime = bin === process.execPath ? "electron" : "node";
      const child = spawn(bin, args, { cwd: agentCwd(), env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      this.child = child;
      this.startedAt = Date.now();

      let buffer = "";
      const onLine = (line: string) => {
        this.onLog(line);
        if (line.startsWith("ADBSTUDIO_READY")) console.error("[agent] ready:", line.slice(0, 120));
        if (line.startsWith("ADBSTUDIO_READY ")) {
          try {
            const ep = JSON.parse(line.slice("ADBSTUDIO_READY ".length)) as Endpoints;
            this.endpoints = ep;
            clearTimeout(timer);
            resolve(ep);
          } catch { /* keep waiting */ }
        }
      };
      child.stdout?.on("data", (d: Buffer) => {
        buffer += d.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const l of lines.filter(Boolean)) onLine(l);
      });
      child.stderr?.on("data", (d: Buffer) => { for (const l of String(d).split("\n").filter(Boolean)) { this.onLog(l); console.error("[agent]", l); } });
      child.once("exit", (code) => {
        this.endpoints = undefined;
        this.starting = undefined;
        clearTimeout(timer);
        this.child = undefined;
        if (!this.stopping) { this.restarts++; this.onCrash(code); }
      });
    });
    return this.starting;
  }

  restart(): Promise<Endpoints> {
    this.stop();
    return this.start();
  }

  stop(): void {
    if (!this.child) return;
    this.stopping = true;
    try { this.child.kill("SIGTERM"); } catch { /* already gone */ }
    const c = this.child;
    setTimeout(() => { if (c.exitCode === null) { try { c.kill("SIGKILL"); } catch { /* gone */ } } }, 3000).unref();
  }

  status() {
    return {
      running: this.running,
      startedAt: this.startedAt,
      adbPath: this.endpoints?.adbPath,
      error: this.child && this.child.exitCode !== null ? `exited with code ${this.child.exitCode}` : undefined,
      restarts: this.restarts,
    };
  }
}
