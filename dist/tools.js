/**
 * tools.ts — The gateway's tool operations, shared by every transport.
 *
 * One implementation of search / describe / invoke / invoke_async /
 * invoke_status / get_result / status. handlers.ts binds these to MCP tool
 * registrations (stdio and Streamable HTTP); job execution in gateway.ts
 * reuses callTool() directly.
 */
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { isPlainObject } from "./util.js";
/** Split "serverKey::toolName". Returns null when the id has no separator. */
function parseToolId(id) {
    const separatorIndex = id.indexOf("::");
    if (separatorIndex === -1)
        return null;
    return { serverKey: id.slice(0, separatorIndex), toolName: id.slice(separatorIndex + 2) };
}
export class GatewayTools {
    services;
    constructor(services) {
        this.services = services;
    }
    // ── gateway.search ─────────────────────────────────────────
    search(query, limit, server) {
        const filters = server ? { server } : {};
        const results = this.services.searchEngine.search(query, filters, limit ?? 10);
        return {
            query,
            found: results.length,
            connectedServers: this.services.connections.getConnectedServers(),
            results: results.map((r) => this.searchEntry(r)),
        };
    }
    searchEntry(r) {
        return {
            id: r.id,
            name: r.name,
            displayName: r.displayName,
            server: r.server,
            connected: this.services.connections.getConnectionState(r.server) === "connected",
            description: r.description
                ? r.description.slice(0, 120) + (r.description.length > 120 ? "..." : "")
                : undefined,
            fieldNames: r.fieldNames,
            score: Math.round(r.score * 100) / 100,
        };
    }
    // ── gateway.describe ───────────────────────────────────────
    describe(id) {
        const tool = this.services.searchEngine.getTool(id);
        if (!tool)
            throw new Error(`Tool not found: ${id}`);
        return {
            id: tool.id,
            server: tool.server,
            name: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
        };
    }
    // ── gateway.invoke (+ job execution) ───────────────────────
    /** Execute a tool, shield the response, and report the truncation ref. */
    async callTool({ id, args, timeoutMs }) {
        const parsed = parseToolId(id);
        if (!parsed)
            throw new Error(`Invalid tool ID format: ${id}. Expected "serverKey::toolName"`);
        const { serverKey, toolName } = parsed;
        const client = await this.services.connections.ensureConnected(serverKey);
        this.services.connections.markServerUsed(serverKey);
        if (!this.services.searchEngine.getTool(id)) {
            throw new Error(`Tool not found in catalog: ${id}`);
        }
        const timeout = timeoutMs ?? 60_000;
        const finalArgs = this.injectProjectPath(serverKey, args);
        const result = await callUpstream(client, toolName, finalArgs, timeout, id);
        return this.services.responseShield.shield(id, result);
    }
    /** gateway.invoke: execute synchronously and mark the payload if truncated. */
    async invoke({ id, args, timeoutMs }) {
        const { shielded, ref } = await this.callTool({ id, args, timeoutMs });
        if (ref === null || !isPlainObject(shielded))
            return shielded;
        return {
            ...shielded,
            _ref: ref,
            _truncated: true,
            _note: `Response was truncated. Use gateway.get_result with ref "${ref}" to access the full data.`,
        };
    }
    /** Auto-inject projectPath for codegraph tools if not provided */
    injectProjectPath(serverKey, args) {
        if (serverKey !== "codegraph" || "projectPath" in args)
            return args;
        const resolved = this.services.projectRegistry.resolveProjectPath();
        return resolved ? { ...args, projectPath: resolved } : args;
    }
    // ── gateway.invoke_async / gateway.invoke_status ───────────
    invokeAsync(id, args, priority = 0) {
        const job = this.services.jobManager.createJob(id, args, priority);
        this.services.jobManager.processQueue();
        return { jobId: job.id, status: "queued", toolId: id };
    }
    invokeStatus(jobId) {
        const job = this.services.jobManager.getJob(jobId);
        if (!job)
            throw new Error(`Job not found: ${jobId}`);
        return jobStatusPayload(job);
    }
    // ── gateway.get_result ─────────────────────────────────────
    getResult(ref, opts) {
        const result = this.services.responseStore.query(ref, opts);
        if (!result.ok)
            throw new Error(result.error);
        return { ...result.meta, data: result.data };
    }
    // ── gateway.status ─────────────────────────────────────────
    status() {
        const { statusHolder } = this.services;
        return {
            connectedServers: statusHolder.getConnectedServers().map((name) => ({
                name,
                toolCount: statusHolder.getToolCount(name),
            })),
            totalTools: statusHolder.getTotalTools(),
            configPath: statusHolder.getConfigPath(),
            lastReloadTimestamp: statusHolder.getLastReloadTimestamp(),
            pendingReload: statusHolder.isPendingReload(),
            codegraphProjects: statusHolder.getProjects(),
            defaultProject: statusHolder.getDefaultProject(),
        };
    }
}
/** Call an upstream tool with the SDK-managed request timeout. */
async function callUpstream(client, toolName, args, timeoutMs, toolId) {
    try {
        return await client.callTool({ name: toolName, arguments: args }, undefined, { timeout: timeoutMs });
    }
    catch (err) {
        if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
            throw new Error(`TIMEOUT: Tool ${toolId} exceeded ${timeoutMs}ms`);
        }
        throw err;
    }
}
/** Shape of the gateway.invoke_status payload. */
function jobStatusPayload(job) {
    return {
        jobId: job.id,
        status: job.status,
        toolId: job.toolId,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        result: job.result,
        error: job.error,
        logs: job.logs,
    };
}
//# sourceMappingURL=tools.js.map