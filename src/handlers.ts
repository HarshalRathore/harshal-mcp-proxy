/**
 * handlers.ts — The 6 gateway tools exposed to opencode.
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  Instead of opencode seeing 40-70+ tool schemas from 7 servers,   │
 * │  it sees exactly 6 tools from this gateway. That's the whole      │
 * │  point of schema deferral.                                        │
 * │                                                                    │
 * │  Tool 1: gateway.search   — BM25 search the tool catalog          │
 * │  Tool 2: gateway.describe — Get full schema for one tool           │
 * │  Tool 3: gateway.invoke   — Call a tool (sync, with shielding)     │
 * │  Tool 4: gateway.invoke_async — Queue a job, get a jobId           │
 * │  Tool 5: gateway.invoke_status — Poll a job's status               │
 * │  Tool 6: gateway.get_result — Page through stored full responses   │
 * │                                                                    │
 * │  The model's workflow becomes:                                     │
 * │    search → describe → invoke → (optionally) get_result            │
 * └────────────────────────────────────────────────────────────────────┘
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SearchFilters } from "./types.js";
import { SearchEngine } from "./search.js";
import { JobManager } from "./jobs.js";
import { ConnectionManager } from "./connections.js";
import { ResponseStore, ResponseShield } from "./response-store.js";

/**
 * Create the McpServer with all 6 gateway tools registered.
 *
 * @param searchEngine - BM25 search index over all upstream tools
 * @param connections - Manages connections to upstream MCP servers
 * @param jobManager - Async job queue
 * @param responseStore - Ring buffer for full tool responses
 * @param responseShield - Truncation engine for response shielding
 * @returns Configured McpServer ready to connect to a transport
 */
export function createServer(
  searchEngine: SearchEngine,
  connections: ConnectionManager,
  jobManager: JobManager,
  responseStore: ResponseStore,
  responseShield: ResponseShield
): McpServer {
  const server = new McpServer(
    { name: "harshal-mcp-proxy", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  // ─────────────────────────────────────────
  // Tool 1: gateway.search
  // ─────────────────────────────────────────
  // The model's entry point. Search by natural language query.
  // Returns tool IDs + descriptions + scores — NO schemas.
  // This alone saves thousands of tokens per interaction.
  server.registerTool(
    "gateway.search",
    {
      title: "Search MCP Tools",
      description:
        "Search for tools across all connected MCP servers using BM25 scoring with fuzzy matching. " +
        "Returns tool IDs, names, descriptions, and relevance scores — NOT full schemas. " +
        "Use gateway.describe to get the full input schema for a specific tool before invoking it. " +
        "An empty query returns all available tools.",
      inputSchema: {
        query: z.string().describe("Search query (natural language, e.g. 'run cypher query' or 'navigate browser')"),
        limit: z.number().optional().describe("Max results to return (default 10, max 50)"),
        server: z.string().optional().describe("Filter results to a specific server (e.g. 'neo4j-cypher')"),
      },
    },
    async ({ query, limit, server: serverFilter }) => {
      const filters: SearchFilters = {};
      if (serverFilter) filters.server = serverFilter;

      const results = searchEngine.search(query, filters, limit || 10);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                query,
                found: results.length,
                connectedServers: connections.getConnectedServers(),
                results: results.map((r) => ({
                  id: r.id,
                  name: r.name,
                  server: r.server,
                  description: r.description
                    ? r.description.slice(0, 120) + (r.description.length > 120 ? "..." : "")
                    : undefined,
                  score: Math.round(r.score * 100) / 100,
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ─────────────────────────────────────────
  // Tool 2: gateway.describe
  // ─────────────────────────────────────────
  // Returns the FULL tool schema (inputSchema) for one specific tool.
  // This is the "deferred" schema load — only fetched when the model
  // actually needs to call a tool.
  server.registerTool(
    "gateway.describe",
    {
      title: "Describe MCP Tool",
      description:
        "Get full details for a specific tool including its complete input schema. " +
        "Use the tool ID from gateway.search results (format: serverKey::toolName). " +
        "You MUST call this before gateway.invoke to know the correct argument format.",
      inputSchema: {
        id: z.string().describe("Tool ID from search results (e.g. 'neo4j-cypher::run_cypher_query')"),
      },
    },
    async ({ id }) => {
      const tool = searchEngine.getTool(id);
      if (!tool) {
        return {
          content: [{ type: "text" as const, text: `ERROR: Tool not found: ${id}` }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                id: tool.id,
                server: tool.server,
                name: tool.name,
                title: tool.title,
                description: tool.description,
                inputSchema: tool.inputSchema,
                outputSchema: tool.outputSchema,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ─────────────────────────────────────────
  // Tool 3: gateway.invoke
  // ─────────────────────────────────────────
  // Execute a tool synchronously. The response passes through
  // ResponseShield before reaching the model, so large results
  // get truncated and stored for pagination.
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
      // Parse the composite tool ID
      const separatorIndex = id.indexOf("::");
      if (separatorIndex === -1) {
        return {
          content: [{ type: "text" as const, text: `ERROR: Invalid tool ID format: ${id}. Expected "serverKey::toolName"` }],
          isError: true,
        };
      }

      const serverKey = id.slice(0, separatorIndex);
      const toolName = id.slice(separatorIndex + 2);

      const client = connections.getClient(serverKey);
      if (!client) {
        return {
          content: [{ type: "text" as const, text: `ERROR: Server not connected: ${serverKey}. Connected servers: ${connections.getConnectedServers().join(", ")}` }],
          isError: true,
        };
      }

      const tool = searchEngine.getTool(id);
      if (!tool) {
        return {
          content: [{ type: "text" as const, text: `ERROR: Tool not found in catalog: ${id}` }],
          isError: true,
        };
      }

      try {
        // Call the upstream tool with timeout
        const timeout = timeoutMs || 60_000;
        const result = await Promise.race([
          client.callTool({ name: toolName, arguments: args as Record<string, unknown> }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`TIMEOUT: Tool ${id} exceeded ${timeout}ms`)), timeout)
          ),
        ]);

        // ── Response Shielding ──
        // This is where we intercept the response and truncate it
        const { shielded, ref, wasTruncated } = responseShield.shield(id, result);

        // If truncated, inject the _ref into the response so the model knows
        if (ref && typeof shielded === "object" && shielded !== null) {
          (shielded as Record<string, unknown>)._ref = ref;
          (shielded as Record<string, unknown>)._truncated = true;
          (shielded as Record<string, unknown>)._note =
            `Response was truncated. Use gateway.get_result with ref "${ref}" to access the full data.`;
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(shielded, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: `ERROR: ${(error as Error).message}` }],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────
  // Tool 4: gateway.invoke_async
  // ─────────────────────────────────────────
  // Queue a tool for async execution. Returns immediately with a jobId.
  // Useful for long-running operations like web searches or E2E tests.
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
      const job = jobManager.createJob(id, args, priority || 0);
      jobManager.processQueue();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { jobId: job.id, status: "queued", toolId: id },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ─────────────────────────────────────────
  // Tool 5: gateway.invoke_status
  // ─────────────────────────────────────────
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
      const job = jobManager.getJob(jobId);
      if (!job) {
        return {
          content: [{ type: "text" as const, text: `ERROR: Job not found: ${jobId}` }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                jobId: job.id,
                status: job.status,
                toolId: job.toolId,
                createdAt: job.createdAt,
                startedAt: job.startedAt,
                finishedAt: job.finishedAt,
                result: job.result,
                error: job.error,
                logs: job.logs,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ─────────────────────────────────────────
  // Tool 6: gateway.get_result
  // ─────────────────────────────────────────
  // THIS IS THE KEY TOOL that mcp-gateway lacks.
  // It gives the model paginated access to truncated responses.
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
      const result = responseStore.query(ref, { offset, limit, fields, search });

      if ("error" in result) {
        return {
          content: [{ type: "text" as const, text: `ERROR: ${result.error}` }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ...result.meta,
                data: result.data,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  return server;
}
