#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";

/**
 * MCP stdio bridge → Local Agent (WebSocket 127.0.0.1 + bearer token).
 * It holds NO policy logic: every call is forwarded and the Agent's Policy
 * Engine / Approval Queue decide. There is no raw-shell tool here by design.
 *
 * Failure handling: every error is reported as a readable MCP error (never a
 * raw stack trace), and the bridge reconnects by itself when the agent
 * restarts (it re-reads endpoint.json, which carries the new port/token).
 */
const endpointFile = (process.env.ADBSTUDIO_ENDPOINT_FILE ?? "~/.adbstudio/endpoint.json").replace(/^~/, homedir());

interface Endpoint { url: string; token: string }

function readEndpoint(): Endpoint {
  let raw: string;
  try {
    raw = readFileSync(endpointFile, "utf8");
  } catch {
    throw new Error(
      `ADB Studio is not running (no endpoint file at ${endpointFile}). ` +
      `Start the ADB AI Test Studio app — or run "npm run agent" — then restart this MCP server.`,
    );
  }
  try {
    const ep = JSON.parse(raw) as Endpoint;
    if (!ep.url || !ep.token) throw new Error("missing url/token");
    return ep;
  } catch {
    throw new Error(`ADB Studio endpoint file ${endpointFile} is invalid — restart the app to regenerate it.`);
  }
}

let nextId = 1;
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let ws: WebSocket | null = null;
let ready: Promise<void> = Promise.reject(new Error("not connected yet"));
let stopped = false;

function failAllPending(reason: string): void {
  for (const { reject } of pending.values()) reject(new Error(reason));
  pending.clear();
}

function connect(): Promise<void> {
  let ep: Endpoint;
  try {
    ep = readEndpoint();
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
  const socket = new WebSocket(ep.url, { headers: { Authorization: `Bearer ${ep.token}` } });
  ws = socket;
  return new Promise<void>((res, rej) => {
    let settled = false;
    socket.once("open", () => { settled = true; res(); });
    socket.once("error", (e) => {
      if (!settled) rej(new Error(`Cannot reach the ADB Studio agent at ${ep.url}: ${e.message}. Is the app still open?`));
    });
    socket.on("message", (d) => {
      try {
        const m = JSON.parse(String(d)) as { id: string };
        const p = pending.get(m.id);
        if (p) { p.resolve(m); pending.delete(m.id); }
      } catch { /* ignore malformed frames */ }
    });
    socket.on("close", () => {
      failAllPending("The ADB Studio agent disconnected mid-call.");
      if (ws === socket) ws = null;
      scheduleReconnect();
    });
    socket.on("error", () => { /* close handler drives the reconnect */ });
  });
}

/** re-reads endpoint.json (new port/token after an agent restart) and reconnects */
let reconnectTimer: NodeJS.Timeout | undefined;
function scheduleReconnect(): void {
  if (stopped || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    if (stopped || ws) return;
    ready = connect();
    ready.catch(() => scheduleReconnect());
  }, 2000);
}

ready = connect();
ready.catch(() => scheduleReconnect());

async function rpc(method: string, params?: unknown): Promise<any> {
  await ready;                                     // rejects with a readable message
  const socket = ws;
  if (!socket || socket.readyState !== WebSocket.OPEN)
    throw new Error("Not connected to the ADB Studio agent — start the app, then restart this MCP server.");
  const id = String(nextId++);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`The agent did not answer '${method}' in 15s.`)); }, 15000);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    socket.send(JSON.stringify({ id, method, params }), (err) => {
      if (err) { pending.delete(id); clearTimeout(timer); reject(new Error(`Send failed: ${err.message}`)); }
    });
  });
}

const clientName = process.env.ADBSTUDIO_CLIENT ?? "mcp";
const server = new Server({ name: "adb-ai-test-studio", version: "0.1.0" }, { capabilities: { tools: {} } });

/** every handler answers with isError content instead of crashing the stdio server */
const failed = (e: unknown) => ({
  content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
  isError: true,
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  try {
    const r = await rpc("tools/list");
    // The agent holds the authoritative zod schemas; here we expose a permissive object schema + risk in the description.
    return {
      tools: r.result.map((t: { name: string; description: string; risk: string }) => ({
        name: t.name,
        description: `[risk: ${t.risk}] ${t.description} Always pass "reason" (why you need this). Use dry_run:true to propose without executing.`,
        inputSchema: { type: "object", additionalProperties: true, properties: { device: { type: "string" }, reason: { type: "string" }, dry_run: { type: "boolean" } } },
      })),
    };
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e));
  }
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    const r = await rpc("tools/call", { name: req.params.name, arguments: req.params.arguments ?? {}, client: clientName });
    const result = r.result;
    // Screenshot: return as an image content block, never as a path
    if (result?.ok && result.data?.png_base64) {
      return { content: [{ type: "image", data: result.data.png_base64, mimeType: "image/png" }, { type: "text", text: JSON.stringify({ ...result, data: { ...result.data, png_base64: undefined } }) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(result) }], isError: result ? !result.ok : true };
  } catch (e) {
    return failed(e);
  }
});

process.on("SIGINT", () => { stopped = true; process.exit(0); });
process.on("SIGTERM", () => { stopped = true; process.exit(0); });

void (async () => {
  await server.connect(new StdioServerTransport());
})().catch((e) => { console.error(String(e)); process.exit(1); });
