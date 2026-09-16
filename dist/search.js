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
import { isPlainObject } from "./util.js";
/** "run_cypher" → "runCypher" */
function toCamelCase(str) {
    return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}
/** Top-level parameter names from a JSON Schema (best effort). */
function extractFieldNames(schema) {
    if (!isPlainObject(schema))
        return [];
    const properties = schema["properties"];
    if (!isPlainObject(properties))
        return [];
    return Object.keys(properties);
}
export class SearchEngine {
    /** Full tool catalog keyed by composite ID. fieldNames is precomputed. */
    catalog = new Map();
    /** MiniSearch instance — rebuilt lazily when dirty */
    miniSearch = null;
    /** Dirty flag: set true when catalog changes, triggers rebuild on next search */
    indexDirty = true;
    /** Register a tool into the catalog. Marks index dirty. */
    addTool(tool) {
        this.catalog.set(tool.id, { ...tool, fieldNames: extractFieldNames(tool.inputSchema) });
        this.indexDirty = true;
    }
    /** Remove all tools belonging to a specific server (used when server removed from config) */
    removeServerTools(serverKey) {
        let removed = false;
        for (const [id, tool] of this.catalog) {
            if (tool.server === serverKey) {
                this.catalog.delete(id);
                removed = true;
            }
        }
        if (removed)
            this.indexDirty = true;
    }
    /** Get all catalog entries */
    getTools() {
        return Array.from(this.catalog.values());
    }
    /** Get a single catalog entry by composite ID */
    getTool(id) {
        return this.catalog.get(id);
    }
    /** Count tools registered for one server */
    getToolCount(serverKey) {
        let count = 0;
        for (const tool of this.catalog.values()) {
            if (tool.server === serverKey)
                count++;
        }
        return count;
    }
    /**
     * Search the catalog using BM25 scoring.
     *
     * @param query - Natural language search query. Empty = list everything.
     * @param filters - Optional: restrict to a specific server
     * @param limit - Max results to return (capped at 50)
     */
    search(query, filters = {}, limit = 10) {
        const maxLimit = Math.min(limit, 50);
        const trimmed = query.trim();
        this.ensureIndex();
        // No query — return the catalog (useful for "list everything")
        if (!trimmed) {
            return this.getTools()
                .filter((t) => !filters.server || t.server === filters.server)
                .slice(0, maxLimit)
                .map((t) => this.toResult(t, 0));
        }
        if (!this.miniSearch)
            return [];
        // Filter inside MiniSearch so a server filter isn't applied to a top-N slice
        return this.miniSearch
            .search(trimmed.toLowerCase(), {
            filter: (result) => !filters.server || result["server"] === filters.server,
        })
            .slice(0, maxLimit)
            .map((result) => {
            const entry = this.catalog.get(result.id);
            if (entry)
                return this.toResult(entry, result.score);
            // Index/catalog out of sync (shouldn't happen) — surface what we have
            const name = String(result["name"] ?? "");
            return {
                id: result.id,
                server: String(result["server"] ?? ""),
                name,
                displayName: toCamelCase(name),
                description: typeof result["description"] === "string" ? result["description"] : undefined,
                fieldNames: [],
                score: result.score,
            };
        });
    }
    /** Force an index rebuild now (call after all connections are established) */
    warmup() {
        this.ensureIndex();
    }
    toResult(entry, score) {
        return {
            id: entry.id,
            server: entry.server,
            name: entry.name,
            displayName: toCamelCase(entry.name),
            description: entry.description,
            fieldNames: entry.fieldNames ?? extractFieldNames(entry.inputSchema),
            score,
        };
    }
    /**
     * Rebuild the MiniSearch index if dirty.
     * This is cheap for <500 tools — typically <10ms.
     */
    ensureIndex() {
        if (!this.indexDirty && this.miniSearch)
            return;
        this.indexDirty = false;
        const tools = Array.from(this.catalog.values());
        if (tools.length === 0) {
            this.miniSearch = null;
            return;
        }
        this.miniSearch = new MiniSearch({
            // Fields used for full-text search scoring
            fields: ["name", "title", "description", "server"],
            // Fields stored in the index (returned with results, avoids catalog lookup)
            storeFields: ["id", "server", "name", "title", "description"],
            searchOptions: {
                boost: { name: 3, title: 2 }, // Tool name is strongest signal
                fuzzy: 0.2, // Forgive typos
                prefix: true, // Allow prefix matching
                combineWith: "OR", // Any term can match
            },
        });
        this.miniSearch.addAll(tools);
    }
}
//# sourceMappingURL=search.js.map