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
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { normalizeLazyConfig } from "./lazy-config.js";
import { errorMessage } from "./util.js";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Don't disconnect within this window of a request — avoids races with in-flight invokes. */
const IDLE_SAFETY_MS = 5000;
function createRecord() {
    return { state: "disconnected", lastUsedAt: 0, connectedAt: 0, requestCount: 0 };
}
/**
 * Replace {env:VAR_NAME} patterns with actual environment variable values.
 * If the env var is not set, the placeholder becomes empty string.
 */
function parseEnvironmentVariables(env) {
    if (!env)
        return undefined;
    const parsed = {};
    for (const [key, value] of Object.entries(env)) {
        parsed[key] = value.replace(/\{env:(\w+)\}/g, (_, envVarName) => process.env[envVarName] ?? "");
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
    // ──────────────────────────────────────────────
    // Connecting
    // ──────────────────────────────────────────────
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
     * config.command is split into [executable, ...args]. Config environment
     * is merged over the parent env so servers inherit PATH etc.
     */
    async connectLocal(serverKey, config) {
        const [cmd, ...args] = config.command ?? [];
        if (!cmd)
            throw new Error(`[${serverKey}] Missing command in config`);
        const mergedEnv = {};
        for (const [key, value] of Object.entries(process.env)) {
            if (value !== undefined)
                mergedEnv[key] = value;
        }
        Object.assign(mergedEnv, parseEnvironmentVariables(config.environment));
        const transport = new StdioClientTransport({ command: cmd, args, env: mergedEnv });
        await this.connectTransport(serverKey, transport);
    }
    /**
     * Connect to a remote (HTTP/WebSocket) upstream MCP server.
     * Auto-detects transport: ws:// → websocket, http:// → streamable_http.
     * Remote transport imports are dynamic to avoid loading unused transports.
     */
    async connectRemote(serverKey, config) {
        const url = new URL(config.url ?? "");
        const transportType = config.transport ?? (url.protocol === "ws:" || url.protocol === "wss:" ? "websocket" : "streamable_http");
        const transport = transportType === "websocket"
            ? new (await import("@modelcontextprotocol/sdk/client/websocket.js")).WebSocketClientTransport(url)
            : new (await import("@modelcontextprotocol/sdk/client/streamableHttp.js")).StreamableHTTPClientTransport(url);
        await this.connectTransport(serverKey, transport);
    }
    /**
     * Shared connection logic for both transports.
     * Creates a Client, connects it, records lifecycle info, then refreshes
     * the tool catalog.
     */
    async connectTransport(serverKey, transport) {
        // Ignore noisy upstream errors — MCP servers love to log JSON parse errors
        transport.onerror = (error) => {
            const message = error.message ?? "";
            if (message.includes("JSON Parse error") || message.includes("EPIPE"))
                return;
            console.error(`  [${serverKey}] Error: ${message}`);
        };
        const client = new Client({ name: `harshal-proxy-${serverKey}`, version: "1.0.0" }, {});
        transport.onclose = () => {
            console.error(`  [${serverKey}] Connection closed`);
            // Self-heal: drop the dead client so the next invoke reconnects.
            // Identity check guards against a stale close event racing a reconnect.
            if (this.upstreams.get(serverKey) === client) {
                this.upstreams.delete(serverKey);
                const state = this.states.get(serverKey);
                if (state)
                    state.state = "disconnected";
            }
        };
        await client.connect(transport);
        this.upstreams.set(serverKey, client);
        const state = this.states.get(serverKey) ?? createRecord();
        state.state = "connected";
        state.connectedAt = Date.now();
        state.requestCount = 0;
        this.states.set(serverKey, state);
        // Stdio servers expose the child PID directly — no tree scanning needed
        if (transport instanceof StdioClientTransport && transport.pid !== null) {
            state.pid = transport.pid;
            this.resourceMonitor?.setPid(serverKey, transport.pid);
        }
        await this.refreshCatalog(serverKey, client);
        console.error(`  [${serverKey}] Connected — ${this.searchEngine.getToolCount(serverKey)} tools`);
    }
    /**
     * Fetch listTools() from upstream, register each tool in the search
     * engine, and save a snapshot for lazy-loading catalog persistence.
     */
    async refreshCatalog(serverKey, client) {
        const response = await client.listTools();
        const tools = response.tools.map((tool) => ({
            id: `${serverKey}::${tool.name}`,
            server: serverKey,
            name: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
        }));
        for (const tool of tools)
            this.searchEngine.addTool(tool);
        this.snapshotManager?.saveSnapshot(serverKey, tools);
    }
    /**
     * Connect with retry — exponential backoff.
     * 5 attempts: 1s, 2s, 4s, 8s, 16s before giving up.
     */
    async connectWithRetry(serverKey, config, maxRetries = 5, baseDelayMs = 1000) {
        for (let attempt = 1;; attempt++) {
            try {
                return await this.connect(serverKey, config);
            }
            catch (err) {
                if (attempt >= maxRetries) {
                    console.error(`  [${serverKey}] All ${maxRetries} connection attempts failed`);
                    throw err;
                }
                const delay = baseDelayMs * 2 ** (attempt - 1);
                console.error(`  [${serverKey}] Connection failed (${attempt}/${maxRetries}), retry in ${delay}ms: ${errorMessage(err)}`);
                await sleep(delay);
            }
        }
    }
    /**
     * Ensure a server is connected, connecting on demand if necessary.
     * Deduplicates concurrent attempts and honors the server's configured
     * connectionTimeoutMs (the retry loop keeps running if it times out and
     * may still succeed — a later call then finds the client connected).
     */
    async ensureConnected(serverKey) {
        const existing = this.upstreams.get(serverKey);
        if (existing)
            return existing;
        const pending = this.connectingPromises.get(serverKey);
        if (pending)
            return pending;
        if (!this.configProvider) {
            throw new Error(`[${serverKey}] No config provider set`);
        }
        const config = this.configProvider()[serverKey];
        if (!config) {
            throw new Error(`[${serverKey}] Not found in config`);
        }
        const { connectionTimeoutMs } = normalizeLazyConfig(config.lazy);
        const attempt = this.connectWithRetry(serverKey, config, 3, 1000).then(() => {
            const client = this.upstreams.get(serverKey);
            if (!client)
                throw new Error(`[${serverKey}] Connect succeeded but client missing`);
            return client;
        });
        const promise = withTimeout(attempt, connectionTimeoutMs, `[${serverKey}] Connect timed out after ${connectionTimeoutMs}ms`)
            .catch((err) => {
            const state = this.states.get(serverKey) ?? createRecord();
            state.state = "failed";
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
    // ──────────────────────────────────────────────
    // Disconnecting / lifecycle
    // ──────────────────────────────────────────────
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
        const state = this.states.get(serverKey);
        if (state) {
            state.state = "disconnected";
            if (state.pid !== undefined) {
                this.resourceMonitor?.clearPid(serverKey);
                state.pid = undefined;
            }
        }
        console.error(`  [${serverKey}] Disconnected`);
    }
    /** Fully remove a server: disconnect + drop tools + delete snapshot */
    async removeServer(serverKey) {
        await this.disconnect(serverKey);
        this.searchEngine.removeServerTools(serverKey);
        this.states.delete(serverKey);
        this.snapshotManager?.removeSnapshot(serverKey);
        this.resourceMonitor?.clearPid(serverKey);
    }
    /** Disconnect all upstream servers */
    async disconnectAll() {
        for (const key of Array.from(this.upstreams.keys())) {
            await this.disconnect(key);
        }
    }
    /** List all currently connected server keys */
    getConnectedServers() {
        return Array.from(this.upstreams.keys());
    }
    getConnectionState(serverKey) {
        return this.states.get(serverKey)?.state ?? "disconnected";
    }
    // ──────────────────────────────────────────────
    // Idle monitor (lazy servers)
    // ──────────────────────────────────────────────
    /** Start the periodic lazy-server check (idempotent) */
    startIdleMonitor(checkIntervalMs) {
        if (this.idleMonitorId)
            return;
        this.idleMonitorId = setInterval(() => this.checkConnectedServers(), checkIntervalMs);
    }
    /** Stop the idle monitor */
    stopIdleMonitor() {
        if (this.idleMonitorId) {
            clearInterval(this.idleMonitorId);
            this.idleMonitorId = undefined;
        }
    }
    /**
     * For each connected lazy server, disconnect when it has been idle past
     * idleTimeoutMs, exceeded maxRamMb, or exceeded maxUptimeMs.
     */
    checkConnectedServers() {
        const configs = this.configProvider?.();
        if (!configs)
            return;
        const now = Date.now();
        for (const [serverKey, state] of this.states) {
            if (state.state !== "connected")
                continue;
            const config = configs[serverKey];
            const lazy = normalizeLazyConfig(config?.lazy);
            if (config?.enabled === false || !lazy.enabled)
                continue;
            // Fresh use — never disconnect within the safety window
            if (state.lastUsedAt > 0 && now - state.lastUsedAt < IDLE_SAFETY_MS)
                continue;
            const reason = exceededLimit(serverKey, state, lazy, now, this.resourceMonitor);
            if (reason === null)
                continue;
            console.error(`  [lazy] ${serverKey} ${reason} — disconnecting`);
            void this.disconnect(serverKey).catch((err) => {
                console.error(`  [lazy] Failed to disconnect ${serverKey}: ${errorMessage(err)}`);
            });
        }
    }
}
/** Which lazy limit (if any) this server is over. */
function exceededLimit(serverKey, state, lazy, now, resourceMonitor) {
    if (state.lastUsedAt > 0 && now - state.lastUsedAt > lazy.idleTimeoutMs) {
        return `idle for ${Math.round((now - state.lastUsedAt) / 1000)}s`;
    }
    if (lazy.maxUptimeMs > 0 && state.connectedAt > 0 && now - state.connectedAt > lazy.maxUptimeMs) {
        return `uptime ${Math.round((now - state.connectedAt) / 60_000)}min over limit`;
    }
    if (lazy.maxRamMb > 0) {
        const ramMb = resourceMonitor?.getRamMb(serverKey);
        if (ramMb != null && ramMb > lazy.maxRamMb) {
            return `RAM ${ramMb.toFixed(1)}MB > ${lazy.maxRamMb}MB limit`;
        }
    }
    return null;
}
/** Reject after `ms` unless the wrapped promise settles first (timer is cleared either way). */
function withTimeout(promise, ms, message) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), ms);
        promise.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}
//# sourceMappingURL=connections.js.map