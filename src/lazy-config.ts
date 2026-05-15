/**
 * lazy-config.ts — Lazy loading configuration defaults and normalization.
 */

import type { LazyConfig } from "./types.js";

export const LAZY_DEFAULTS: Required<LazyConfig> = {
  enabled: false,
  idleTimeoutMs: 300000,
  maxRamMb: 0,
  maxUptimeMs: 0,
  connectionTimeoutMs: 30000,
  prewarm: false,
};

export function normalizeLazyConfig(lazy?: LazyConfig): Required<LazyConfig> {
  return { ...LAZY_DEFAULTS, ...lazy };
}
