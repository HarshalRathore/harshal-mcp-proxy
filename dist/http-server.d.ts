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
import type { SharedServices } from "./tools.js";
export declare class HttpMcpServer {
    private services;
    private port;
    private httpServer?;
    private sessions;
    private sweeper?;
    constructor(services: SharedServices, port?: number);
    start(): Promise<void>;
    shutdown(): Promise<void>;
    private handleRequest;
    /** Serve one POST: existing session, or a new session for initialize. */
    private handleMcpPost;
    /** GET (SSE stream) / DELETE (terminate) for an existing session. */
    private handleSessionRequest;
    /** Route one request through a session's transport. */
    private forward;
    /** Build a McpServer + transport pair for a new client session. */
    private createSession;
    /** Close sessions that have been quiet past the idle window. */
    private sweepIdleSessions;
    private sendJsonRpcError;
    private writeHealth;
}
