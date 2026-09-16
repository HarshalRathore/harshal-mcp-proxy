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
/**
 * Create the McpServer with all gateway tools registered.
 * Built once per process (stdio mode); HTTP mode uses per-request low-level
 * Servers instead — see http-server.ts.
 */
export declare function createServer(services: SharedServices): McpServer;
