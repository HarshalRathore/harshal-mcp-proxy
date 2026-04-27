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
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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
    constructor(searchEngine) {
        this.searchEngine = searchEngine;
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
        // Fetch and register all tools from this upstream
        await this.refreshCatalog(serverKey, client);
        console.error(`  [${serverKey}] Connected — ${this.countTools(serverKey)} tools`);
    }
    /**
     * Fetch listTools() from upstream and register each tool in the search engine.
     * This is where we capture the full inputSchema for later use by gateway.describe.
     */
    async refreshCatalog(serverKey, client) {
        const response = await client.listTools();
        for (const tool of response.tools) {
            const entry = {
                id: `${serverKey}::${tool.name}`,
                server: serverKey,
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
            };
            this.searchEngine.addTool(entry);
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
    /** Disconnect a single server and remove its tools from the catalog */
    async disconnect(serverKey) {
        const client = this.upstreams.get(serverKey);
        if (client) {
            // Remove all tools for this server from the search index
            const tools = this.searchEngine.getTools().filter((t) => t.server === serverKey);
            for (const tool of tools) {
                this.searchEngine.removeTool(tool.id);
            }
            try {
                await client.close();
            }
            catch {
                // Ignore close errors — server might already be dead
            }
            this.upstreams.delete(serverKey);
        }
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