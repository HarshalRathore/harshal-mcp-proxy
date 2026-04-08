/**
 * connections.ts — Manages connections to upstream MCP servers.
 *
 * For each upstream server in the config:
 *   1. Spawns a Client + StdioClientTransport (local) or StreamableHTTP/WebSocket (remote)
 *   2. Calls listTools() on connect and registers all tools into the SearchEngine
 *   3. Supports retry with exponential backoff (5 retries, starting at 1s)
 *   4. Suppresses noisy JSON parse errors from server stderr
 *
 * Environment variable substitution:
 *   {env:VAR_NAME} in config.environment fields gets replaced with process.env values.
 *   This lets you keep secrets in shell env instead of the config file.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { UpstreamConfig } from "./types.js";
import { SearchEngine } from "./search.js";
/**
 * Replace {env:VAR_NAME} patterns with actual environment variable values.
 * If the env var is not set, the placeholder becomes empty string.
 */
export declare function parseEnvironmentVariables(env?: Record<string, string>): Record<string, string> | undefined;
export declare class ConnectionManager {
    private searchEngine;
    /** Active upstream client connections keyed by server name */
    private upstreams;
    constructor(searchEngine: SearchEngine);
    /** Connect to a single upstream server (dispatches to local or remote) */
    connect(serverKey: string, config: UpstreamConfig): Promise<void>;
    /**
     * Connect to a local (stdio) upstream MCP server.
     *
     * The config.command array is split into [executable, ...args].
     * Environment variables from config.environment are merged with
     * the parent process env after {env:VAR} substitution.
     */
    private connectLocal;
    /**
     * Connect to a remote (HTTP/WebSocket) upstream MCP server.
     *
     * Auto-detects transport:
     *   ws:// or wss:// → WebSocketClientTransport
     *   http:// or https:// → StreamableHTTPClientTransport
     *
     * NOTE: Remote transport imports are dynamic to avoid bundling
     * unnecessary dependencies if you only use local servers.
     */
    private connectRemote;
    /**
     * Shared connection logic for both local and remote transports.
     * Creates a Client, connects it, then refreshes the tool catalog.
     */
    private connectTransport;
    /**
     * Fetch listTools() from upstream and register each tool in the search engine.
     * This is where we capture the full inputSchema for later use by gateway.describe.
     */
    private refreshCatalog;
    /** Count how many tools a specific server has registered */
    private countTools;
    /**
     * Connect with retry — exponential backoff.
     * 5 attempts: 1s, 2s, 4s, 8s, 16s before giving up.
     */
    connectWithRetry(serverKey: string, config: UpstreamConfig, maxRetries?: number, baseDelay?: number): Promise<void>;
    /** Get a connected Client by server key (for invoking tools) */
    getClient(serverKey: string): Client | undefined;
    /** Disconnect a single server and remove its tools from the catalog */
    disconnect(serverKey: string): Promise<void>;
    /** Disconnect all upstream servers */
    disconnectAll(): Promise<void>;
    /** List all currently connected server keys */
    getConnectedServers(): string[];
}
