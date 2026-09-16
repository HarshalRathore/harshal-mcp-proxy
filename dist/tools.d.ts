/**
 * tools.ts — The gateway's tool operations, shared by every transport.
 *
 * One implementation of search / describe / invoke / invoke_async /
 * invoke_status / get_result / status. handlers.ts binds these to MCP tool
 * registrations (stdio and Streamable HTTP); job execution in gateway.ts
 * reuses callTool() directly.
 */
import type { StatusHolder } from "./types.js";
import type { SearchEngine } from "./search.js";
import type { ConnectionManager } from "./connections.js";
import type { JobManager } from "./jobs.js";
import type { ResponseShield, ResponseStore, QueryOptions } from "./response-store.js";
import type { ProjectRegistry } from "./projectRegistry.js";
/** Everything the tool operations need from the gateway. */
export interface SharedServices {
    searchEngine: SearchEngine;
    connections: ConnectionManager;
    jobManager: JobManager;
    responseStore: ResponseStore;
    responseShield: ResponseShield;
    projectRegistry: ProjectRegistry;
    statusHolder: StatusHolder;
}
export interface InvokeArgs {
    id: string;
    args: Record<string, unknown>;
    timeoutMs?: number;
}
export declare class GatewayTools {
    private services;
    constructor(services: SharedServices);
    search(query: string, limit?: number, server?: string): unknown;
    private searchEntry;
    describe(id: string): unknown;
    /** Execute a tool, shield the response, and report the truncation ref. */
    callTool({ id, args, timeoutMs }: InvokeArgs): Promise<{
        shielded: unknown;
        ref: string | null;
    }>;
    /** gateway.invoke: execute synchronously and mark the payload if truncated. */
    invoke({ id, args, timeoutMs }: InvokeArgs): Promise<unknown>;
    /** Auto-inject projectPath for codegraph tools if not provided */
    private injectProjectPath;
    invokeAsync(id: string, args: Record<string, unknown>, priority?: number): unknown;
    invokeStatus(jobId: string): unknown;
    getResult(ref: string, opts: QueryOptions): unknown;
    status(): unknown;
}
