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
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServerRecord } from "./connection-state.js";
/**
 * Replace {env:VAR_NAME} patterns with actual environment variable values.
 * If the env var is not set, the placeholder becomes empty string.
 */
export function parseEnvironmentVariables(env) {
    if (!env)
        return undefined;
    const parsed = {};
    const processEnv = process.env;
    for (const [key, value] of Object.entries(env)) {
        parsed[key] = value.replace(/\{env:(\w+)\}/g, (_, envVarName) => {
            return processEnv[envVarName] || "";
        });
    }
    return parsed;
}
export class ConnectionManager {
    searchEngine;
    /** Active upstream client connections keyed by server name */
    upstreams = new Map();
    /** Connection state tracking per server */
    states = new Map();
    /** Deduplication for concurrent on-demand connects */
    connectingPromises = new Map();
    /** Lazy dependencies — set by gateway after construction */
    configProvider;
    snapshotManager;
    resourceMonitor;
    /** Idle monitor timer */
    idleMonitorId;
    constructor(searchEngine) {
        this.searchEngine = searchEngine;
    }
    setConfigProvider(provider) {
        this.configProvider = provider;
    }
    setSnapshotManager(manager) {
        this.snapshotManager = manager;
    }
    setResourceMonitor(monitor) {
        this.resourceMonitor = monitor;
    }
    /** Connect to a single upstream server (dispatches to local or remote) */
    async connect(serverKey, config) {
        if (config.type === "local") {
            await this.connectLocal(serverKey, config);
        }
        else {
            await this.connectRemote(serverKey, config);
        }
    }
    /**
     * Connect to a local (stdio) upstream MCP server.
     *
     * The config.command array is split into [executable, ...args].
     * Environment variables from config.environment are merged with
     * the parent process env after {env:VAR} substitution.
     */
    async connectLocal(serverKey, config) {
        const [cmd, ...args] = config.command || [];
        if (!cmd)
            throw new Error(`[${serverKey}] Missing command in config`);
        // Parse env vars with {env:VAR_NAME} substitution
        const configEnv = parseEnvironmentVariables(config.environment);
        // Merge with parent process env so upstream servers inherit PATH etc.
        const mergedEnv = {};
        for (const [k, v] of Object.entries(process.env)) {
            if (v !== undefined)
                mergedEnv[k] = v;
        }
        if (configEnv) {
            Object.assign(mergedEnv, configEnv);
        }
        const transport = new StdioClientTransport({
            command: cmd,
            args,
            env: mergedEnv,
        });
        await this.connectTransport(serverKey, transport);
    }
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
    async connectRemote(serverKey, config) {
        const url = new URL(config.url || "");
        const transportType = config.transport ||
            (url.protocol === "ws:" || url.protocol === "wss:" ? "websocket" : "streamable_http");
        let transport;
        if (transportType === "websocket") {
            // Dynamic import — only loaded if needed
            const { WebSocketClientTransport } = await import("@modelcontextprotocol/sdk/client/websocket.js");
            transport = new WebSocketClientTransport(url);
        }
        else {
            const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
            transport = new StreamableHTTPClientTransport(url);
        }
        await this.connectTransport(serverKey, transport);
    }
    /**
     * Shared connection logic for both local and remote transports.
     * Creates a Client, connects it, then refreshes the tool catalog.
     */
    async connectTransport(serverKey, transport) {
        // Suppress noisy errors from upstream servers (they love to log JSON parse errors)
        transport.onclose = () => console.error(`  [${serverKey}] Connection closed`);
        transport.onerror = (error) => {
            if (error.message?.includes("JSON Parse error"))
                return;
            if (error.message?.includes("EPIPE"))
                return;
            console.error(`  [${serverKey}] Error: ${error.message}`);
        };
        const client = new Client({ name: `harshal-proxy-${serverKey}`, version: "1.0.0" }, {});
        await client.connect(transport);
        this.upstreams.set(serverKey, client);
        // Set state to connected
        const state = this.states.get(serverKey) || createServerRecord();
        state.state = 'connected';
        state.connectedAt = Date.now();
        state.requestCount = 0;
        this.states.set(serverKey, state);
        // Try to discover PID for stdio processes
        if (this.resourceMonitor) {
            const pid = this.resourceMonitor.findPidByCommand('node', process.pid);
            if (pid) {
                state.pid = pid;
                this.resourceMonitor.setPid(serverKey, pid);
            }
        }
        // Fetch and register all tools from this upstream
        await this.refreshCatalog(serverKey, client);
        console.error(`  [${serverKey}] Connected — ${this.countTools(serverKey)} tools`);
    }
    /**
     * Fetch listTools() from upstream and register each tool in the search engine.
     * Also saves a snapshot for lazy-loading catalog persistence.
     */
    async refreshCatalog(serverKey, client) {
        const response = await client.listTools();
        const tools = [];
        for (const tool of response.tools) {
            const entry = {
                id: `${serverKey}::${tool.name}`,
                server: serverKey,
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
            };
            tools.push(entry);
            this.searchEngine.addTool(entry);
        }
        // Save snapshot for lazy loading
        if (this.snapshotManager) {
            this.snapshotManager.saveSnapshot(serverKey, tools);
        }
    }
    /** Count how many tools a specific server has registered */
    countTools(serverKey) {
        return this.searchEngine.getTools().filter((t) => t.server === serverKey).length;
    }
    /**
     * Connect with retry — exponential backoff.
     * 5 attempts: 1s, 2s, 4s, 8s, 16s before giving up.
     */
    async connectWithRetry(serverKey, config, maxRetries = 5, baseDelay = 1000) {
        let lastError;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                return await this.connect(serverKey, config);
            }
            catch (error) {
                lastError = error;
                if (attempt < maxRetries - 1) {
                    const delay = baseDelay * Math.pow(2, attempt);
                    console.error(`  [${serverKey}] Connection failed (${attempt + 1}/${maxRetries}), retry in ${delay}ms: ${lastError.message}`);
                    await new Promise((r) => setTimeout(r, delay));
                }
            }
        }
        console.error(`  [${serverKey}] All ${maxRetries} connection attempts failed`);
        throw lastError;
    }
    /** Get a connected Client by server key (for invoking tools). */
    getClient(serverKey) {
        return this.upstreams.get(serverKey);
    }
    /** Disconnect a single server. Does NOT remove tools from the catalog. */
    async disconnect(serverKey) {
        const client = this.upstreams.get(serverKey);
        if (client) {
            try {
                await client.close();
            }
            catch {
                // Ignore close errors
            }
            this.upstreams.delete(serverKey);
        }
        // Update state
        const state = this.states.get(serverKey);
        if (state) {
            state.state = 'disconnected';
            if (state.pid && this.resourceMonitor) {
                this.resourceMonitor.clearPid(serverKey);
                state.pid = undefined;
            }
        }
        console.error(`  [${serverKey}] Disconnected`);
    }
    /** Fully remove a server: disconnect + remove tools from catalog + delete snapshot */
    async removeServer(serverKey) {
        await this.disconnect(serverKey);
        this.searchEngine.removeServerTools?.(serverKey);
        this.states.delete(serverKey);
        if (this.snapshotManager) {
            this.snapshotManager.removeSnapshot(serverKey);
        }
        if (this.resourceMonitor) {
            this.resourceMonitor.unregister(serverKey);
        }
    }
    /**
     * Ensure a server is connected, connecting on demand if necessary.
     * Deduplicates concurrent connection attempts for the same server.
     */
    async ensureConnected(serverKey) {
        const existing = this.upstreams.get(serverKey);
        if (existing)
            return existing;
        const pending = this.connectingPromises.get(serverKey);
        if (pending) {
            return pending;
        }
        if (!this.configProvider) {
            throw new Error(`[${serverKey}] No config provider set`);
        }
        const config = this.configProvider()[serverKey];
        if (!config) {
            throw new Error(`[${serverKey}] Not found in config`);
        }
        const promise = this.connectWithRetry(serverKey, config, 3, 1000)
            .then(() => {
            const client = this.upstreams.get(serverKey);
            if (!client)
                throw new Error(`[${serverKey}] Connect succeeded but client missing`);
            return client;
        })
            .catch((err) => {
            const state = this.states.get(serverKey) || createServerRecord();
            state.state = 'failed';
            this.states.set(serverKey, state);
            throw err;
        })
            .finally(() => {
            this.connectingPromises.delete(serverKey);
        });
        this.connectingPromises.set(serverKey, promise);
        return promise;
    }
    /** Mark a server as recently used (called after successful invoke) */
    markServerUsed(serverKey) {
        const state = this.states.get(serverKey);
        if (state) {
            state.lastUsedAt = Date.now();
            state.requestCount++;
        }
    }
    /**
     * Start periodic idle check. For each connected lazy server,
     * disconnect if idle timeout exceeded or RAM limit exceeded.
     */
    startIdleMonitor(checkIntervalMs) {
        if (this.idleMonitorId)
            return;
        this.idleMonitorId = setInterval(() => {
            const now = Date.now();
            for (const [serverKey, state] of this.states) {
                if (state.state !== 'connected')
                    continue;
                if (!this.configProvider)
                    continue;
                const config = this.configProvider()[serverKey];
                if (!config?.lazy?.enabled)
                    continue;
                const idleTimeout = config.lazy.idleTimeoutMs || 300000;
                // Don't disconnect if used in the last 5 seconds (safety buffer)
                if (now - state.lastUsedAt < 5000)
                    continue;
                if (state.lastUsedAt > 0 && now - state.lastUsedAt > idleTimeout) {
                    console.error(`  [lazy] ${serverKey} idle for ${Math.round((now - state.lastUsedAt) / 1000)}s — disconnecting`);
                    this.disconnect(serverKey).catch((err) => {
                        console.error(`  [lazy] Failed to disconnect ${serverKey}: ${err.message}`);
                    });
                }
            }
        }, checkIntervalMs);
    }
    /** Stop the idle monitor */
    stopIdleMonitor() {
        if (this.idleMonitorId) {
            clearInterval(this.idleMonitorId);
            this.idleMonitorId = undefined;
        }
    }
    getConnectionState(serverKey) {
        return this.states.get(serverKey)?.state || 'disconnected';
    }
    getServerStats(serverKey) {
        const state = this.states.get(serverKey);
        if (!state)
            return null;
        return {
            name: serverKey,
            state: state.state,
            toolCount: this.countTools(serverKey),
            lastUsedAt: state.lastUsedAt || null,
            requestCount: state.requestCount,
            ramMb: null, // populated by resource monitor if available
            uptimeMs: state.connectedAt > 0 ? Date.now() - state.connectedAt : null,
        };
    }
    /** Disconnect all upstream servers */
    async disconnectAll() {
        const keys = Array.from(this.upstreams.keys());
        for (const key of keys) {
            await this.disconnect(key);
        }
    }
    /** List all currently connected server keys */
    getConnectedServers() {
        return Array.from(this.upstreams.keys());
    }
}
//# sourceMappingURL=connections.js.map