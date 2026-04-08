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
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Config } from "./config.js";
import { SearchEngine } from "./search.js";
import { JobManager } from "./jobs.js";
import { ConnectionManager } from "./connections.js";
import { ResponseStore, ResponseShield } from "./response-store.js";
import { createServer } from "./handlers.js";
export class MCPGateway {
    config;
    searchEngine;
    jobManager;
    connections;
    responseStore;
    responseShield;
    server;
    constructor(configPath) {
        // Initialize all subsystems
        this.config = new Config(configPath);
        this.searchEngine = new SearchEngine();
        this.jobManager = new JobManager();
        this.connections = new ConnectionManager(this.searchEngine);
        this.responseStore = new ResponseStore();
        this.responseShield = new ResponseShield(this.responseStore);
        // Create the MCP server with all 6 gateway tools
        this.server = createServer(this.searchEngine, this.connections, this.jobManager, this.responseStore, this.responseShield);
        // Wire up the job manager's execute function
        // This is called when an async job is dequeued
        this.jobManager.setExecuteJob(async (job) => {
            const separatorIndex = job.toolId.toString().indexOf("::");
            if (separatorIndex === -1) {
                throw new Error(`Invalid tool ID: ${job.toolId}`);
            }
            const serverKey = job.toolId.toString().slice(0, separatorIndex);
            const toolName = job.toolId.toString().slice(separatorIndex + 2);
            const client = this.connections.getClient(serverKey);
            if (!client)
                throw new Error(`Server not connected: ${serverKey}`);
            const result = await client.callTool({
                name: toolName,
                arguments: job.args,
            });
            // Shield the async result too
            const { shielded, ref } = this.responseShield.shield(job.toolId.toString(), result);
            job.result = ref ? { ...shielded, _ref: ref } : shielded;
        });
    }
    /**
     * Connect to all enabled upstream servers.
     * Uses Promise.allSettled so one failing server doesn't block others.
     */
    async connectAll() {
        const allConfig = this.config.getAll();
        const connectionPromises = Object.entries(allConfig)
            .filter(([_, config]) => config.enabled !== false)
            .map(([serverKey, config]) => this.connections.connectWithRetry(serverKey, config).catch((err) => {
            console.error(`  [${serverKey}] FAILED: ${err.message}`);
        }));
        await Promise.allSettled(connectionPromises);
        // Rebuild search index after all connections
        this.searchEngine.warmup();
        const toolCount = this.searchEngine.getTools().length;
        const serverCount = this.connections.getConnectedServers().length;
        console.error(`  [gateway] Ready: ${toolCount} tools from ${serverCount} servers`);
    }
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
    async startWithStdio() {
        console.error("harshal-mcp-proxy starting (stdio)...");
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        // Signal to opencode that we're ready to receive requests
        // This MUST go to stdout (not stderr) — opencode parses it
        console.log("__MCP_GATEWAY_STDIO_READY__");
        // Connect to upstream servers in the background
        this.connectAll().catch((err) => {
            console.error(`  [gateway] Background connection error: ${err.message}`);
        });
        // Watch config file for hot-reload
        this.config.watch((oldCfg, newCfg) => this.handleConfigChange(oldCfg, newCfg));
    }
    /**
     * Handle config file changes — reconnect modified servers, add new ones, remove deleted ones.
     * Uses a 1-second debounce to avoid thrashing on rapid saves.
     */
    handleConfigChange(oldConfig, newConfig) {
        console.error("  [gateway] Config change detected, reloading...");
        const oldKeys = new Set(Object.keys(oldConfig));
        const newKeys = new Set(Object.keys(newConfig));
        const toRemove = [...oldKeys].filter((k) => !newKeys.has(k));
        const toAdd = [...newKeys].filter((k) => !oldKeys.has(k));
        const toCheck = [...newKeys].filter((k) => oldKeys.has(k));
        // Debounce the actual reload
        setTimeout(async () => {
            // Remove deleted servers
            for (const key of toRemove) {
                await this.connections.disconnect(key);
                console.error(`    ${key} — disconnected (removed from config)`);
            }
            // Check for changes in existing servers
            for (const key of toCheck) {
                const oldC = oldConfig[key];
                const newC = newConfig[key];
                // Disabled → still disabled: skip
                if (oldC?.enabled === false && newC?.enabled === false)
                    continue;
                // Was enabled → now disabled: disconnect
                if (oldC?.enabled !== false && newC?.enabled === false) {
                    await this.connections.disconnect(key);
                    console.error(`    ${key} — disabled`);
                    continue;
                }
                // Was disabled → now enabled: connect
                if (oldC?.enabled === false && newC?.enabled !== false) {
                    try {
                        await this.connections.connectWithRetry(key, newC);
                        console.error(`    ${key} — enabled`);
                    }
                    catch (e) {
                        console.error(`    ${key} — failed: ${e.message}`);
                    }
                    continue;
                }
                // Both enabled — check for config changes
                if (JSON.stringify(oldC) !== JSON.stringify(newC)) {
                    await this.connections.disconnect(key);
                    try {
                        await this.connections.connectWithRetry(key, newC);
                        console.error(`    ${key} — reconnected (config changed)`);
                    }
                    catch (e) {
                        console.error(`    ${key} — reconnect failed: ${e.message}`);
                    }
                }
            }
            // Add new servers
            for (const key of toAdd) {
                const config = newConfig[key];
                if (config?.enabled !== false) {
                    try {
                        await this.connections.connectWithRetry(key, config);
                        console.error(`    ${key} — connected (new)`);
                    }
                    catch (e) {
                        console.error(`    ${key} — failed: ${e.message}`);
                    }
                }
            }
            this.searchEngine.warmup();
            console.error(`  [gateway] Reloaded: ${this.searchEngine.getTools().length} tools from ${this.connections.getConnectedServers().length} servers`);
        }, 1000);
    }
    /** Graceful shutdown — stop watching, drain jobs, disconnect all */
    async shutdown() {
        console.error("  [gateway] Shutting down...");
        this.config.stopWatching();
        await this.jobManager.shutdown();
        await this.connections.disconnectAll();
        await this.server.close();
        console.error("  [gateway] Shutdown complete");
    }
}
//# sourceMappingURL=gateway.js.map