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
 * Endpoints:
 *   POST /mcp    — MCP Streamable HTTP (stateless, JSON responses)
 *   GET  /health — Health check
 *
 * Stateless mode: every POST gets a fresh McpServer bound to the same
 * shared services, and no session id is issued or validated — any client
 * can come and go without leaving daemon-side state behind.
 */

import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./handlers.js";
import type { SharedServices } from "./tools.js";
import { errorMessage } from "./util.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

/** Per spec, GET/DELETE /mcp only make sense for sessionful servers. */
const METHOD_NOT_ALLOWED = JSON.stringify({
  jsonrpc: "2.0",
  error: { code: -32000, message: "Method not allowed." },
  id: null,
});

export class HttpMcpServer {
  private httpServer?: http.Server;

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

    return new Promise((resolve) => {
      server.listen(this.port, () => {
        console.error(`  [http-server] Listening on port ${this.port}`);
        console.error(`  [http-server] MCP endpoint: POST http://localhost:${this.port}/mcp`);
        console.error(`  [http-server] Health check: GET http://localhost:${this.port}/health`);
        resolve();
      });
    });
  }

  shutdown(): Promise<void> {
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
      if (req.method === "POST") {
        await this.handleMcpPost(req, res);
        return;
      }
      res.writeHead(405, JSON_HEADERS);
      res.end(METHOD_NOT_ALLOWED);
      return;
    }

    res.writeHead(404, JSON_HEADERS);
    res.end(JSON.stringify({ error: "Not found" }));
  }

  /** Serve one MCP request through a stateless Streamable HTTP transport. */
  private async handleMcpPost(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, JSON_HEADERS);
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error: invalid JSON" }, id: null }));
      return;
    }

    // Fresh server per request — all instances share the gateway's services
    const server = createServer(this.services);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true, // plain JSON responses instead of SSE streams
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error(`  [http-server] Request failed: ${errorMessage(err)}`);
      if (!res.headersSent) {
        res.writeHead(500, JSON_HEADERS);
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: `Internal error: ${errorMessage(err)}` },
            id: null,
          })
        );
      }
    }
  }

  private writeHealth(res: http.ServerResponse): void {
    const status = {
      status: "ok",
      servers: this.services.connections.getConnectedServers().length,
      tools: this.services.searchEngine.getTools().length,
      uptime: process.uptime(),
      timestamp: Date.now(),
    };
    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify(status));
  }
}

/** Read a request body fully into a string. */
async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf-8");
}
