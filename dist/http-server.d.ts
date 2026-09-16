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
import type { SharedServices } from "./tools.js";
export declare class HttpMcpServer {
    private services;
    private port;
    private httpServer?;
    constructor(services: SharedServices, port?: number);
    start(): Promise<void>;
    shutdown(): Promise<void>;
    private handleRequest;
    /** Serve one MCP request through a stateless Streamable HTTP transport. */
    private handleMcpPost;
    private writeHealth;
}
