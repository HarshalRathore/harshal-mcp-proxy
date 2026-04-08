/**
 * gateway.ts — The orchestrator that wires everything together.
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  MCPGateway lifecycle:                                           │
 * │                                                                  │
 * │  1. Load config from disk                                        │
 * │  2. Create SearchEngine, JobManager, ResponseStore, Shield       │
 * │  3. Create McpServer with 6 gateway tools                        │
 * │  4. Start StdioServerTransport (so opencode can talk to us)      │
 * │  5. Print __MCP_GATEWAY_STDIO_READY__ (opencode waits for this)  │
 * │  6. Connect to all upstream servers in background                 │
 * │  7. Watch config file for changes (hot reload)                   │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * The stdio transport starts BEFORE upstream connections finish.
 * This means opencode won't hang waiting for slow servers to connect.
 * Tools become available in the search index as each server connects.
 */
export declare class MCPGateway {
    private config;
    private searchEngine;
    private jobManager;
    private connections;
    private responseStore;
    private responseShield;
    private server;
    constructor(configPath?: string);
    /**
     * Connect to all enabled upstream servers.
     * Uses Promise.allSettled so one failing server doesn't block others.
     */
    connectAll(): Promise<void>;
    /**
     * Start the gateway with stdio transport.
     * This is the main entry point when used from opencode.
     *
     * IMPORTANT: The __MCP_GATEWAY_STDIO_READY__ marker is printed to stdout
     * after the stdio transport is connected. opencode waits for this before
     * sending any requests.
     *
     * Upstream connections happen in the background AFTER stdio is ready,
     * so the gateway starts fast even if upstream servers are slow.
     */
    startWithStdio(): Promise<void>;
    /**
     * Handle config file changes — reconnect modified servers, add new ones, remove deleted ones.
     * Uses a 1-second debounce to avoid thrashing on rapid saves.
     */
    private handleConfigChange;
    /** Graceful shutdown — stop watching, drain jobs, disconnect all */
    shutdown(): Promise<void>;
}
