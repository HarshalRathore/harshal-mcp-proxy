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
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Config } from "./config.js";
import { SearchEngine } from "./search.js";
import { JobManager } from "./jobs.js";
import { ConnectionManager } from "./connections.js";
import { ResponseStore, ResponseShield } from "./response-store.js";
import { createServer } from "./handlers.js";
import { ProjectRegistry } from "./projectRegistry.js";
import { normalizeLazyConfig } from "./lazy-config.js";
import { CatalogSnapshotManager } from "./catalog-snapshot.js";
import { ResourceMonitor } from "./resource-monitor.js";
import { GatewayTools as Tools } from "./tools.js";
import { errorMessage, isPlainObject } from "./util.js";
/** Debounce window for config reloads (rapid saves collapse into one apply). */
const RELOAD_DEBOUNCE_MS = 1000;
/** Interval between lazy-server limit checks. */
const IDLE_CHECK_INTERVAL_MS = 30_000;
export class MCPGateway {
    config;
    searchEngine = new SearchEngine();
    jobManager = new JobManager();
    connections;
    responseStore = new ResponseStore();
    responseShield;
    projectRegistry;
    snapshotManager = new CatalogSnapshotManager();
    resourceMonitor = new ResourceMonitor();
    services;
    tools;
    server;
    lastReloadTimestamp = Date.now();
    pendingReload = false;
    reloadTimer;
    constructor(configPath) {
        this.config = new Config(configPath);
        this.connections = new ConnectionManager(this.searchEngine);
        this.connections.setConfigProvider(() => this.config.getServers());
        this.connections.setSnapshotManager(this.snapshotManager);
        this.connections.setResourceMonitor(this.resourceMonitor);
        this.responseShield = new ResponseShield(this.responseStore);
        this.projectRegistry = new ProjectRegistry(this.resolveScanRoots());
        this.projectRegistry.discover(this.config.getCodegraph().defaultProject);
        this.services = {
            searchEngine: this.searchEngine,
            connections: this.connections,
            jobManager: this.jobManager,
            responseStore: this.responseStore,
            responseShield: this.responseShield,
            projectRegistry: this.projectRegistry,
            statusHolder: this.buildStatusHolder(),
        };
        this.tools = new Tools(this.services);
        this.server = createServer(this.services);
        this.jobManager.setExecuteJob((job) => this.executeJob(job));
    }
    /** Scan roots for codegraph discovery: SCAN_ROOTS env, then cwd, plus configured projects. */
    resolveScanRoots() {
        const envRoots = (process.env.SCAN_ROOTS ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        const configured = this.config.getCodegraph().projects?.map((p) => p.path) ?? [];
        return [...(envRoots.length > 0 ? envRoots : [process.cwd()]), ...configured];
    }
    buildStatusHolder() {
        return {
            getConnectedServers: () => this.connections.getConnectedServers(),
            getToolCount: (server) => this.searchEngine.getToolCount(server),
            getTotalTools: () => this.searchEngine.getTools().length,
            getConfigPath: () => this.config.getPath(),
            getLastReloadTimestamp: () => this.lastReloadTimestamp,
            isPendingReload: () => this.pendingReload,
            getProjects: () => this.projectRegistry.projectsList,
            getDefaultProject: () => this.projectRegistry.defaultProjectName,
        };
    }
    /** Execute an async job: call the tool, shield the result, keep the ref. */
    async executeJob(job) {
        const { shielded, ref } = await this.tools.callTool({ id: job.toolId, args: job.args });
        job.result = ref !== null && isPlainObject(shielded) ? { ...shielded, _ref: ref } : shielded;
    }
    /**
     * Connect to all enabled upstream servers.
     * For lazy servers: load catalog snapshots without spawning processes.
     * For eager servers (lazy.enabled=false or prewarm=true): connect normally.
     *
     * @param forceConnect - If true, connect to ALL servers regardless of lazy
     *   setting (used by --discover to build initial snapshots).
     */
    async connectAll(forceConnect = false) {
        const servers = this.config.getServers();
        const eagerKeys = [];
        const lazyKeys = [];
        for (const [serverKey, config] of Object.entries(servers)) {
            if (config.enabled === false)
                continue;
            const lazy = normalizeLazyConfig(config.lazy);
            if (!forceConnect && lazy.enabled && !lazy.prewarm) {
                lazyKeys.push(serverKey);
            }
            else {
                eagerKeys.push(serverKey);
            }
        }
        // Eager-connect non-lazy servers
        await Promise.allSettled(eagerKeys.map((serverKey) => this.connections.connectWithRetry(serverKey, servers[serverKey]).catch((err) => {
            console.error(`  [${serverKey}] FAILED: ${errorMessage(err)}`);
        })));
        // For lazy servers: load snapshots without connecting
        for (const serverKey of lazyKeys) {
            const count = this.loadSnapshotTools(serverKey);
            console.error(count === undefined
                ? `  [${serverKey}] Lazy — no snapshot, will discover on first use`
                : `  [${serverKey}] Lazy — loaded ${count} tools from snapshot`);
        }
        // Rebuild search index
        this.searchEngine.warmup();
        const toolCount = this.searchEngine.getTools().length;
        const connectedCount = this.connections.getConnectedServers().length;
        console.error(`  [gateway] Ready: ${toolCount} tools (${connectedCount} connected + ${lazyKeys.length} lazy) from ${Object.keys(servers).length} servers`);
        // Start the lazy-server monitor (idle/RAM/uptime limits)
        if (lazyKeys.length > 0) {
            this.connections.startIdleMonitor(IDLE_CHECK_INTERVAL_MS);
        }
    }
    /**
     * Start the gateway with stdio transport. This is the main entry point
     * when used from opencode.
     *
     * IMPORTANT: The __MCP_GATEWAY_STDIO_READY__ marker is printed to stdout
     * after the stdio transport is connected. opencode waits for this before
     * sending any requests. Upstream connections happen in the background
     * AFTER stdio is ready, so the gateway starts fast even with slow servers.
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
            console.error(`  [gateway] Background connection error: ${errorMessage(err)}`);
        });
        // Watch for lazy-server limits
        this.connections.startIdleMonitor(IDLE_CHECK_INTERVAL_MS);
        // Watch config file for hot-reload
        this.config.watch((oldCfg, newCfg) => this.handleConfigChange(oldCfg, newCfg));
    }
    /** Load a server's snapshot into the search index. Returns tool count, or undefined when none. */
    loadSnapshotTools(serverKey) {
        const snapshot = this.snapshotManager.loadSnapshot(serverKey);
        if (!snapshot)
            return undefined;
        for (const tool of snapshot)
            this.searchEngine.addTool(tool);
        return snapshot.length;
    }
    // ──────────────────────────────────────────────
    // Config hot reload
    // ──────────────────────────────────────────────
    /**
     * Handle config file changes — reconnect modified servers, add new ones,
     * remove deleted ones. Rapid saves collapse into one reload (debounced).
     */
    handleConfigChange(oldConfig, newConfig) {
        this.pendingReload = true;
        console.error("  [gateway] Config change detected, reloading...");
        clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => void this.applyConfigChange(oldConfig, newConfig), RELOAD_DEBOUNCE_MS);
    }
    async applyConfigChange(oldConfig, newConfig) {
        const oldKeys = new Set(Object.keys(oldConfig));
        try {
            for (const key of oldKeys) {
                if (!(key in newConfig))
                    await this.removeServer(key, "removed from config");
            }
            for (const [key, config] of Object.entries(newConfig)) {
                if (key in oldConfig)
                    await this.syncServer(key, oldConfig[key], config);
                else
                    await this.connectOrSnapshot(key, config, "connected (new)");
            }
        }
        finally {
            this.searchEngine.warmup();
            this.pendingReload = false;
            this.lastReloadTimestamp = Date.now();
            console.error(`  [gateway] Reloaded: ${this.searchEngine.getTools().length} tools from ${this.connections.getConnectedServers().length} servers`);
        }
    }
    /** Reconcile one server that exists in both old and new config. */
    async syncServer(serverKey, oldConfig, newConfig) {
        const wasEnabled = oldConfig.enabled !== false;
        const nowEnabled = newConfig.enabled !== false;
        if (!wasEnabled && !nowEnabled)
            return;
        if (wasEnabled && !nowEnabled)
            return this.removeServer(serverKey, "disabled");
        if (!wasEnabled && nowEnabled)
            return this.connectOrSnapshot(serverKey, newConfig, "enabled");
        if (JSON.stringify(oldConfig) === JSON.stringify(newConfig))
            return;
        // Config changed while enabled — reconnect. Lazy servers refresh their
        // snapshot and then disconnect again so the catalog stays current.
        await this.connections.disconnect(serverKey);
        const lazy = normalizeLazyConfig(newConfig.lazy);
        try {
            await this.connections.connectWithRetry(serverKey, newConfig);
            if (lazy.enabled && !lazy.prewarm) {
                await this.connections.disconnect(serverKey);
                console.error(`    ${serverKey} — snapshot refreshed (lazy)`);
            }
            else {
                console.error(`    ${serverKey} — reconnected (config changed)`);
            }
        }
        catch (err) {
            console.error(`    ${serverKey} — reconnect failed: ${errorMessage(err)}`);
        }
    }
    /** Connect a newly enabled server, or load its snapshot when it is lazy. */
    async connectOrSnapshot(serverKey, config, label) {
        if (config.enabled === false)
            return;
        const lazy = normalizeLazyConfig(config.lazy);
        if (lazy.enabled && !lazy.prewarm) {
            const count = this.loadSnapshotTools(serverKey);
            console.error(`    ${serverKey} — ${label} (lazy${count === undefined ? ", no snapshot yet" : `, loaded ${count} tools from snapshot`})`);
            return;
        }
        try {
            await this.connections.connectWithRetry(serverKey, config);
            console.error(`    ${serverKey} — ${label}`);
        }
        catch (err) {
            console.error(`    ${serverKey} — failed: ${errorMessage(err)}`);
        }
    }
    async removeServer(serverKey, reason) {
        await this.connections.removeServer(serverKey);
        console.error(`    ${serverKey} — ${reason}`);
    }
    // ──────────────────────────────────────────────
    // Shared services / shutdown
    // ──────────────────────────────────────────────
    /**
     * Share internal services for HTTP daemon mode.
     * The HttpMcpServer reuses the same SearchEngine, ConnectionManager, etc.
     * so that all clients share one set of upstream MCP connections.
     */
    getSharedServices() {
        return this.services;
    }
    /** Graceful shutdown — stop watching, drain jobs, disconnect all */
    async shutdown() {
        console.error("  [gateway] Shutting down...");
        clearTimeout(this.reloadTimer);
        this.config.stopWatching();
        this.connections.stopIdleMonitor();
        await this.jobManager.shutdown();
        await this.connections.disconnectAll();
        await this.server.close();
        console.error("  [gateway] Shutdown complete");
    }
}
//# sourceMappingURL=gateway.js.map