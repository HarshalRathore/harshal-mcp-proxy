/**
 * tool-definitions.ts — Single source of truth for the gateway's MCP tools.
 *
 * Each tool is defined once as data: name, title, description, zod input
 * shape, and a runner. Transports build McpServers from this list
 * (handlers.ts for stdio, http-server.ts per client session), so both modes
 * expose identical tools, schemas, and behavior.
 */
import { z } from "zod";
import { errorMessage } from "./util.js";
/** Serialize a payload as pretty JSON text content. */
export function textResult(payload) {
    return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    };
}
/** Format a thrown error as an MCP tool error. */
export function errorResult(error) {
    return {
        content: [{ type: "text", text: `ERROR: ${errorMessage(error)}` }],
        isError: true,
    };
}
/**
 * Define one tool. `args` reaches run() only after being validated against
 * `shape` (either by the SDK for stdio, or by validateToolArgs for HTTP),
 * which is what makes the single cast in run() sound.
 */
function defineTool(def) {
    return {
        name: def.name,
        title: def.title,
        description: def.description,
        schema: z.object(def.shape),
        run: (tools, args) => def.run(tools, args),
    };
}
/** All gateway tools, in the order they appear in tools/list. */
export const TOOL_DEFINITIONS = [
    defineTool({
        name: "gateway.search",
        title: "Search MCP Tools",
        description: "Search for tools across all connected MCP servers using BM25 scoring with fuzzy matching. " +
            "Returns tool IDs, names, displayNames, fieldNames, descriptions, and relevance scores — NOT full schemas. " +
            "An empty query returns all available tools.",
        shape: {
            query: z.string().describe("Search query (natural language, e.g. 'run cypher query' or 'navigate browser')"),
            limit: z.number().optional().describe("Max results to return (default 10, max 50)"),
            server: z.string().optional().describe("Filter results to a specific server (e.g. 'neo4j-cypher')"),
        },
        run: (tools, { query, limit, server }) => tools.search(query, limit, server),
    }),
    defineTool({
        name: "gateway.describe",
        title: "Describe MCP Tool",
        description: "Get full details for a specific tool including its complete input schema. " +
            "Use the tool ID from gateway.search results (format: serverKey::toolName). " +
            "Most tools return fieldNames in search results — describe is only needed for full schema detail.",
        shape: {
            id: z.string().describe("Tool ID from search results (e.g. 'neo4j-cypher::run_cypher_query')"),
        },
        run: (tools, { id }) => tools.describe(id),
    }),
    defineTool({
        name: "gateway.invoke",
        title: "Invoke MCP Tool",
        description: "Execute a tool on an upstream MCP server synchronously. " +
            "Response is automatically truncated if large — check for _ref field in the result. " +
            "If _ref is present, use gateway.get_result to paginate through the full response. " +
            "Always call gateway.describe first to know the correct argument format.",
        shape: {
            id: z.string().describe("Tool ID (e.g. 'playwright::browser_navigate')"),
            args: z.record(z.string(), z.unknown()).describe("Arguments to pass to the tool (match the inputSchema from gateway.describe)"),
            timeoutMs: z.number().optional().describe("Timeout in milliseconds (default 60000)"),
        },
        run: (tools, { id, args, timeoutMs }) => tools.invoke({ id, args, timeoutMs }),
    }),
    defineTool({
        name: "gateway.invoke_async",
        title: "Invoke Tool Async",
        description: "Start an asynchronous tool execution. Returns a job ID immediately. " +
            "Use gateway.invoke_status to poll for completion. " +
            "Useful for long-running tools (web search, E2E tests, etc.).",
        shape: {
            id: z.string().describe("Tool ID (e.g. 'tavily-remote-mcp::search')"),
            args: z.record(z.string(), z.unknown()).describe("Arguments for the tool"),
            priority: z.number().optional().describe("Priority (higher = runs first, default 0)"),
        },
        run: (tools, { id, args, priority }) => tools.invokeAsync(id, args, priority),
    }),
    defineTool({
        name: "gateway.invoke_status",
        title: "Check Job Status",
        description: "Check the status of an async job. Returns status, result (if completed), or error (if failed).",
        shape: {
            jobId: z.string().describe("Job ID from gateway.invoke_async"),
        },
        run: (tools, { jobId }) => tools.invokeStatus(jobId),
    }),
    defineTool({
        name: "gateway.get_result",
        title: "Get Stored Result",
        description: "Retrieve the full result of a truncated tool response. " +
            "Use the _ref value from a truncated gateway.invoke response. " +
            "Supports pagination (offset/limit), field projection, and text search. " +
            "For arrays: offset and limit paginate through items. " +
            "For strings: offset is character position. " +
            "Use 'fields' to project specific keys from array items (reduces token usage). " +
            "Use 'search' to filter items containing specific text.",
        shape: {
            ref: z.string().describe("Ref handle from a truncated response (e.g. 'r1', 'r3')"),
            offset: z.number().optional().describe("Start position (array index or char offset, default 0)"),
            limit: z.number().optional().describe("Number of items to return (default 50, max 50)"),
            fields: z.array(z.string()).optional().describe("Project only these fields from each array item"),
            search: z.string().optional().describe("Filter items containing this text (case-insensitive)"),
        },
        run: (tools, { ref, offset, limit, fields, search }) => tools.getResult(ref, { offset, limit, fields, search }),
    }),
    defineTool({
        name: "gateway.status",
        title: "Get Gateway Status",
        description: "Returns the current status of the gateway including connected servers, " +
            "tool counts, config file path, last reload timestamp, pending reload status, " +
            "and available codegraph projects. Use this to check if config reloaded after changes.",
        shape: {},
        run: (tools) => tools.status(),
    }),
];
//# sourceMappingURL=tool-definitions.js.map