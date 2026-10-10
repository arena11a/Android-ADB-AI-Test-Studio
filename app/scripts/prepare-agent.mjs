/**
 * Bundles the Local Agent + MCP bridge into two dependency-free CJS files so
 * the packaged app carries them inside extraResources (no node_modules copy).
 * Output: app/pack/agent/{agent.cjs, mcp-bridge.cjs, config/*.json}
 */
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const out = path.join(here, "..", "pack", "agent");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [path.join(repo, "core/src/cli.ts")],
  bundle: true, platform: "node", format: "cjs", target: "node20",
  outfile: path.join(out, "agent.cjs"), logLevel: "info",
});

await build({
  entryPoints: [path.join(repo, "mcp-bridge/src/index.ts")],
  bundle: true, platform: "node", format: "cjs", target: "node20",
  outfile: path.join(out, "mcp-bridge.cjs"),
  banner: { js: "#!/usr/bin/env node" }, logLevel: "info",
});

// default config travels with the agent (main passes --config/--policy explicitly)
cpSync(path.join(repo, "config"), path.join(out, "config"), { recursive: true });
console.log("agent bundle ready:", out);
