/**
 * gateway.ts — The orchestrator that wires everything together.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  MCPGateway lifecycle:                                           │
 * │                                                                  │
 * │  1. Load config from disk                                        │
 * │  2. Create SearchEngine, JobManager, ResponseStore, Shield       │
 * │  3. Create McpServer with the gateway tools                      │
 * │  4. Start StdioServerTransport (so opencode can talk to us)      │
 * │  5. Print __MCP_GATEWAY_STDIO_READY__ (opencode waits for this)  │
 * │  6. Connect to all upstream servers in background                │
 * │  7. Watch config file for changes (hot reload)                   │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * The stdio transport starts BEFORE upstream connections finish.
 * This means opencode won't hang waiting for slow servers to connect.
 * Tools become available in the search index as each server connects.
 */
import type { SharedServices } from "./tools.js";
export declare class MCPGateway {
    private config;
    private searchEngine;
    private jobManager;
    private connections;
    private responseStore;
    private responseShield;
    private projectRegistry;
    private snapshotManager;
    private resourceMonitor;
    private services;
    private tools;
    private server;
    private lastReloadTimestamp;
    private pendingReload;
    private reloadTimer?;
    constructor(configPath?: string);
    /** Scan roots for codegraph discovery: SCAN_ROOTS env, then cwd, plus configured projects. */
    private resolveScanRoots;
    private buildStatusHolder;
    /** Execute an async job: call the tool, shield the result, keep the ref. */
    private executeJob;
    /**
     * Connect to all enabled upstream servers.
     * For lazy servers: load catalog snapshots without spawning processes.
     * For eager servers (lazy.enabled=false or prewarm=true): connect normally.
     *
     * @param forceConnect - If true, connect to ALL servers regardless of lazy
     *   setting (used by --discover to build initial snapshots).
     */
    connectAll(forceConnect?: boolean): Promise<void>;
    /**
     * Start the gateway with stdio transport. This is the main entry point
     * when used from opencode.
     *
     * IMPORTANT: The __MCP_GATEWAY_STDIO_READY__ marker is printed to stdout
     * after the stdio transport is connected. opencode waits for this before
     * sending any requests. Upstream connections happen in the background
     * AFTER stdio is ready, so the gateway starts fast even with slow servers.
     */
    startWithStdio(): Promise<void>;
    /** Load a server's snapshot into the search index. Returns tool count, or undefined when none. */
    private loadSnapshotTools;
    /**
     * Handle config file changes — reconnect modified servers, add new ones,
     * remove deleted ones. Rapid saves collapse into one reload (debounced).
     */
    private handleConfigChange;
    private applyConfigChange;
    /** Reconcile one server that exists in both old and new config. */
    private syncServer;
    /** Connect a newly enabled server, or load its snapshot when it is lazy. */
    private connectOrSnapshot;
    private removeServer;
    /**
     * Share internal services for HTTP daemon mode.
     * The HttpMcpServer reuses the same SearchEngine, ConnectionManager, etc.
     * so that all clients share one set of upstream MCP connections.
     */
    getSharedServices(): SharedServices;
    /** Graceful shutdown — stop watching, drain jobs, disconnect all */
    shutdown(): Promise<void>;
}
