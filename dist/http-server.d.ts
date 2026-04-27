/**
 * http-server.ts — HTTP daemon mode for harshal-mcp-proxy.
 *
 * When started with --port (or --daemon), harshal-mcp-proxy binds to
 * an HTTP port and speaks MCP's Streamable HTTP transport (JSON-RPC 2.0).
 *
 * This lets multiple clients (pi sessions, VS Code) share ONE set of
 * upstream MCP servers instead of each client spawning its own fleet.
 *
 * JSON-RPC 2.0 endpoints:
 *   POST /mcp — MCP protocol (initialize, tools/list, tools/call, ping)
 *   GET  /health — Health check
 *
 * The MCP protocol flow:
 *   1. Client sends "initialize" → server returns capabilities
 *   2. Client sends "notifications/initialized" (no response needed)
 *   3. Client sends "tools/list" → server returns 6 gateway tool schemas
 *   4. Client sends "tools/call" with tool name + args → server executes
 */
import type { SearchEngine } from "./search.js";
import type { ConnectionManager } from "./connections.js";
import type { JobManager } from "./jobs.js";
import type { ResponseStore, ResponseShield } from "./response-store.js";
import type { ProjectRegistry } from "./projectRegistry.js";
import type { StatusHolder } from "./handlers.js";
export declare class HttpMcpServer {
    private searchEngine;
    private connections;
    private jobManager;
    private responseStore;
    private responseShield;
    private projectRegistry?;
    private statusHolder?;
    private httpServer?;
    private port;
    private initialized;
    constructor(searchEngine: SearchEngine, connections: ConnectionManager, jobManager: JobManager, responseStore: ResponseStore, responseShield: ResponseShield, projectRegistry?: ProjectRegistry | undefined, statusHolder?: StatusHolder | undefined, port?: number);
    start(): Promise<void>;
    shutdown(): Promise<void>;
    private handleHealth;
    private handleJsonRpc;
    private processRequest;
    private handleInitialize;
    private handleToolsList;
    private handleToolsCall;
    private executeSearch;
    private executeDescribe;
    private executeInvoke;
    private executeInvokeAsync;
    private executeInvokeStatus;
    private executeGetResult;
}
