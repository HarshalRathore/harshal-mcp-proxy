/**
 * types.ts — All interfaces for harshal-mcp-proxy.
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  Three layers of types:                                        │
 * │  1. Config types — what lives in config.json                   │
 * │  2. Catalog types — the compressed tool index (schema deferral)│
 * │  3. Store types — response shielding + pagination refs         │
 * └─────────────────────────────────────────────────────────────────┘
 */

// ──────────────────────────────────────────────
// 1. Configuration
// ──────────────────────────────────────────────

/**
 * Config for a single upstream MCP server.
 * Mirrors opencode.json MCP block format so you can copy entries directly.
 */
export interface UpstreamConfig {
  /** "local" = stdio subprocess, "remote" = HTTP/WebSocket */
  type: "local" | "remote";

  /** For local: command + args as array, e.g. ["npx", "-y", "some-mcp"] */
  command?: string[];

  /** For remote: the URL to connect to */
  url?: string;

  /** For remote: explicit transport override */
  transport?: "streamable_http" | "websocket";

  /** Environment variables. Supports {env:VAR_NAME} substitution from process.env */
  environment?: Record<string, string>;

  /** Set to false to skip this server entirely */
  enabled?: boolean;
}

/** Top-level config: server key → upstream config */
export interface GatewayConfig {
  [serverKey: string]: UpstreamConfig;
}

// ──────────────────────────────────────────────
// 2. Tool Catalog (schema deferral layer)
// ──────────────────────────────────────────────

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
  description?: string;
  score: number;
}

// ──────────────────────────────────────────────
// 3. Response Store (response shielding layer)
// ──────────────────────────────────────────────

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

  /** Whether the response was truncated before returning to the model */
  truncated: boolean;

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

// ──────────────────────────────────────────────
// 4. Job Manager (async invocation)
// ──────────────────────────────────────────────

export interface JobRecord {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  toolId: string;
  args: unknown;
  priority: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: unknown;
  error?: string;
  logs: string[];
}
