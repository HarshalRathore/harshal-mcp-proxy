/**
 * lazy-config.ts — Lazy loading configuration defaults and normalization.
 */
import type { LazyConfig } from "./config.js";
/** Fill in lazy-loading defaults for every field a server did not set. */
export declare function normalizeLazyConfig(lazy?: LazyConfig): Required<LazyConfig>;
