/**
 * lazy-config.ts — Lazy loading configuration defaults and normalization.
 */

import type { LazyConfig } from "./config.js";

const LAZY_DEFAULTS: Required<LazyConfig> = {
  enabled: false,
  idleTimeoutMs: 300_000,
  maxRamMb: 0,
  maxUptimeMs: 0,
  connectionTimeoutMs: 30_000,
  prewarm: false,
};

/** Fill in lazy-loading defaults for every field a server did not set. */
export function normalizeLazyConfig(lazy?: LazyConfig): Required<LazyConfig> {
  return { ...LAZY_DEFAULTS, ...lazy };
}
