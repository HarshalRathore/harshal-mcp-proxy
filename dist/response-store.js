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
// ──────────────────────────────────────────────
// Constants — tune these for your token budget
// ──────────────────────────────────────────────
/** Max items in an array before truncation */
const MAX_ARRAY_LENGTH = 50;
/** Max chars in any single string field before truncation */
const MAX_STRING_LENGTH = 8192;
/** Max total serialized size of shielded response (bytes) */
const MAX_RESPONSE_BYTES = 65536; // 64KB
/** Max stored responses in the ring buffer */
const MAX_STORED_RESPONSES = 100;
/** Average byte threshold for detecting "heavy" fields in array objects */
const HEAVY_FIELD_THRESHOLD = 256;
/** Fields that are never stripped from array objects (signal fields) */
const SIGNAL_FIELDS = new Set([
    "id", "name", "title", "type", "status", "state", "label",
    "sha", "ref", "path", "url", "html_url",
    "created_at", "updated_at", "number", "key",
    "message", "description", "summary", "error",
]);
// ──────────────────────────────────────────────
// ResponseStore — Ring buffer for full responses
// ──────────────────────────────────────────────
export class ResponseStore {
    /** Map of ref → full stored response */
    entries = new Map();
    /** Insertion order for LRU eviction */
    order = [];
    /** Monotonic counter for generating ref handles */
    counter = 0;
    /**
     * Store a full response and return its ref handle.
     *
     * @param toolId - Composite tool ID (e.g. "neo4j-cypher::run_cypher_query")
     * @param full - The complete untruncated response
     * @returns Ref handle like "r1", "r2", etc.
     */
    store(toolId, full) {
        this.counter++;
        const ref = `r${this.counter}`;
        const entry = {
            ref,
            toolId,
            timestamp: Date.now(),
            full,
            truncated: true,
            byteSize: JSON.stringify(full).length,
        };
        this.entries.set(ref, entry);
        this.order.push(ref);
        // Evict oldest entries if over capacity
        while (this.entries.size > MAX_STORED_RESPONSES) {
            const oldest = this.order.shift();
            if (oldest)
                this.entries.delete(oldest);
        }
        return ref;
    }
    /** Retrieve a stored response by ref */
    get(ref) {
        return this.entries.get(ref);
    }
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
    query(ref, opts = {}) {
        const entry = this.entries.get(ref);
        if (!entry)
            return { error: `Result ${ref} not found or expired` };
        const offset = opts.offset ?? 0;
        const limit = Math.min(opts.limit ?? 50, 50);
        // Try to extract an array from the response
        const arr = extractArray(entry.full);
        if (arr) {
            let items = arr;
            // Apply text search filter if provided
            if (opts.search) {
                const needle = opts.search.toLowerCase();
                items = items.filter((item) => JSON.stringify(item).toLowerCase().includes(needle));
            }
            const total = items.length;
            const sliced = items.slice(offset, offset + limit);
            // Apply field projection if specified
            let projected = sliced;
            if (opts.fields && opts.fields.length > 0) {
                projected = sliced.map((item) => {
                    if (typeof item === "object" && item !== null && !Array.isArray(item)) {
                        const obj = {};
                        for (const field of opts.fields) {
                            if (field in item) {
                                obj[field] = item[field];
                            }
                        }
                        return obj;
                    }
                    return item;
                });
            }
            return {
                data: projected,
                meta: {
                    ref,
                    total,
                    offset,
                    count: projected.length,
                    hasMore: offset + limit < total,
                },
            };
        }
        // Not an array — try string slicing
        const fullStr = typeof entry.full === "string"
            ? entry.full
            : JSON.stringify(entry.full, null, 2);
        if (opts.search) {
            // Search within string — return matching lines
            const lines = fullStr.split("\n");
            const needle = opts.search.toLowerCase();
            const matches = lines.filter((line) => line.toLowerCase().includes(needle));
            return {
                data: matches.slice(offset, offset + limit).join("\n"),
                meta: {
                    ref,
                    total: matches.length,
                    offset,
                    count: Math.min(limit, matches.length - offset),
                    hasMore: offset + limit < matches.length,
                },
            };
        }
        // Plain string pagination by character offset
        const chunk = fullStr.slice(offset, offset + limit * 200); // ~200 chars per "item"
        return {
            data: chunk,
            meta: {
                ref,
                total: fullStr.length,
                offset,
                count: chunk.length,
                hasMore: offset + chunk.length < fullStr.length,
            },
        };
    }
    /** Get summary of all stored results (for debugging) */
    summary() {
        const result = {};
        for (const [ref, entry] of this.entries) {
            result[ref] = {
                toolId: entry.toolId,
                byteSize: entry.byteSize,
                timestamp: entry.timestamp,
            };
        }
        return result;
    }
}
// ──────────────────────────────────────────────
// ResponseShield — Truncation engine
// ──────────────────────────────────────────────
export class ResponseShield {
    responseStore;
    constructor(responseStore) {
        this.responseStore = responseStore;
    }
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
    shield(toolId, raw) {
        let shielded = deepClone(raw);
        let wasTruncated = false;
        // ── Rule 1: Array truncation ──
        // If the response contains an array >50 items, cap it
        shielded = this.truncateArrays(shielded, (didTruncate) => {
            if (didTruncate)
                wasTruncated = true;
        });
        // ── Rule 2: Smart field stripping for array-of-objects ──
        // Detect "heavy" fields and strip them, keeping signal fields
        shielded = this.stripHeavyFields(shielded, (didStrip) => {
            if (didStrip)
                wasTruncated = true;
        });
        // ── Rule 3: String truncation ──
        // Walk all string fields recursively, truncate any >8192 chars
        shielded = this.truncateStrings(shielded, (didTruncate) => {
            if (didTruncate)
                wasTruncated = true;
        });
        // ── Rule 4: Total size cap ──
        // If the whole thing is still >64KB, iteratively trim
        const serialized = JSON.stringify(shielded);
        if (serialized.length > MAX_RESPONSE_BYTES) {
            shielded = this.enforceMaxSize(shielded);
            wasTruncated = true;
        }
        // Store full response if any truncation happened
        let ref = null;
        if (wasTruncated) {
            ref = this.responseStore.store(toolId, raw);
        }
        return { shielded, ref, wasTruncated };
    }
    /**
     * Rule 1: Truncate arrays with >MAX_ARRAY_LENGTH items.
     *
     * Walks the response looking for the "content" array pattern
     * (MCP responses have content: [{type: "text", text: "..."}])
     * and also any nested arrays in parsed JSON text.
     */
    truncateArrays(data, onTruncate) {
        if (Array.isArray(data)) {
            if (data.length > MAX_ARRAY_LENGTH) {
                onTruncate(true);
                const kept = data.slice(0, MAX_ARRAY_LENGTH);
                return [
                    ...kept,
                    {
                        _truncated: true,
                        _total: data.length,
                        _showing: MAX_ARRAY_LENGTH,
                        _message: `[TRUNCATED: ${data.length - MAX_ARRAY_LENGTH} more items. Use gateway.get_result to paginate]`,
                    },
                ];
            }
            return data.map((item) => this.truncateArrays(item, onTruncate));
        }
        if (data && typeof data === "object" && !Array.isArray(data)) {
            const obj = data;
            const result = {};
            for (const [key, value] of Object.entries(obj)) {
                result[key] = this.truncateArrays(value, onTruncate);
            }
            return result;
        }
        // Check if it's a JSON string containing an array
        if (typeof data === "string" && data.length > 1000) {
            try {
                const parsed = JSON.parse(data);
                if (Array.isArray(parsed) && parsed.length > MAX_ARRAY_LENGTH) {
                    onTruncate(true);
                    const kept = parsed.slice(0, MAX_ARRAY_LENGTH);
                    kept.push({
                        _truncated: true,
                        _total: parsed.length,
                        _showing: MAX_ARRAY_LENGTH,
                        _message: `[TRUNCATED: ${parsed.length - MAX_ARRAY_LENGTH} more items. Use gateway.get_result to paginate]`,
                    });
                    return JSON.stringify(kept);
                }
            }
            catch {
                // Not JSON — leave as-is
            }
        }
        return data;
    }
    /**
     * Rule 2: Smart field stripping for array-of-objects.
     *
     * For arrays of objects, detect fields where the average serialized size
     * exceeds HEAVY_FIELD_THRESHOLD bytes. Strip those fields (except signal fields)
     * and add an _omitted list so the model knows what was removed.
     *
     * This is adapted from tldr's policy.go compactArray() logic.
     */
    stripHeavyFields(data, onStrip) {
        if (!data || typeof data !== "object")
            return data;
        if (Array.isArray(data) && data.length > 5) {
            // Check if this is an array of objects
            const sampleSize = Math.min(data.length, 10);
            const sample = data.slice(0, sampleSize);
            if (sample.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
                // Calculate average field sizes across the sample
                const fieldSizes = new Map();
                const fieldCounts = new Map();
                for (const item of sample) {
                    const obj = item;
                    for (const [key, value] of Object.entries(obj)) {
                        const size = JSON.stringify(value).length;
                        fieldSizes.set(key, (fieldSizes.get(key) || 0) + size);
                        fieldCounts.set(key, (fieldCounts.get(key) || 0) + 1);
                    }
                }
                // Find heavy fields to strip
                const heavyFields = [];
                for (const [field, totalSize] of fieldSizes) {
                    const count = fieldCounts.get(field) || 1;
                    const avg = totalSize / count;
                    if (avg > HEAVY_FIELD_THRESHOLD && !SIGNAL_FIELDS.has(field)) {
                        heavyFields.push(field);
                    }
                }
                if (heavyFields.length > 0) {
                    onStrip(true);
                    return data.map((item) => {
                        if (item && typeof item === "object" && !Array.isArray(item)) {
                            const obj = item;
                            const stripped = {};
                            for (const [key, value] of Object.entries(obj)) {
                                if (!heavyFields.includes(key)) {
                                    stripped[key] = value;
                                }
                            }
                            stripped._omitted = heavyFields;
                            return stripped;
                        }
                        return item;
                    });
                }
            }
        }
        // Recurse into object fields
        if (!Array.isArray(data)) {
            const obj = data;
            const result = {};
            for (const [key, value] of Object.entries(obj)) {
                result[key] = this.stripHeavyFields(value, onStrip);
            }
            return result;
        }
        return data;
    }
    /**
     * Rule 3: Truncate any string field exceeding MAX_STRING_LENGTH chars.
     * Walks the entire response recursively.
     */
    truncateStrings(data, onTruncate) {
        if (typeof data === "string") {
            if (data.length > MAX_STRING_LENGTH) {
                onTruncate(true);
                return data.slice(0, MAX_STRING_LENGTH) + `\n[...TRUNCATED: ${data.length - MAX_STRING_LENGTH} more chars]`;
            }
            return data;
        }
        if (Array.isArray(data)) {
            return data.map((item) => this.truncateStrings(item, onTruncate));
        }
        if (data && typeof data === "object") {
            const obj = data;
            const result = {};
            for (const [key, value] of Object.entries(obj)) {
                result[key] = this.truncateStrings(value, onTruncate);
            }
            return result;
        }
        return data;
    }
    /**
     * Rule 4: Enforce MAX_RESPONSE_BYTES total size.
     *
     * If the response is still too large after rules 1-3, we iteratively
     * shrink: find arrays and remove items from the end, or truncate
     * the largest string fields further.
     */
    enforceMaxSize(data) {
        let current = deepClone(data);
        let iterations = 0;
        const maxIterations = 20; // Safety valve
        while (JSON.stringify(current).length > MAX_RESPONSE_BYTES && iterations < maxIterations) {
            iterations++;
            // Strategy: find the largest content and shrink it
            if (typeof current === "object" && current !== null) {
                const obj = current;
                // Look for the MCP content array pattern
                if (Array.isArray(obj.content)) {
                    for (let i = 0; i < obj.content.length; i++) {
                        const item = obj.content[i];
                        if (item && typeof item.text === "string" && item.text.length > 2000) {
                            // Halve the text
                            const text = item.text;
                            item.text = text.slice(0, Math.floor(text.length / 2)) +
                                `\n[...TRUNCATED to fit 64KB limit]`;
                        }
                    }
                }
                // Also try to shrink any top-level arrays
                for (const [key, value] of Object.entries(obj)) {
                    if (Array.isArray(value) && value.length > 10) {
                        const halfLen = Math.floor(value.length * 0.75);
                        obj[key] = [
                            ...value.slice(0, halfLen),
                            {
                                _truncated: true,
                                _dropped: value.length - halfLen,
                                _message: "[Dropped items to fit 64KB response limit. Use gateway.get_result to paginate]",
                            },
                        ];
                    }
                }
            }
            // If it's just a huge string at top level
            if (typeof current === "string" && current.length > MAX_RESPONSE_BYTES) {
                current = current.slice(0, MAX_RESPONSE_BYTES - 100) +
                    `\n[...TRUNCATED to fit 64KB limit]`;
            }
        }
        return current;
    }
}
// ──────────────────────────────────────────────
// Helper functions
// ──────────────────────────────────────────────
/** Deep clone via JSON round-trip (sufficient for JSON-serializable MCP responses) */
function deepClone(data) {
    return JSON.parse(JSON.stringify(data));
}
/**
 * Try to extract an array from various response shapes.
 * MCP responses come in different forms:
 *   - Direct array: [...]
 *   - Content wrapper: { content: [{ type: "text", text: "[...]" }] }
 *   - Nested arrays in text fields
 */
function extractArray(data) {
    // Direct array
    if (Array.isArray(data))
        return data;
    if (data && typeof data === "object") {
        const obj = data;
        // Check common wrapper patterns
        for (const key of ["content", "items", "data", "results", "entries", "tools"]) {
            if (Array.isArray(obj[key]))
                return obj[key];
        }
        // MCP content array with text containing JSON array
        if (Array.isArray(obj.content)) {
            for (const item of obj.content) {
                if (item.type === "text" && typeof item.text === "string") {
                    try {
                        const parsed = JSON.parse(item.text);
                        if (Array.isArray(parsed))
                            return parsed;
                        // Also check nested arrays in parsed objects
                        if (parsed && typeof parsed === "object") {
                            for (const key of ["content", "items", "data", "results"]) {
                                if (Array.isArray(parsed[key]))
                                    return parsed[key];
                            }
                        }
                    }
                    catch {
                        // Not JSON text — skip
                    }
                }
            }
        }
    }
    return null;
}
//# sourceMappingURL=response-store.js.map