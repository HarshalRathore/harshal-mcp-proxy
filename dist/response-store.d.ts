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
export declare class ResponseStore {
    /** Map of ref → full stored response */
    private entries;
    /** Insertion order for LRU eviction */
    private order;
    /** Monotonic counter for generating ref handles */
    private counter;
    /**
     * Store a full response and return its ref handle.
     *
     * @param toolId - Composite tool ID (e.g. "neo4j-cypher::run_cypher_query")
     * @param full - The complete untruncated response
     * @returns Ref handle like "r1", "r2", etc.
     */
    store(toolId: string, full: unknown): string;
    /** Retrieve a stored response by ref */
    get(ref: string): StoredResponse | undefined;
    /**
     * Query a stored response with pagination, field projection, and text search.
     *
     * This is the handler behind gateway.get_result — gives the model
     * paginated access to large responses without blowing up context.
     *
     * @param ref - Ref handle (e.g. "r3")
     * @param opts.offset - For arrays: skip N items (default 0)
     * @param opts.limit - For arrays: take N items (default 50, max 50)
     * @param opts.fields - Pick specific keys from each object in an array
     * @param opts.search - Text search within the stored result (case-insensitive)
     * @returns Paginated/filtered slice + metadata
     */
    query(ref: string, opts?: {
        offset?: number;
        limit?: number;
        fields?: string[];
        search?: string;
    }): {
        data: unknown;
        meta: SliceMeta;
    } | {
        error: string;
    };
    /** Get summary of all stored results (for debugging) */
    summary(): Record<string, {
        toolId: string;
        byteSize: number;
        timestamp: number;
    }>;
}
export declare class ResponseShield {
    private responseStore;
    constructor(responseStore: ResponseStore);
    /**
     * Shield a raw tool response before returning it to the model.
     *
     * Applies truncation rules and stores the full version if any truncation occurred.
     * This is called on every gateway.invoke result.
     *
     * @param toolId - Composite tool ID for storage
     * @param raw - The raw response from the upstream MCP server
     * @returns { shielded: truncated response, ref: "r3" if truncated, wasTruncated: bool }
     */
    shield(toolId: string, raw: unknown): ShieldResult;
    /**
     * Rule 1: Truncate arrays with >MAX_ARRAY_LENGTH items.
     *
     * Walks the response looking for the "content" array pattern
     * (MCP responses have content: [{type: "text", text: "..."}])
     * and also any nested arrays in parsed JSON text.
     */
    private truncateArrays;
    /**
     * Rule 2: Smart field stripping for array-of-objects.
     *
     * For arrays of objects, detect fields where the average serialized size
     * exceeds HEAVY_FIELD_THRESHOLD bytes. Strip those fields (except signal fields)
     * and add an _omitted list so the model knows what was removed.
     *
     * This is adapted from tldr's policy.go compactArray() logic.
     */
    private stripHeavyFields;
    /**
     * Rule 3: Truncate any string field exceeding MAX_STRING_LENGTH chars.
     * Walks the entire response recursively.
     */
    private truncateStrings;
    /**
     * Rule 4: Enforce MAX_RESPONSE_BYTES total size.
     *
     * If the response is still too large after rules 1-3, we iteratively
     * shrink: find arrays and remove items from the end, or truncate
     * the largest string fields further.
     */
    private enforceMaxSize;
}
