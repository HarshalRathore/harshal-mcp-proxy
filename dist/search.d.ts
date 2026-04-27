/**
 * search.ts — BM25 search engine over the tool catalog.
 *
 * Uses MiniSearch with:
 *   - Fields: name, title, description, server
 *   - Boost: name ×3, title ×2 (tool names are the strongest signal)
 *   - Fuzzy: 0.2, prefix: true (forgives typos like "playwrght")
 *   - Lazy index rebuild: dirty flag set on add/remove, rebuilt on next search()
 *
 * This is the core of schema deferral — the model searches by keyword
 * and only gets back IDs + descriptions, never full JSON Schemas.
 */
import type { ToolCatalogEntry, SearchFilters, SearchResult } from "./types.js";
export declare class SearchEngine {
    /** Full tool catalog keyed by composite ID */
    private catalog;
    /** MiniSearch instance — rebuilt lazily when dirty */
    private miniSearch;
    /** Dirty flag: set true when catalog changes, triggers rebuild on next search */
    private indexDirty;
    /** Cache for describe results — eliminates repeated schema lookups */
    private describeCache;
    constructor();
    /** Register a tool into the catalog. Marks index dirty. */
    addTool(tool: ToolCatalogEntry): void;
    /** Remove a tool from the catalog. Marks index dirty. */
    removeTool(id: string): void;
    /** Get all catalog entries (used for counting, filtering by server, etc.) */
    getTools(): ToolCatalogEntry[];
    /** Get a single catalog entry by composite ID */
    getTool(id: string): ToolCatalogEntry | undefined;
    /** Get a catalog entry with caching — use for describe to avoid repeated lookups */
    getSchema(id: string): ToolCatalogEntry | undefined;
    /**
     * Search the catalog using BM25 scoring.
     *
     * @param query - Natural language search query
     * @param filters - Optional: restrict to a specific server
     * @param limit - Max results to return (capped at 50)
     * @returns Sorted search results with scores
     */
    search(query: string, filters?: SearchFilters, limit?: number): SearchResult[];
    /** Force an index rebuild now (call after all connections are established) */
    warmup(): void;
    /**
     * Rebuild the MiniSearch index if dirty.
     * This is cheap for <500 tools — typically <10ms.
     */
    private ensureIndex;
}
