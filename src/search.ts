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

import MiniSearch from "minisearch";
import type { ToolCatalogEntry, SearchFilters, SearchResult } from "./types.js";

export class SearchEngine {
  /** Full tool catalog keyed by composite ID */
  private catalog: Map<string, ToolCatalogEntry> = new Map();

  /** MiniSearch instance — rebuilt lazily when dirty */
  private miniSearch: MiniSearch<ToolCatalogEntry> | null = null;

  /** Dirty flag: set true when catalog changes, triggers rebuild on next search */
  private indexDirty = true;

  constructor() {}

  /** Register a tool into the catalog. Marks index dirty. */
  addTool(tool: ToolCatalogEntry): void {
    this.catalog.set(tool.id, tool);
    this.indexDirty = true;
  }

  /** Remove a tool from the catalog. Marks index dirty. */
  removeTool(id: string): void {
    this.catalog.delete(id);
    this.indexDirty = true;
  }

  /** Get all catalog entries (used for counting, filtering by server, etc.) */
  getTools(): ToolCatalogEntry[] {
    return Array.from(this.catalog.values());
  }

  /** Get a single catalog entry by composite ID */
  getTool(id: string): ToolCatalogEntry | undefined {
    return this.catalog.get(id);
  }

  /**
   * Search the catalog using BM25 scoring.
   *
   * @param query - Natural language search query
   * @param filters - Optional: restrict to a specific server
   * @param limit - Max results to return (capped at 50)
   * @returns Sorted search results with scores
   */
  search(query: string, filters: SearchFilters = {}, limit = 10): SearchResult[] {
    this.ensureIndex();

    if (!this.miniSearch || !query.trim()) {
      // No index or empty query — return all tools (useful for "list everything")
      if (!query.trim()) {
        return this.getTools()
          .filter((t) => !filters.server || t.server === filters.server)
          .slice(0, Math.min(limit, 50))
          .map((t) => ({
            id: t.id,
            server: t.server,
            name: t.name,
            description: t.description,
            score: 0,
          }));
      }
      return [];
    }

    const maxLimit = Math.min(limit, 50);

    // Run BM25 search — get up to 100 raw results then filter
    const results = this.miniSearch.search(query.toLowerCase()).slice(0, 100);

    return results
      .filter((result) => {
        if (filters.server && result.server !== filters.server) return false;
        return true;
      })
      .map((result) => ({
        id: result.id as string,
        server: result.server as string,
        name: result.name as string,
        description: result.description as string | undefined,
        score: result.score || 0,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, maxLimit);
  }

  /** Force an index rebuild now (call after all connections are established) */
  warmup(): void {
    this.ensureIndex();
  }

  /**
   * Rebuild the MiniSearch index if dirty.
   * This is cheap for <500 tools — typically <10ms.
   */
  private ensureIndex(): void {
    if (!this.indexDirty && this.miniSearch) return;

    const tools = Array.from(this.catalog.values());

    if (tools.length === 0) {
      this.miniSearch = null;
      this.indexDirty = false;
      return;
    }

    this.miniSearch = new MiniSearch<ToolCatalogEntry>({
      // Fields used for full-text search scoring
      fields: ["name", "title", "description", "server"],

      // Fields stored in the index (returned with results, avoids catalog lookup)
      storeFields: ["id", "server", "name", "title", "description"],
      // NOTE: inputSchema is intentionally NOT stored here — that's the whole point
      // of schema deferral. It only comes back via gateway.describe.

      searchOptions: {
        boost: { name: 3, title: 2 },  // Tool name is strongest signal
        fuzzy: 0.2,                      // Forgive typos
        prefix: true,                    // Allow prefix matching
        combineWith: "OR",               // Any term can match
      },
    });

    this.miniSearch.addAll(tools);
    this.indexDirty = false;
  }
}
