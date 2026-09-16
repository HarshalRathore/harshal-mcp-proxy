/**
 * response-store.ts — Response shielding + pagination store.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  THIS IS THE PIECE mcp-gateway LACKS ENTIRELY.                      │
 * │                                                                      │
 * │  Two classes:                                                        │
 * │                                                                      │
 * │  ResponseStore — Ring buffer (last 100 responses) that stores full   │
 * │    untruncated tool outputs. Addressable by ref handle ("r1","r2").  │
 * │    The model can page through stored results via gateway.get_result. │
 * │                                                                      │
 * │  ResponseShield — Processes every tool invocation response before    │
 * │    it returns to the model. Applies these rules in order:            │
 * │                                                                      │
 * │    1. Array cap: >50 items → keep first 50, note truncation          │
 * │    2. String cap: any string >8192 chars → truncate + marker         │
 * │    3. Smart field stripping: detect "heavy" fields in array objects  │
 * │       (avg >256 bytes) and omit them, listing names in _omitted      │
 * │    4. Total size cap: >64KB → iteratively drop items until under     │
 * │                                                                      │
 * │  Inspired by tldr's policy.go but implemented in TypeScript and      │
 * │  tuned for the opencode + Sonnet/Qwen context window.               │
 * └──────────────────────────────────────────────────────────────────────┘
 */
import type { StoredResponse, ShieldResult, SliceMeta } from "./types.js";
export interface QueryOptions {
    /** For arrays: skip N items (default 0). For strings: character offset. */
    offset?: number;
    /** For arrays: take N items (default 50, max 50) */
    limit?: number;
    /** Pick specific keys from each object in an array */
    fields?: string[];
    /** Case-insensitive text filter */
    search?: string;
}
export type QueryResult = {
    ok: true;
    data: unknown;
    meta: SliceMeta;
} | {
    ok: false;
    error: string;
};
export declare class ResponseStore {
    /** Map of ref → full stored response */
    private entries;
    /** Insertion order for eviction */
    private order;
    /** Monotonic counter for generating ref handles */
    private counter;
    /**
     * Store a full response and return its ref handle (e.g. "r1", "r2").
     *
     * @param toolId - Composite tool ID (e.g. "neo4j-cypher::run_cypher_query")
     * @param full - The complete untruncated response
     */
    store(toolId: string, full: unknown): string;
    /** Retrieve a stored response by ref */
    get(ref: string): StoredResponse | undefined;
    /**
     * Query a stored response with pagination, field projection, and text search.
     * This is the handler behind gateway.get_result.
     */
    query(ref: string, opts?: QueryOptions): QueryResult;
}
export declare class ResponseShield {
    private responseStore;
    constructor(responseStore: ResponseStore);
    /**
     * Shield a raw tool response before returning it to the model.
     * Applies the truncation rules in order and stores the full version
     * if any truncation occurred. Called on every gateway.invoke result.
     *
     * @returns { shielded: truncated response, ref: "r3" if truncated, wasTruncated }
     */
    shield(toolId: string, raw: unknown): ShieldResult;
    /**
     * Rule 1: Truncate arrays with >MAX_ARRAY_LENGTH items.
     * Walks the response looking for the "content" array pattern
     * (MCP responses have content: [{type: "text", text: "..."}])
     * and also any nested arrays in parsed JSON text.
     */
    private truncateArrays;
    /**
     * Rule 2: Smart field stripping for array-of-objects.
     * Detect fields whose average serialized size exceeds HEAVY_FIELD_THRESHOLD
     * bytes, strip them (except signal fields), and add an _omitted list so the
     * model knows what was removed. Adapted from tldr's policy.go compactArray().
     */
    private stripHeavyFields;
    /**
     * Rule 3: Truncate any string field exceeding MAX_STRING_LENGTH chars.
     * Walks the entire response recursively.
     */
    private truncateStrings;
    /**
     * Rule 4: Enforce MAX_RESPONSE_BYTES total size.
     * Iteratively shrink the largest structures (content text, top-level
     * arrays) and guarantee the cap with a hard text cut as a last resort.
     *
     * Safe to mutate in place: every container reaches this point freshly
     * built by rules 1-3, so nothing shared with the stored original changes.
     */
    private enforceMaxSize;
}
