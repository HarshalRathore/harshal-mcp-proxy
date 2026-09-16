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
import { isPlainObject, serialize, tryParseJson } from "./util.js";

// ──────────────────────────────────────────────
// Constants — tune these for your token budget
// ──────────────────────────────────────────────

/** Max items in an array before truncation */
const MAX_ARRAY_LENGTH = 50;

/** Max chars in any single string field before truncation */
const MAX_STRING_LENGTH = 8192;

/** Max total serialized size of shielded response (bytes) */
const MAX_RESPONSE_BYTES = 65_536; // 64KB

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

/** Tracks whether a shield pass changed anything. */
interface ShieldFlags {
  truncated: boolean;
}

// ──────────────────────────────────────────────
// ResponseStore — Ring buffer for full responses
// ──────────────────────────────────────────────

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

export type QueryResult = { ok: true; data: unknown; meta: SliceMeta } | { ok: false; error: string };

export class ResponseStore {
  /** Map of ref → full stored response */
  private entries = new Map<string, StoredResponse>();

  /** Insertion order for eviction */
  private order: string[] = [];

  /** Monotonic counter for generating ref handles */
  private counter = 0;

  /**
   * Store a full response and return its ref handle (e.g. "r1", "r2").
   *
   * @param toolId - Composite tool ID (e.g. "neo4j-cypher::run_cypher_query")
   * @param full - The complete untruncated response
   */
  store(toolId: string, full: unknown): string {
    this.counter++;
    const ref = `r${this.counter}`;

    this.entries.set(ref, {
      ref,
      toolId,
      timestamp: Date.now(),
      full,
      byteSize: Buffer.byteLength(serialize(full)),
    });
    this.order.push(ref);

    // Evict oldest entries if over capacity
    while (this.entries.size > MAX_STORED_RESPONSES) {
      const oldest = this.order.shift();
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }

    return ref;
  }

  /** Retrieve a stored response by ref */
  get(ref: string): StoredResponse | undefined {
    return this.entries.get(ref);
  }

  /**
   * Query a stored response with pagination, field projection, and text search.
   * This is the handler behind gateway.get_result.
   */
  query(ref: string, opts: QueryOptions = {}): QueryResult {
    const entry = this.entries.get(ref);
    if (!entry) return { ok: false, error: `Result ${ref} not found or expired` };

    const offset = opts.offset ?? 0;
    const limit = Math.min(opts.limit ?? 50, 50);

    const arr = extractArray(entry.full);
    return arr ? queryArray(arr, { ref, offset, limit, opts }) : queryText(entry.full, { ref, offset, limit, opts });
  }
}

/** Slice a stored array: filter → paginate → project fields. */
function queryArray(
  arr: unknown[],
  { ref, offset, limit, opts }: { ref: string; offset: number; limit: number; opts: QueryOptions }
): QueryResult {
  let items = arr;

  if (opts.search) {
    const needle = opts.search.toLowerCase();
    items = items.filter((item) => serialize(item).toLowerCase().includes(needle));
  }

  const total = items.length;
  const sliced = items.slice(offset, offset + limit);
  const projected = opts.fields?.length ? projectFields(sliced, opts.fields) : sliced;

  return {
    ok: true,
    data: projected,
    meta: { ref, total, offset, count: projected.length, hasMore: offset + limit < total },
  };
}

/** Project only the requested keys from each object in the slice. */
function projectFields(items: unknown[], fields: string[]): unknown[] {
  return items.map((item) => {
    if (!isPlainObject(item)) return item;
    return Object.fromEntries(fields.filter((field) => field in item).map((field) => [field, item[field]]));
  });
}

/** Paginate a non-array response: line search, or character-offset slices. */
function queryText(
  full: unknown,
  { ref, offset, limit, opts }: { ref: string; offset: number; limit: number; opts: QueryOptions }
): QueryResult {
  const text = typeof full === "string" ? full : JSON.stringify(full, null, 2) ?? "";

  if (opts.search) {
    const needle = opts.search.toLowerCase();
    const matches = text.split("\n").filter((line) => line.toLowerCase().includes(needle));
    return {
      ok: true,
      data: matches.slice(offset, offset + limit).join("\n"),
      meta: {
        ref,
        total: matches.length,
        offset,
        count: Math.max(0, Math.min(limit, matches.length - offset)),
        hasMore: offset + limit < matches.length,
      },
    };
  }

  // Plain string pagination by character offset (~200 chars per "item")
  const chunk = text.slice(offset, offset + limit * 200);
  return {
    ok: true,
    data: chunk,
    meta: {
      ref,
      total: text.length,
      offset,
      count: chunk.length,
      hasMore: offset + chunk.length < text.length,
    },
  };
}

// ──────────────────────────────────────────────
// ResponseShield — Truncation engine
// ──────────────────────────────────────────────

export class ResponseShield {
  constructor(private responseStore: ResponseStore) {}

  /**
   * Shield a raw tool response before returning it to the model.
   * Applies the truncation rules in order and stores the full version
   * if any truncation occurred. Called on every gateway.invoke result.
   *
   * @returns { shielded: truncated response, ref: "r3" if truncated, wasTruncated }
   */
  shield(toolId: string, raw: unknown): ShieldResult {
    const flags: ShieldFlags = { truncated: false };
    let shielded = this.truncateArrays(raw, flags);
    shielded = this.stripHeavyFields(shielded, flags);
    shielded = this.truncateStrings(shielded, flags);

    // Rule 4: total size cap (measured, not assumed)
    if (serializedSize(shielded) > MAX_RESPONSE_BYTES) {
      shielded = this.enforceMaxSize(shielded);
      flags.truncated = true;
    }

    const ref = flags.truncated ? this.responseStore.store(toolId, raw) : null;
    return { shielded, ref, wasTruncated: flags.truncated };
  }

  /**
   * Rule 1: Truncate arrays with >MAX_ARRAY_LENGTH items.
   * Walks the response looking for the "content" array pattern
   * (MCP responses have content: [{type: "text", text: "..."}])
   * and also any nested arrays in parsed JSON text.
   */
  private truncateArrays(data: unknown, flags: ShieldFlags): unknown {
    if (Array.isArray(data)) {
      if (data.length > MAX_ARRAY_LENGTH) {
        flags.truncated = true;
        const kept = data.slice(0, MAX_ARRAY_LENGTH);
        return [...kept, arrayMarker(data.length)];
      }
      return data.map((item) => this.truncateArrays(item, flags));
    }

    if (isPlainObject(data)) {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data)) {
        result[key] = this.truncateArrays(value, flags);
      }
      return result;
    }

    // Check if it's a JSON string containing an array
    if (typeof data === "string" && data.length > 1000) {
      const parsed = tryParseJson(data);
      if (Array.isArray(parsed) && parsed.length > MAX_ARRAY_LENGTH) {
        flags.truncated = true;
        const kept = parsed.slice(0, MAX_ARRAY_LENGTH);
        kept.push(arrayMarker(parsed.length));
        return JSON.stringify(kept);
      }
    }

    return data;
  }

  /**
   * Rule 2: Smart field stripping for array-of-objects.
   * Detect fields whose average serialized size exceeds HEAVY_FIELD_THRESHOLD
   * bytes, strip them (except signal fields), and add an _omitted list so the
   * model knows what was removed. Adapted from tldr's policy.go compactArray().
   */
  private stripHeavyFields(data: unknown, flags: ShieldFlags): unknown {
    if (!isPlainObject(data) && !Array.isArray(data)) return data;

    if (Array.isArray(data)) {
      if (data.length > 5) {
        const sample = data.slice(0, Math.min(data.length, 10));
        if (sample.every(isPlainObject)) {
          const heavyFields = findHeavyFields(sample);
          if (heavyFields.length > 0) {
            flags.truncated = true;
            return data.map((item) => {
              if (!isPlainObject(item)) return item;
              const kept = Object.fromEntries(
                Object.entries(item).filter(([key]) => !heavyFields.includes(key))
              );
              return { ...kept, _omitted: heavyFields };
            });
          }
        }
      }
      return data;
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = this.stripHeavyFields(value, flags);
    }
    return result;
  }

  /**
   * Rule 3: Truncate any string field exceeding MAX_STRING_LENGTH chars.
   * Walks the entire response recursively.
   */
  private truncateStrings(data: unknown, flags: ShieldFlags): unknown {
    if (typeof data === "string") {
      if (data.length > MAX_STRING_LENGTH) {
        flags.truncated = true;
        return data.slice(0, MAX_STRING_LENGTH) + `\n[...TRUNCATED: ${data.length - MAX_STRING_LENGTH} more chars]`;
      }
      return data;
    }

    if (Array.isArray(data)) {
      return data.map((item) => this.truncateStrings(item, flags));
    }

    if (isPlainObject(data)) {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data)) {
        result[key] = this.truncateStrings(value, flags);
      }
      return result;
    }

    return data;
  }

  /**
   * Rule 4: Enforce MAX_RESPONSE_BYTES total size.
   * Iteratively shrink the largest structures (content text, top-level
   * arrays) and guarantee the cap with a hard text cut as a last resort.
   *
   * Safe to mutate in place: every container reaches this point freshly
   * built by rules 1-3, so nothing shared with the stored original changes.
   */
  private enforceMaxSize(data: unknown): unknown {
    let current = data;

    for (let iteration = 0; iteration < 20 && serializedSize(current) > MAX_RESPONSE_BYTES; iteration++) {
      if (typeof current === "string") {
        current = current.slice(0, MAX_RESPONSE_BYTES - 100) + `\n[...TRUNCATED to fit 64KB limit]`;
        continue;
      }

      if (isPlainObject(current)) {
        shrinkContentText(current);
        shrinkLargeArrays(current);
      }
    }

    // Guarantee: heuristics can stall (deeply nested objects, no arrays).
    const serialized = serialize(current);
    if (Buffer.byteLength(serialized) > MAX_RESPONSE_BYTES) {
      return serialized.slice(0, MAX_RESPONSE_BYTES) + `\n[...TRUNCATED to fit 64KB limit]`;
    }
    return current;
  }
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function serializedSize(value: unknown): number {
  return Buffer.byteLength(serialize(value));
}

/** Marker item appended to truncated arrays. */
function arrayMarker(total: number): Record<string, unknown> {
  return {
    _truncated: true,
    _total: total,
    _showing: MAX_ARRAY_LENGTH,
    _message: `[TRUNCATED: ${total - MAX_ARRAY_LENGTH} more items. Use gateway.get_result to paginate]`,
  };
}

/** Fields whose average serialized size exceeds the heavy threshold. */
function findHeavyFields(sample: Record<string, unknown>[]): string[] {
  const totalSize = new Map<string, number>();
  const counts = new Map<string, number>();

  for (const item of sample) {
    for (const [key, value] of Object.entries(item)) {
      totalSize.set(key, (totalSize.get(key) ?? 0) + serializedSize(value));
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const heavy: string[] = [];
  for (const [field, size] of totalSize) {
    const average = size / (counts.get(field) ?? 1);
    if (average > HEAVY_FIELD_THRESHOLD && !SIGNAL_FIELDS.has(field)) heavy.push(field);
  }
  return heavy;
}

/** Halve oversized MCP content[].text entries in place. */
function shrinkContentText(obj: Record<string, unknown>): void {
  const content = obj["content"];
  if (!Array.isArray(content)) return;
  for (const item of content) {
    if (isPlainObject(item) && typeof item["text"] === "string" && item["text"].length > 2000) {
      item["text"] = item["text"].slice(0, Math.floor(item["text"].length / 2)) + `\n[...TRUNCATED to fit 64KB limit]`;
    }
  }
}

/** Drop the tail of large top-level arrays in place. */
function shrinkLargeArrays(obj: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value) && value.length > 10) {
      const halfLength = Math.floor(value.length * 0.75);
      obj[key] = [
        ...value.slice(0, halfLength),
        {
          _truncated: true,
          _dropped: value.length - halfLength,
          _message: "[Dropped items to fit 64KB response limit. Use gateway.get_result to paginate]",
        },
      ];
    }
  }
}

/**
 * Try to extract an array from various response shapes.
 * MCP responses come in different forms:
 *   - Direct array: [...]
 *   - Content wrapper: { content: [{ type: "text", text: "[...]" }] }
 *   - Named array fields: { items: [...] }, { results: [...] }, etc.
 *
 * The content wrapper is checked first — its text usually holds the
 * actual data array, which is what pagination should slice.
 */
function extractArray(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (!isPlainObject(data)) return null;

  // MCP content array whose text contains a JSON array
  const content = data["content"];
  if (Array.isArray(content)) {
    const fromText = arrayFromTextContent(content);
    if (fromText) return fromText;
  }

  // Common wrapper keys
  for (const key of ["content", "items", "data", "results", "entries", "tools"]) {
    const value = data[key];
    if (Array.isArray(value)) return value;
  }

  return null;
}

/** Parse `[{type: "text", text: "<json>"}]` wrappers into the array they hold. */
function arrayFromTextContent(content: unknown[]): unknown[] | null {
  for (const item of content) {
    if (!isPlainObject(item) || item["type"] !== "text" || typeof item["text"] !== "string") continue;

    const parsed = tryParseJson(item["text"]);
    if (Array.isArray(parsed)) return parsed;
    if (isPlainObject(parsed)) {
      for (const key of ["items", "data", "results"]) {
        const value = parsed[key];
        if (Array.isArray(value)) return value;
      }
    }
  }
  return null;
}
