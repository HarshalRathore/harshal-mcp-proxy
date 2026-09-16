/**
 * util.ts — Tiny shared helpers used across modules.
 *
 * JSON guards, safe serialization, and error formatting. Everything here is
 * pure and dependency-free so any module can import it without cycles.
 */
/** True for plain objects (not null, not arrays). Narrows for indexing. */
export declare function isPlainObject(value: unknown): value is Record<string, unknown>;
/** JSON.stringify that never returns undefined ("" for undefined input). */
export declare function serialize(value: unknown): string;
/** JSON.parse that returns undefined instead of throwing. */
export declare function tryParseJson(text: string): unknown;
/** Best-effort message from an unknown thrown value. */
export declare function errorMessage(error: unknown): string;
