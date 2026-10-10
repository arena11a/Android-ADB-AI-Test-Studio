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
 */
const endpointFile = (process.env.ADBSTUDIO_ENDPOINT_FILE ?? "~/.adbstudio/endpoint.json").replace(/^~/, homedir());
const { url, token } = JSON.parse(readFileSync(endpointFile, "utf8")) as { url: string; token: string };

let nextId = 1;
const pending = new Map<string, (v: any) => void>();
const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
const ready = new Promise<void>((res, rej) => { ws.once("open", res); ws.once("error", rej); });
ws.on("message", (d) => { const m = JSON.parse(String(d)); pending.get(m.id)?.(m); pending.delete(m.id); });
ws.on("close", () => process.exit(1));

async function rpc(method: string, params?: unknown): Promise<any> {
  await ready;
  const id = String(nextId++);
  return new Promise((resolve) => { pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
}

const clientName = process.env.ADBSTUDIO_CLIENT ?? "mcp";
const server = new Server({ name: "adb-ai-test-studio", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const r = await rpc("tools/list");
  // The agent holds the authoritative zod schemas; here we expose a permissive object schema + risk in the description.
  return {
    tools: r.result.map((t: { name: string; description: string; risk: string }) => ({
      name: t.name,
      description: `[risk: ${t.risk}] ${t.description} Always pass "reason" (why you need this). Use dry_run:true to propose without executing.`,
      inputSchema: { type: "object", additionalProperties: true, properties: { device: { type: "string" }, reason: { type: "string" }, dry_run: { type: "boolean" } } },
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const r = await rpc("tools/call", { name: req.params.name, arguments: req.params.arguments ?? {}, client: clientName });
  const result = r.result;
  // Screenshot: return as an image content block, never as a path
  if (result?.ok && result.data?.png_base64) {
    return { content: [{ type: "image", data: result.data.png_base64, mimeType: "image/png" }, { type: "text", text: JSON.stringify({ ...result, data: { ...result.data, png_base64: undefined } }) }] };
  }
  return { content: [{ type: "text", text: JSON.stringify(result) }], isError: result ? !result.ok : true };
});

void (async () => {
  await server.connect(new StdioServerTransport());
})().catch((e) => { console.error(String(e)); process.exit(1); });
