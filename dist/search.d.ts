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
    /** Full tool catalog keyed by composite ID. fieldNames is precomputed. */
    private catalog;
    /** MiniSearch instance — rebuilt lazily when dirty */
    private miniSearch;
    /** Dirty flag: set true when catalog changes, triggers rebuild on next search */
    private indexDirty;
    /** Register a tool into the catalog. Marks index dirty. */
    addTool(tool: ToolCatalogEntry): void;
    /** Remove all tools belonging to a specific server (used when server removed from config) */
    removeServerTools(serverKey: string): void;
    /** Get all catalog entries */
    getTools(): ToolCatalogEntry[];
    /** Get a single catalog entry by composite ID */
    getTool(id: string): ToolCatalogEntry | undefined;
    /** Count tools registered for one server */
    getToolCount(serverKey: string): number;
    /**
     * Search the catalog using BM25 scoring.
     *
     * @param query - Natural language search query. Empty = list everything.
     * @param filters - Optional: restrict to a specific server
     * @param limit - Max results to return (capped at 50)
     */
    search(query: string, filters?: SearchFilters, limit?: number): SearchResult[];
    /** Force an index rebuild now (call after all connections are established) */
    warmup(): void;
    private toResult;
    /**
     * Rebuild the MiniSearch index if dirty.
     * This is cheap for <500 tools — typically <10ms.
     */
    private ensureIndex;
}
