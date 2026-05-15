/**
 * lazy-config.ts — Lazy loading configuration defaults and normalization.
 */
import type { LazyConfig } from "./types.js";
export declare const LAZY_DEFAULTS: Required<LazyConfig>;
export declare function normalizeLazyConfig(lazy?: LazyConfig): Required<LazyConfig>;
