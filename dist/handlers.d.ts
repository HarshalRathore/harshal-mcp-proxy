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
export declare function createServer(searchEngine: SearchEngine, connections: ConnectionManager, jobManager: JobManager, responseStore: ResponseStore, responseShield: ResponseShield, projectRegistry?: import("./projectRegistry.js").ProjectRegistry, statusHolder?: StatusHolder): McpServer;
export interface StatusHolder {
    getConnectedServers: () => string[];
    getToolCount: (server: string) => number;
    getTotalTools: () => number;
    getConfigPath: () => string;
    getLastReloadTimestamp: () => number;
    isPendingReload: () => boolean;
    getProjects: () => Array<{
        name: string;
        path: string;
    }>;
    getDefaultProject: () => string | null;
}
