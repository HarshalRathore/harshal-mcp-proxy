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
 *
 * Lazy loading: servers can be connected on demand via ensureConnected(),
 * with idle timeout auto-disconnect and resource monitoring.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ConnectionState, ServerStats, UpstreamConfig } from "./types.js";
import type { CatalogSnapshotManager } from "./catalog-snapshot.js";
import type { ResourceMonitor } from "./resource-monitor.js";
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
    /** Connection state tracking per server */
    private states;
    /** Deduplication for concurrent on-demand connects */
    private connectingPromises;
    /** Lazy dependencies — set by gateway after construction */
    private configProvider?;
    private snapshotManager?;
    private resourceMonitor?;
    /** Idle monitor timer */
    private idleMonitorId?;
    constructor(searchEngine: SearchEngine);
    setConfigProvider(provider: () => Record<string, UpstreamConfig>): void;
    setSnapshotManager(manager: CatalogSnapshotManager): void;
    setResourceMonitor(monitor: ResourceMonitor): void;
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
     * Also saves a snapshot for lazy-loading catalog persistence.
     */
    private refreshCatalog;
    /** Count how many tools a specific server has registered */
    private countTools;
    /**
     * Connect with retry — exponential backoff.
     * 5 attempts: 1s, 2s, 4s, 8s, 16s before giving up.
     */
    connectWithRetry(serverKey: string, config: UpstreamConfig, maxRetries?: number, baseDelay?: number): Promise<void>;
    /** Get a connected Client by server key (for invoking tools). */
    getClient(serverKey: string): Client | undefined;
    /** Disconnect a single server. Does NOT remove tools from the catalog. */
    disconnect(serverKey: string): Promise<void>;
    /** Fully remove a server: disconnect + remove tools from catalog + delete snapshot */
    removeServer(serverKey: string): Promise<void>;
    /**
     * Ensure a server is connected, connecting on demand if necessary.
     * Deduplicates concurrent connection attempts for the same server.
     */
    ensureConnected(serverKey: string): Promise<Client>;
    /** Mark a server as recently used (called after successful invoke) */
    markServerUsed(serverKey: string): void;
    /**
     * Start periodic idle check. For each connected lazy server,
     * disconnect if idle timeout exceeded or RAM limit exceeded.
     */
    startIdleMonitor(checkIntervalMs: number): void;
    /** Stop the idle monitor */
    stopIdleMonitor(): void;
    getConnectionState(serverKey: string): ConnectionState;
    getServerStats(serverKey: string): ServerStats | null;
    /** Disconnect all upstream servers */
    disconnectAll(): Promise<void>;
    /** List all currently connected server keys */
    getConnectedServers(): string[];
}
