/**
 * types.ts — Shared interfaces for harshal-mcp-proxy.
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  Three layers of types:                                        │
 * │  1. Catalog types — the compressed tool index (schema deferral) │
 * │  2. Store types — response shielding + pagination refs          │
 * │  3. Connection/job types — lazy loading + async invocation      │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * Config types live next to their runtime schema in config.ts.
 * This module is a leaf: it must not import from any other module.
 */
export {};
//# sourceMappingURL=types.js.map