import { WebSocketServer, type WebSocket } from "ws";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TOOLS } from "./tools.js";
import type { ToolRouter } from "./router.js";

export interface AgentServerHandle {
  url: string;
  token: string;
  port: number;
  /** resolves once the socket is listening and the endpoint file is written */
  listening: Promise<void>;
  close: () => void;
}

/**
 * Local-only RPC for the MCP bridge. Security:
 *  - binds 127.0.0.1 on a random port (never 0.0.0.0)
 *  - random bearer token per launch, endpoint file is 0600
 *  - Origin header must be absent (blocks browser pages from connecting)
 *  - clients may only call the tool registry; actor is forced to "ai"
 */
export function startAgentServer(router: ToolRouter, endpointFile: string, port = 0): AgentServerHandle {
  const token = randomBytes(32).toString("hex");
  let listeningResolve!: () => void;
  const listening = new Promise<void>((res) => { listeningResolve = res; });
  const wss = new WebSocketServer({
    host: "127.0.0.1", port,
    verifyClient: ({ origin, req }, done) => {
      if (origin) return done(false, 403, "browser origins not allowed");
      const got = Buffer.from(String(req.headers["authorization"] ?? "").replace(/^Bearer /, ""));
      const want = Buffer.from(token);
      if (got.length !== want.length || !timingSafeEqual(got, want)) return done(false, 401, "bad token");
      done(true);
    },
  });

  wss.on("connection", (ws: WebSocket) => {
    ws.on("message", async (raw) => {
      let msg: { id?: string; method?: string; params?: Record<string, unknown> };
      try { msg = JSON.parse(String(raw)); } catch { return ws.close(1003); }
      const reply = (r: unknown) => ws.send(JSON.stringify({ id: msg.id, result: r }));
      if (msg.method === "tools/list") {
        return reply(TOOLS.map((t) => ({ name: t.name, description: t.description, risk: t.risk, category: t.category })));
      }
      if (msg.method === "tools/call" && typeof msg.params?.name === "string") {
        const r = await router.call({
          tool: msg.params.name, params: msg.params.arguments ?? {}, actor: "ai",
          client: String(msg.params.client ?? "mcp"), sessionId: msg.params.session_id as string | undefined,
          reason: ((msg.params.arguments as Record<string, unknown> | undefined)?.reason as string | undefined),
        });
        return reply(r);
      }
      ws.send(JSON.stringify({ id: msg.id, error: "unknown method" }));
    });
  });

  wss.on("listening", () => {
    const addr = wss.address();
    const p = typeof addr === "object" && addr ? addr.port : port;
    mkdirSync(path.dirname(endpointFile), { recursive: true, mode: 0o700 });
    writeFileSync(endpointFile, JSON.stringify({ url: `ws://127.0.0.1:${p}`, token }), { mode: 0o600 });
    listeningResolve();
  });

  const close = () => { for (const c of wss.clients) c.terminate(); wss.close(); };
  const portNow = () => { const a = wss.address(); return typeof a === "object" && a ? a.port : 0; };
  return {
    get url() { return `ws://127.0.0.1:${portNow()}`; },
    get token() { return token; },
    get port() { return portNow(); },
    listening, close,
  };
}
