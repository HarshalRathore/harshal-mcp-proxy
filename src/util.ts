/**
 * util.ts — Tiny shared helpers used across modules.
 *
 * JSON guards, safe serialization, and error formatting. Everything here is
 * pure and dependency-free so any module can import it without cycles.
 */

/** True for plain objects (not null, not arrays). Narrows for indexing. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON.stringify that never returns undefined ("" for undefined input). */
export function serialize(value: unknown): string {
  return JSON.stringify(value) ?? "";
}

/** JSON.parse that returns undefined instead of throwing. */
export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Best-effort message from an unknown thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
