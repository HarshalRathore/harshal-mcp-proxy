/**
 * handlers.ts — The gateway tools exposed over stdio (and any McpServer consumer).
 *
 * ┌────────────────────────────────────────────────────────────────────┐
 * │  Instead of opencode seeing 40-70+ tool schemas from 7 servers,   │
 * │  it sees a handful of tools from this gateway. That's the whole   │
 * │  point of schema deferral.                                        │
 * │                                                                    │
 * │  Tool names, schemas, and behavior live in tool-definitions.ts —  │
 * │  this file only binds them to an McpServer. The HTTP daemon        │
 * │  (http-server.ts) binds the same definitions to a low-level        │
 * │  Server with pre-built schemas, avoiding per-request setup.        │
 * └────────────────────────────────────────────────────────────────────┘
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SharedServices } from "./tools.js";
import { GatewayTools } from "./tools.js";
import { TOOL_DEFINITIONS, errorResult, textResult } from "./tool-definitions.js";

/**
 * Create the McpServer with all gateway tools registered.
 * Built once per process (stdio mode); HTTP mode uses per-request low-level
 * Servers instead — see http-server.ts.
 */
export function createServer(services: SharedServices): McpServer {
  const server = new McpServer(
    { name: "harshal-mcp-proxy", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  const tools = new GatewayTools(services);

  for (const def of TOOL_DEFINITIONS) {
    server.registerTool(
      def.name,
      { title: def.title, description: def.description, inputSchema: def.schema.shape },
      async (args: Record<string, unknown>) => {
        try {
          return textResult(await def.run(tools, args));
        } catch (err) {
          return errorResult(err);
        }
      }
    );
  }

  return server;
}
