/**
 * connections.ts — Manages connections to upstream MCP servers.
 *
 * For each upstream server in the config:
 *   1. Spawns a Client + StdioClientTransport (local) or StreamableHTTP/WebSocket (remote)
 *   2. Calls listTools() on connect and registers all tools into the SearchEngine
 *   3. Supports retry with exponential backoff (5 retries, starting at 1s)
 *   4. Suppresses noisy JSON parse errors from server stderr
 *   5. Self-heals: a dropped connection is removed so the next invoke reconnects
 *
 * Environment variable substitution:
 *   {env:VAR_NAME} in config.environment fields gets replaced with process.env values.
 *   This lets you keep secrets in shell env instead of the config file.
 *
 * Lazy loading: servers can be connected on demand via ensureConnected(),
 * with an idle monitor that disconnects them after their configured idle
 * timeout, RAM cap, or uptime cap is exceeded.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ConnectionState } from "./types.js";
import type { UpstreamConfig } from "./config.js";
import type { CatalogSnapshotManager } from "./catalog-snapshot.js";
import type { ResourceMonitor } from "./resource-monitor.js";
import type { SearchEngine } from "./search.js";
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
     * config.command is split into [executable, ...args]. Config environment
     * is merged over the parent env so servers inherit PATH etc.
     */
    private connectLocal;
    /**
     * Connect to a remote (HTTP/WebSocket) upstream MCP server.
     * Auto-detects transport: ws:// → websocket, http:// → streamable_http.
     * Remote transport imports are dynamic to avoid loading unused transports.
     */
    private connectRemote;
    /**
     * Shared connection logic for both transports.
     * Creates a Client, connects it, records lifecycle info, then refreshes
     * the tool catalog.
     */
    private connectTransport;
    /**
     * Fetch listTools() from upstream, register each tool in the search
     * engine, and save a snapshot for lazy-loading catalog persistence.
     */
    private refreshCatalog;
    /**
     * Connect with retry — exponential backoff.
     * 5 attempts: 1s, 2s, 4s, 8s, 16s before giving up.
     */
    connectWithRetry(serverKey: string, config: UpstreamConfig, maxRetries?: number, baseDelayMs?: number): Promise<void>;
    /**
     * Ensure a server is connected, connecting on demand if necessary.
     * Deduplicates concurrent attempts and honors the server's configured
     * connectionTimeoutMs (the retry loop keeps running if it times out and
     * may still succeed — a later call then finds the client connected).
     */
    ensureConnected(serverKey: string): Promise<Client>;
    /** Mark a server as recently used (called after successful invoke) */
    markServerUsed(serverKey: string): void;
    /** Get a connected Client by server key (for invoking tools). */
    getClient(serverKey: string): Client | undefined;
    /** Disconnect a single server. Does NOT remove tools from the catalog. */
    disconnect(serverKey: string): Promise<void>;
    /** Fully remove a server: disconnect + drop tools + delete snapshot */
    removeServer(serverKey: string): Promise<void>;
    /** Disconnect all upstream servers */
    disconnectAll(): Promise<void>;
    /** List all currently connected server keys */
    getConnectedServers(): string[];
    getConnectionState(serverKey: string): ConnectionState;
    /** Start the periodic lazy-server check (idempotent) */
    startIdleMonitor(checkIntervalMs: number): void;
    /** Stop the idle monitor */
    stopIdleMonitor(): void;
    /**
     * For each connected lazy server, disconnect when it has been idle past
     * idleTimeoutMs, exceeded maxRamMb, or exceeded maxUptimeMs.
     */
    private checkConnectedServers;
}
