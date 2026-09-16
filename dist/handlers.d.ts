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
import type { SharedServices } from "./tools.js";
/**
 * Create the McpServer with all gateway tools registered.
 * Each transport (stdio, Streamable HTTP) builds its own server instance
 * over the same shared services.
 */
export declare function createServer(services: SharedServices): McpServer;
