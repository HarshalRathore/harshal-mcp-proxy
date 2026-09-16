/**
 * handlers.ts — The gateway tools exposed to MCP clients.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  Instead of opencode seeing 40-70+ tool schemas from 7 servers,   │
 * │  it sees a handful of tools from this gateway. That's the whole   │
 * │  point of schema deferral.                                        │
 * │                                                                    │
 * │  Tool 1: gateway.search        — BM25 search the tool catalog     │
 * │  Tool 2: gateway.describe      — Get full schema for one tool      │
 * │  Tool 3: gateway.invoke        — Call a tool (sync, with shielding) │
 * │  Tool 4: gateway.invoke_async  — Queue a job, get a jobId          │
 * │  Tool 5: gateway.invoke_status — Poll a job's status               │
 * │  Tool 6: gateway.get_result    — Page through stored responses     │
 * │  Tool 7: gateway.status        — Gateway health and reload state   │
 * │                                                                    │
 * │  The model's workflow becomes:                                     │
 * │    search → describe → invoke → (optionally) get_result            │
 * │                                                                    │
 * │  All tool behavior lives in tools.ts — this file owns only the     │
 * │  MCP-facing schemas, descriptions, and result formatting.          │
 * └────────────────────────────────────────────────────────────────────┘
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { SharedServices } from "./tools.js";
import { GatewayTools } from "./tools.js";
import { errorMessage } from "./util.js";

/** Serialize a payload as pretty JSON text content. */
function textResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

/** Format a thrown error as an MCP tool error. */
function errorResult(error: unknown): CallToolResult {
  return {
    content: [{ type: "text" as const, text: `ERROR: ${errorMessage(error)}` }],
    isError: true,
  };
}

/**
 * Create the McpServer with all gateway tools registered.
 * Each transport (stdio, Streamable HTTP) builds its own server instance
 * over the same shared services.
 */
export function createServer(services: SharedServices): McpServer {
  const server = new McpServer(
    { name: "harshal-mcp-proxy", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  const tools = new GatewayTools(services);

  // ── Tool 1: gateway.search ──
  // The model's entry point. Returns tool IDs + descriptions + scores +
  // fieldNames — NO full schemas.
  server.registerTool(
    "gateway.search",
    {
      title: "Search MCP Tools",
      description:
        "Search for tools across all connected MCP servers using BM25 scoring with fuzzy matching. " +
        "Returns tool IDs, names, displayNames, fieldNames, descriptions, and relevance scores — NOT full schemas. " +
        "An empty query returns all available tools.",
      inputSchema: {
        query: z.string().describe("Search query (natural language, e.g. 'run cypher query' or 'navigate browser')"),
        limit: z.number().optional().describe("Max results to return (default 10, max 50)"),
        server: z.string().optional().describe("Filter results to a specific server (e.g. 'neo4j-cypher')"),
      },
    },
    async ({ query, limit, server: serverFilter }) => {
      try {
        return textResult(tools.search(query, limit, serverFilter));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // ── Tool 2: gateway.describe ──
  // Returns the FULL tool schema (inputSchema) for one specific tool.
  server.registerTool(
    "gateway.describe",
    {
      title: "Describe MCP Tool",
      description:
        "Get full details for a specific tool including its complete input schema. " +
        "Use the tool ID from gateway.search results (format: serverKey::toolName). " +
        "Most tools return fieldNames in search results — describe is only needed for full schema detail.",
      inputSchema: {
        id: z.string().describe("Tool ID from search results (e.g. 'neo4j-cypher::run_cypher_query')"),
      },
    },
    async ({ id }) => {
      try {
        return textResult(tools.describe(id));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // ── Tool 3: gateway.invoke ──
  // Execute synchronously. Large responses are truncated and stored for paging.
  server.registerTool(
    "gateway.invoke",
    {
      title: "Invoke MCP Tool",
      description:
        "Execute a tool on an upstream MCP server synchronously. " +
        "Response is automatically truncated if large — check for _ref field in the result. " +
        "If _ref is present, use gateway.get_result to paginate through the full response. " +
        "Always call gateway.describe first to know the correct argument format.",
      inputSchema: {
        id: z.string().describe("Tool ID (e.g. 'playwright::browser_navigate')"),
        args: z.record(z.string(), z.unknown()).describe("Arguments to pass to the tool (match the inputSchema from gateway.describe)"),
        timeoutMs: z.number().optional().describe("Timeout in milliseconds (default 60000)"),
      },
    },
    async ({ id, args, timeoutMs }) => {
      try {
        return textResult(await tools.invoke({ id, args, timeoutMs }));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // ── Tool 4: gateway.invoke_async ──
  server.registerTool(
    "gateway.invoke_async",
    {
      title: "Invoke Tool Async",
      description:
        "Start an asynchronous tool execution. Returns a job ID immediately. " +
        "Use gateway.invoke_status to poll for completion. " +
        "Useful for long-running tools (web search, E2E tests, etc.).",
      inputSchema: {
        id: z.string().describe("Tool ID (e.g. 'tavily-remote-mcp::search')"),
        args: z.record(z.string(), z.unknown()).describe("Arguments for the tool"),
        priority: z.number().optional().describe("Priority (higher = runs first, default 0)"),
      },
    },
    async ({ id, args, priority }) => {
      try {
        return textResult(tools.invokeAsync(id, args, priority));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // ── Tool 5: gateway.invoke_status ──
  server.registerTool(
    "gateway.invoke_status",
    {
      title: "Check Job Status",
      description:
        "Check the status of an async job. Returns status, result (if completed), or error (if failed).",
      inputSchema: {
        jobId: z.string().describe("Job ID from gateway.invoke_async"),
      },
    },
    async ({ jobId }) => {
      try {
        return textResult(tools.invokeStatus(jobId));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // ── Tool 6: gateway.get_result ──
  // Paginated access to truncated responses — the piece mcp-gateway lacks.
  server.registerTool(
    "gateway.get_result",
    {
      title: "Get Stored Result",
      description:
        "Retrieve the full result of a truncated tool response. " +
        "Use the _ref value from a truncated gateway.invoke response. " +
        "Supports pagination (offset/limit), field projection, and text search. " +
        "For arrays: offset and limit paginate through items. " +
        "For strings: offset is character position. " +
        "Use 'fields' to project specific keys from array items (reduces token usage). " +
        "Use 'search' to filter items containing specific text.",
      inputSchema: {
        ref: z.string().describe("Ref handle from a truncated response (e.g. 'r1', 'r3')"),
        offset: z.number().optional().describe("Start position (array index or char offset, default 0)"),
        limit: z.number().optional().describe("Number of items to return (default 50, max 50)"),
        fields: z.array(z.string()).optional().describe("Project only these fields from each array item"),
        search: z.string().optional().describe("Filter items containing this text (case-insensitive)"),
      },
    },
    async ({ ref, offset, limit, fields, search }) => {
      try {
        return textResult(tools.getResult(ref, { offset, limit, fields, search }));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  // ── Tool 7: gateway.status ──
  server.registerTool(
    "gateway.status",
    {
      title: "Get Gateway Status",
      description:
        "Returns the current status of the gateway including connected servers, " +
        "tool counts, config file path, last reload timestamp, pending reload status, " +
        "and available codegraph projects. Use this to check if config reloaded after changes.",
      inputSchema: {},
    },
    async () => {
      try {
        return textResult(tools.status());
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  return server;
}
