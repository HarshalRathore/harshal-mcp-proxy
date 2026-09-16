/**
 * types.ts — Shared interfaces for harshal-mcp-proxy.
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  Three layers of types:                                        │
 * │  1. Catalog types — the compressed tool index (schema deferral) │
 * │  2. Store types — response shielding + pagination refs          │
 * │  3. Connection/job types — lazy loading + async invocation      │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * Config types live next to their runtime schema in config.ts.
 * This module is a leaf: it must not import from any other module.
 */
/**
 * Full catalog entry for one upstream tool.
 * Stored in SearchEngine, returned by gateway.describe.
 * The inputSchema is the FULL JSON Schema — only sent on describe, never on search.
 */
export interface ToolCatalogEntry {
    /** Composite key: "serverKey::toolName" */
    id: string;
    /** Which upstream server owns this tool */
    server: string;
    /** The tool's native name */
    name: string;
    /** Human-readable title (if the upstream provides one) */
    title?: string;
    /** Tool description — used for BM25 search scoring */
    description?: string;
    /** Full JSON Schema for the tool's input — the expensive part we defer */
    inputSchema?: unknown;
    /** Full JSON Schema for the tool's output (if provided) */
    outputSchema?: unknown;
    /** Parameter names extracted from inputSchema (computed at index time) */
    fieldNames?: string[];
}
/** Filters for search queries */
export interface SearchFilters {
    /** Restrict results to a specific upstream server */
    server?: string;
}
/** A single search result returned by gateway.search */
export interface SearchResult {
    id: string;
    server: string;
    name: string;
    displayName?: string;
    description?: string;
    score: number;
    fieldNames?: string[];
}
/**
 * A stored full response from an upstream tool invocation.
 * The model only sees the truncated version; this is the original.
 */
export interface StoredResponse {
    /** Addressable ref handle: "r1", "r2", etc. */
    ref: string;
    /** Which tool produced this: "serverKey::toolName" */
    toolId: string;
    /** Unix timestamp of when this was stored */
    timestamp: number;
    /** The complete, untruncated response */
    full: unknown;
    /** Byte size of the full serialized response */
    byteSize: number;
}
/**
 * Result of shielding a response.
 * `shielded` goes to the model; `ref` is set if truncation occurred.
 */
export interface ShieldResult {
    /** The truncated/shielded response to return to the model */
    shielded: unknown;
    /** Ref handle if the response was stored (null if no truncation needed) */
    ref: string | null;
    /** Whether any truncation was applied */
    wasTruncated: boolean;
}
/** Pagination metadata returned with sliced results */
export interface SliceMeta {
    ref: string;
    total: number;
    offset: number;
    count: number;
    hasMore: boolean;
}
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'failed';
export interface ServerConnectionRecord {
    state: ConnectionState;
    lastUsedAt: number;
    connectedAt: number;
    requestCount: number;
    pid?: number;
}
export interface JobRecord {
    id: string;
    status: "queued" | "running" | "completed" | "failed";
    toolId: string;
    args: Record<string, unknown>;
    priority: number;
    createdAt: number;
    startedAt?: number;
    finishedAt?: number;
    result?: unknown;
    error?: string;
    logs: string[];
}
/** A registered project for codegraph auto-injection */
export interface CodeGraphProject {
    name: string;
    path: string;
}
/**
 * Runtime status the gateway exposes to the gateway.status tool.
 * Callbacks keep the status read cheap and always current.
 */
export interface StatusHolder {
    getConnectedServers: () => string[];
    getToolCount: (server: string) => number;
    getTotalTools: () => number;
    getConfigPath: () => string;
    getLastReloadTimestamp: () => number;
    isPendingReload: () => boolean;
    getProjects: () => CodeGraphProject[];
    getDefaultProject: () => string | null;
}
