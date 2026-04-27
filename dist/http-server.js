/**
 * http-server.ts — HTTP daemon mode for harshal-mcp-proxy.
 *
 * When started with --port (or --daemon), harshal-mcp-proxy binds to
 * an HTTP port and speaks MCP's Streamable HTTP transport (JSON-RPC 2.0).
 *
 * This lets multiple clients (pi sessions, VS Code) share ONE set of
 * upstream MCP servers instead of each client spawning its own fleet.
 *
 * JSON-RPC 2.0 endpoints:
 *   POST /mcp — MCP protocol (initialize, tools/list, tools/call, ping)
 *   GET  /health — Health check
 *
 * The MCP protocol flow:
 *   1. Client sends "initialize" → server returns capabilities
 *   2. Client sends "notifications/initialized" (no response needed)
 *   3. Client sends "tools/list" → server returns 6 gateway tool schemas
 *   4. Client sends "tools/call" with tool name + args → server executes
 */
import http from "node:http";
function jsonRpcSuccess(id, result) {
    return { jsonrpc: "2.0", id, result };
}
function jsonRpcError(id, code, message, data) {
    return { jsonrpc: "2.0", id, error: { code, message, data } };
}
// ──────────────────────────────────────────────
// MCP protocol version
// ──────────────────────────────────────────────
const MCP_PROTOCOL_VERSION = "2024-11-05";
const TOOL_SCHEMAS = [
    {
        name: "gateway.search",
        description: "Search for tools across all connected MCP servers using BM25 scoring with fuzzy matching. " +
            "Returns tool IDs, names, displayNames, fieldNames, descriptions, and relevance scores — NOT full schemas. " +
            "An empty query returns all available tools.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Search query (natural language)" },
                limit: { type: "number", description: "Max results to return (default 10, max 50)" },
                server: { type: "string", description: "Filter results to a specific server" },
            },
        },
    },
    {
        name: "gateway.describe",
        description: "Get full details for a specific tool including its complete input schema. " +
            "Use the tool ID from gateway.search results (format: serverKey::toolName).",
        inputSchema: {
            type: "object",
            properties: {
                id: { type: "string", description: "Tool ID from search results (e.g. 'neo4j-cypher::run_cypher_query')" },
            },
            required: ["id"],
        },
    },
    {
        name: "gateway.invoke",
        description: "Execute a tool on an upstream MCP server synchronously. " +
            "Response is automatically truncated if large — check for _ref field in the result. " +
            "If _ref is present, use gateway.get_result to paginate through the full response.",
        inputSchema: {
            type: "object",
            properties: {
                id: { type: "string", description: "Tool ID (e.g. 'playwright::browser_navigate')" },
                args: { type: "object", description: "Arguments to pass to the tool" },
                timeoutMs: { type: "number", description: "Timeout in milliseconds (default 60000)" },
            },
            required: ["id", "args"],
        },
    },
    {
        name: "gateway.invoke_async",
        description: "Start an asynchronous tool execution. Returns a job ID immediately. " +
            "Use gateway.invoke_status to poll for completion.",
        inputSchema: {
            type: "object",
            properties: {
                id: { type: "string", description: "Tool ID (e.g. 'tavily-remote-mcp::search')" },
                args: { type: "object", description: "Arguments for the tool" },
                priority: { type: "number", description: "Priority (higher = runs first, default 0)" },
            },
            required: ["id", "args"],
        },
    },
    {
        name: "gateway.invoke_status",
        description: "Check the status of an async job. Returns status, result (if completed), or error (if failed).",
        inputSchema: {
            type: "object",
            properties: {
                jobId: { type: "string", description: "Job ID from gateway.invoke_async" },
            },
            required: ["jobId"],
        },
    },
    {
        name: "gateway.get_result",
        description: "Retrieve the full result of a truncated tool response. " +
            "Use the _ref value from a truncated gateway.invoke response. " +
            "Supports pagination (offset/limit), field projection, and text search.",
        inputSchema: {
            type: "object",
            properties: {
                ref: { type: "string", description: "Ref handle from a truncated response" },
                offset: { type: "number", description: "Start position (array index or char offset, default 0)" },
                limit: { type: "number", description: "Number of items to return (default 50, max 50)" },
                fields: { type: "array", items: { type: "string" }, description: "Project only these fields from each array item" },
                search: { type: "string", description: "Filter items containing this text (case-insensitive)" },
            },
            required: ["ref"],
        },
    },
];
// ──────────────────────────────────────────────
// HTTP MCP Server
// ──────────────────────────────────────────────
export class HttpMcpServer {
    searchEngine;
    connections;
    jobManager;
    responseStore;
    responseShield;
    projectRegistry;
    statusHolder;
    httpServer;
    port;
    initialized = false;
    constructor(searchEngine, connections, jobManager, responseStore, responseShield, projectRegistry, statusHolder, port) {
        this.searchEngine = searchEngine;
        this.connections = connections;
        this.jobManager = jobManager;
        this.responseStore = responseStore;
        this.responseShield = responseShield;
        this.projectRegistry = projectRegistry;
        this.statusHolder = statusHolder;
        this.port = port || 8765;
    }
    async start() {
        return new Promise((resolve) => {
            this.httpServer = http.createServer((req, res) => {
                // CORS headers for cross-origin clients
                res.setHeader("Access-Control-Allow-Origin", "*");
                res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
                res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
                if (req.method === "OPTIONS") {
                    res.writeHead(204);
                    res.end();
                    return;
                }
                if (req.method === "GET" && req.url === "/health") {
                    this.handleHealth(res);
                    return;
                }
                if (req.method === "POST" && (req.url === "/" || req.url === "/mcp")) {
                    this.handleJsonRpc(req, res);
                    return;
                }
                res.writeHead(404);
                res.end(JSON.stringify({ error: "Not found" }));
            });
            this.httpServer.listen(this.port, () => {
                console.error(`  [http-server] Listening on port ${this.port}`);
                console.error(`  [http-server] MCP endpoint: POST http://localhost:${this.port}/mcp`);
                console.error(`  [http-server] Health check: GET http://localhost:${this.port}/health`);
                resolve();
            });
            this.httpServer.on("error", (err) => {
                console.error(`  [http-server] Failed to start: ${err.message}`);
                process.exit(1);
            });
        });
    }
    async shutdown() {
        return new Promise((resolve) => {
            if (this.httpServer) {
                this.httpServer.close(() => resolve());
            }
            else {
                resolve();
            }
        });
    }
    handleHealth(res) {
        const connectedServers = this.connections.getConnectedServers();
        const totalTools = this.searchEngine.getTools().length;
        const status = {
            status: "ok",
            servers: connectedServers.length,
            tools: totalTools,
            uptime: process.uptime(),
            timestamp: Date.now(),
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(status));
    }
    async handleJsonRpc(req, res) {
        let body = "";
        req.on("data", (chunk) => (body += chunk.toString()));
        req.on("end", async () => {
            let request;
            try {
                request = JSON.parse(body);
            }
            catch {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify(jsonRpcError(null, -32700, "Parse error: invalid JSON")));
                return;
            }
            if (request.jsonrpc !== "2.0" || !request.method) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify(jsonRpcError(request.id ?? null, -32600, "Invalid Request: must have jsonrpc and method")));
                return;
            }
            try {
                const response = await this.processRequest(request);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(response));
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify(jsonRpcError(request.id ?? null, -32603, `Internal error: ${message}`)));
            }
        });
    }
    async processRequest(request) {
        const id = request.id ?? null;
        const { method, params } = request;
        switch (method) {
            case "initialize":
                return this.handleInitialize(id);
            case "notifications/initialized":
                this.initialized = true;
                return jsonRpcSuccess(id, {});
            case "notifications/cancelled":
                // No-op, just acknowledge
                return jsonRpcSuccess(id, {});
            case "ping":
                return jsonRpcSuccess(id, {});
            case "tools/list":
                return this.handleToolsList(id);
            case "tools/call":
                return await this.handleToolsCall(id, params);
            default:
                return jsonRpcError(id, -32601, `Method not found: ${method}`);
        }
    }
    handleInitialize(id) {
        return jsonRpcSuccess(id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {
                tools: {},
            },
            serverInfo: {
                name: "harshal-mcp-proxy",
                version: "1.0.0",
            },
        });
    }
    handleToolsList(id) {
        const tools = TOOL_SCHEMAS.map((t) => ({
            name: t.name,
            title: t.name.replace("gateway.", ""),
            description: t.description,
            inputSchema: t.inputSchema,
        }));
        return jsonRpcSuccess(id, { tools });
    }
    async handleToolsCall(id, params) {
        if (!params || !params.name) {
            return jsonRpcError(id, -32602, "Invalid params: 'name' is required");
        }
        const toolName = String(params.name);
        const args = params.arguments || {};
        switch (toolName) {
            case "gateway.search":
                return this.executeSearch(id, args);
            case "gateway.describe":
                return this.executeDescribe(id, args);
            case "gateway.invoke":
                return await this.executeInvoke(id, args);
            case "gateway.invoke_async":
                return this.executeInvokeAsync(id, args);
            case "gateway.invoke_status":
                return this.executeInvokeStatus(id, args);
            case "gateway.get_result":
                return this.executeGetResult(id, args);
            default:
                return jsonRpcError(id, -32602, `Unknown tool: ${toolName}. Available tools: gateway.search, gateway.describe, gateway.invoke, gateway.invoke_async, gateway.invoke_status, gateway.get_result`);
        }
    }
    // ── Tool: gateway.search ──────────────────────────────────
    executeSearch(id, args) {
        const query = String(args.query || "");
        const limit = Number(args.limit) || 10;
        const serverFilter = args.server ? String(args.server) : undefined;
        const filters = {};
        if (serverFilter)
            filters.server = serverFilter;
        const results = this.searchEngine.search(query, filters, limit);
        const searchResult = {
            query,
            found: results.length,
            connectedServers: this.connections.getConnectedServers(),
            results: results.map((r) => ({
                id: r.id,
                name: r.name,
                displayName: r.displayName,
                server: r.server,
                description: r.description
                    ? r.description.slice(0, 120) + (r.description.length > 120 ? "..." : "")
                    : undefined,
                fieldNames: r.fieldNames,
                score: Math.round(r.score * 100) / 100,
            })),
        };
        return jsonRpcSuccess(id, {
            content: [{ type: "text", text: JSON.stringify(searchResult, null, 2) }],
        });
    }
    // ── Tool: gateway.describe ─────────────────────────────────
    executeDescribe(id, args) {
        const toolId = String(args.id || "");
        const tool = this.searchEngine.getSchema(toolId);
        if (!tool) {
            return jsonRpcError(id, -32602, `Tool not found: ${toolId}`);
        }
        return jsonRpcSuccess(id, {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        id: tool.id,
                        server: tool.server,
                        name: tool.name,
                        title: tool.title,
                        description: tool.description,
                        inputSchema: tool.inputSchema,
                        outputSchema: tool.outputSchema,
                    }, null, 2),
                },
            ],
        });
    }
    // ── Tool: gateway.invoke ───────────────────────────────────
    async executeInvoke(id, args) {
        const toolId = String(args.id || "");
        const toolArgs = args.args || {};
        const timeoutMs = Number(args.timeoutMs) || 60_000;
        // Parse composite tool ID: "serverKey::toolName"
        const separatorIndex = toolId.indexOf("::");
        if (separatorIndex === -1) {
            return jsonRpcError(id, -32602, `Invalid tool ID format: ${toolId}. Expected "serverKey::toolName"`);
        }
        const serverKey = toolId.slice(0, separatorIndex);
        const toolName = toolId.slice(separatorIndex + 2);
        const client = this.connections.getClient(serverKey);
        if (!client) {
            return jsonRpcError(id, -32000, `Server not connected: ${serverKey}. Connected servers: ${this.connections.getConnectedServers().join(", ")}`);
        }
        const tool = this.searchEngine.getTool(toolId);
        if (!tool) {
            return jsonRpcError(id, -32602, `Tool not found in catalog: ${toolId}`);
        }
        try {
            // Auto-inject projectPath for codegraph tools
            let finalArgs = toolArgs;
            if (serverKey === "codegraph" && this.projectRegistry) {
                if (!("projectPath" in toolArgs)) {
                    const resolved = this.projectRegistry.resolveProjectPath();
                    if (resolved)
                        finalArgs = { ...finalArgs, projectPath: resolved };
                }
            }
            // Call the upstream tool with timeout
            const result = await Promise.race([
                client.callTool({ name: toolName, arguments: finalArgs }),
                new Promise((_, reject) => setTimeout(() => reject(new Error(`TIMEOUT: Tool ${toolId} exceeded ${timeoutMs}ms`)), timeoutMs)),
            ]);
            // Response shielding
            const { shielded, ref, wasTruncated } = this.responseShield.shield(toolId, result);
            let shieldedObj = shielded;
            if (ref && typeof shielded === "object" && shielded !== null) {
                shieldedObj = { ...shieldedObj };
                shieldedObj._ref = ref;
                shieldedObj._truncated = true;
                shieldedObj._note =
                    `Response was truncated. Use gateway.get_result with ref "${ref}" to access the full data.`;
            }
            return jsonRpcSuccess(id, {
                content: [{ type: "text", text: JSON.stringify(shieldedObj, null, 2) }],
            });
        }
        catch (err) {
            return jsonRpcError(id, -32000, err.message);
        }
    }
    // ── Tool: gateway.invoke_async ─────────────────────────────
    executeInvokeAsync(id, args) {
        const toolId = String(args.id || "");
        const toolArgs = args.args || {};
        const priority = Number(args.priority) || 0;
        const job = this.jobManager.createJob(toolId, toolArgs, priority);
        this.jobManager.processQueue();
        return jsonRpcSuccess(id, {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ jobId: job.id, status: "queued", toolId }, null, 2),
                },
            ],
        });
    }
    // ── Tool: gateway.invoke_status ────────────────────────────
    executeInvokeStatus(id, args) {
        const jobId = String(args.jobId || "");
        const job = this.jobManager.getJob(jobId);
        if (!job) {
            return jsonRpcError(id, -32602, `Job not found: ${jobId}`);
        }
        return jsonRpcSuccess(id, {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        jobId: job.id,
                        status: job.status,
                        toolId: job.toolId,
                        createdAt: job.createdAt,
                        startedAt: job.startedAt,
                        finishedAt: job.finishedAt,
                        result: job.result,
                        error: job.error,
                        logs: job.logs,
                    }, null, 2),
                },
            ],
        });
    }
    // ── Tool: gateway.get_result ───────────────────────────────
    executeGetResult(id, args) {
        const ref = String(args.ref || "");
        const offset = Number(args.offset) || undefined;
        const limit = args.limit !== undefined ? Number(args.limit) : undefined;
        const fields = args.fields;
        const search = args.search ? String(args.search) : undefined;
        const result = this.responseStore.query(ref, { offset, limit, fields, search });
        if ("error" in result) {
            return jsonRpcError(id, -32602, result.error);
        }
        return jsonRpcSuccess(id, {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        ...result.meta,
                        data: result.data,
                    }, null, 2),
                },
            ],
        });
    }
}
//# sourceMappingURL=http-server.js.map