/**
 * lazy-config.ts — Lazy loading configuration defaults and normalization.
 */
export const LAZY_DEFAULTS = {
    enabled: false,
    idleTimeoutMs: 300000,
    maxRamMb: 0,
    maxUptimeMs: 0,
    connectionTimeoutMs: 30000,
    prewarm: false,
};
export function normalizeLazyConfig(lazy) {
    return { ...LAZY_DEFAULTS, ...lazy };
}
//# sourceMappingURL=lazy-config.js.map