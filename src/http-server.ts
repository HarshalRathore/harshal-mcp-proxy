/**
 * http-server.ts — HTTP daemon mode for harshal-mcp-proxy.
 *
 * When started with --port (or --daemon), harshal-mcp-proxy binds to an
 * HTTP port and speaks MCP's Streamable HTTP transport via the official
 * SDK transport, so protocol details (initialize handshake, sessions,
 * content negotiation, notifications) are handled by the SDK.
 *
 * This lets multiple clients (pi sessions, VS Code) share ONE set of
 * upstream MCP servers instead of each client spawning its own fleet.
 *
 * Session mode: each client session (initialize → Mcp-Session-Id) gets ONE
 * McpServer + transport pair that serves every request in that session.
 * Per-request work stays at protocol routing — no tool registration, no
 * schema conversion, no per-request server/transport construction — which
 * keeps RSS flat under sustained traffic.
 *
 * Sessions close when a client sends DELETE; clients that vanish without
 * one are swept after an idle window (MCP_SESSION_IDLE_MINUTES, default
 * 120; 0 disables). The SDK client does not re-initialize itself after a
 * 404, so the window is deliberately long — an agent idle past it sees
 * one "session expired" error and reconnects.
 *
 * Endpoints:
 *   POST   /mcp    — MCP Streamable HTTP (initialize + all requests)
 *   GET    /mcp    — server→client SSE stream for an existing session
 *   DELETE /mcp    — terminate a session
 *   GET    /health — Health check
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./handlers.js";
import type { SharedServices } from "./tools.js";
import { errorMessage, isPlainObject } from "./util.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

const SESSION_HEADER = "mcp-session-id";

/** Close sessions that have been quiet for this long (0 disables the sweep). */
const SESSION_IDLE_MS = Number(process.env.MCP_SESSION_IDLE_MINUTES ?? 120) * 60_000;

/** How often to look for idle sessions. */
const SESSION_SWEEP_MS = 10 * 60_000;

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastActiveAt: number;
}

export class HttpMcpServer {
  private httpServer?: http.Server;
  private sessions = new Map<string, Session>();
  private sweeper?: ReturnType<typeof setInterval>;

  constructor(private services: SharedServices, private port = 8765) {}

  start(): Promise<void> {
    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    this.httpServer = server;

    server.on("error", (err: Error) => {
      console.error(`  [http-server] Failed to start: ${err.message}`);
      process.exit(1);
    });

    this.sweeper = setInterval(() => this.sweepIdleSessions(), SESSION_SWEEP_MS);
    this.sweeper.unref();

    return new Promise((resolve) => {
      server.listen(this.port, () => {
        console.error(`  [http-server] Listening on port ${this.port}`);
        console.error(`  [http-server] MCP endpoint: POST http://localhost:${this.port}/mcp`);
        console.error(`  [http-server] Health check: GET http://localhost:${this.port}/health`);
        resolve();
      });
    });
  }

  async shutdown(): Promise<void> {
    clearInterval(this.sweeper);
    for (const session of [...this.sessions.values()]) {
      void session.transport.close();
      void session.server.close();
    }
    this.sessions.clear();

    return new Promise((resolve) => {
      if (!this.httpServer) return resolve();
      this.httpServer.close(() => resolve());
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    for (const [name, value] of Object.entries(CORS_HEADERS)) {
      res.setHeader(name, value);
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? "";
    if (req.method === "GET" && url === "/health") {
      this.writeHealth(res);
      return;
    }

    if (url === "/" || url === "/mcp") {
      switch (req.method) {
        case "POST":
          return void (await this.handleMcpPost(req, res));
        case "GET":
          return void (await this.handleSessionRequest(req, res));
        case "DELETE":
          return void (await this.handleSessionRequest(req, res));
        default:
          res.writeHead(405, JSON_HEADERS);
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
          return;
      }
    }

    res.writeHead(404, JSON_HEADERS);
    res.end(JSON.stringify({ error: "Not found" }));
  }

  /** Serve one POST: existing session, or a new session for initialize. */
  private async handleMcpPost(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      this.sendJsonRpcError(res, 400, -32700, "Parse error: invalid JSON");
      return;
    }

    const sessionId = getSessionId(req);
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (session) {
      session.lastActiveAt = Date.now();
      await this.forward(session, req, res, body);
      return;
    }

    // A known-but-expired session id → 404 so the client re-initializes
    if (sessionId) {
      this.sendJsonRpcError(res, 404, -32001, "Session expired, please reinitialize");
      return;
    }

    // No session id: only initialize may open a session (per spec)
    if (!isPlainObject(body) || body["method"] !== "initialize") {
      this.sendJsonRpcError(res, 400, -32600, "Bad Request: Mcp-Session-Id header is required");
      return;
    }

    const newSession = await this.createSession();
    await this.forward(newSession, req, res, body);
  }

  /** GET (SSE stream) / DELETE (terminate) for an existing session. */
  private async handleSessionRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const sessionId = getSessionId(req);
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session) {
      this.sendJsonRpcError(res, sessionId ? 404 : 400, -32001, "Bad Request: no valid session");
      return;
    }
    session.lastActiveAt = Date.now();
    await this.forward(session, req, res);
  }

  /** Route one request through a session's transport. */
  private async forward(session: Session, req: http.IncomingMessage, res: http.ServerResponse, body?: unknown): Promise<void> {
    try {
      await session.transport.handleRequest(req, res, body);
    } catch (err) {
      console.error(`  [http-server] Request failed: ${errorMessage(err)}`);
      if (!res.headersSent) {
        this.sendJsonRpcError(res, 500, -32603, `Internal error: ${errorMessage(err)}`);
      }
    }
  }

  /** Build a McpServer + transport pair for a new client session. */
  private async createSession(): Promise<Session> {
    let session: Session | undefined;

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true, // plain JSON responses instead of SSE streams
      onsessioninitialized: (sessionId: string) => {
        if (session) this.sessions.set(sessionId, session);
        console.error(`  [http-server] Session opened (${this.sessions.size} active)`);
      },
    });

    const server = createServer(this.services);
    session = { transport, server, lastActiveAt: Date.now() };

    transport.onclose = () => {
      if (transport.sessionId) this.sessions.delete(transport.sessionId);
      void server.close();
      console.error(`  [http-server] Session closed (${this.sessions.size} active)`);
    };

    await server.connect(transport);
    return session;
  }

  /** Close sessions that have been quiet past the idle window. */
  private sweepIdleSessions(): void {
    if (SESSION_IDLE_MS <= 0) return;
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [sessionId, session] of this.sessions) {
      if (session.lastActiveAt < cutoff) {
        console.error(`  [http-server] Sweeping idle session ${sessionId}`);
        void session.transport.close(); // triggers onclose → cleanup
      }
    }
  }

  private sendJsonRpcError(res: http.ServerResponse, status: number, code: number, message: string): void {
    res.writeHead(status, JSON_HEADERS);
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
  }

  private writeHealth(res: http.ServerResponse): void {
    const status = {
      status: "ok",
      servers: this.services.connections.getConnectedServers().length,
      tools: this.services.searchEngine.getTools().length,
      sessions: this.sessions.size,
      uptime: process.uptime(),
      timestamp: Date.now(),
    };
    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify(status));
  }
}

/** Read the Mcp-Session-Id header (string or single-element array). */
function getSessionId(req: http.IncomingMessage): string | undefined {
  const raw = req.headers[SESSION_HEADER];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

/** Read a request body fully into a string. */
async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf-8");
}
