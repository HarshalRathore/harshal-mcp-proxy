#!/usr/bin/env node
/**
 * index.ts — Entry point for harshal-mcp-proxy.
 *
 * Usage:
 *   node dist/index.js [path-to-config.json]
 *
 * If no config path is provided, reads from:
 *   1. MCP_GATEWAY_CONFIG env var
 *   2. ~/.config/harshal-mcp-proxy/config.json
 *
 * In opencode.json, configure as:
 *   {
 *     "mcp": {
 *       "harshal-mcp-proxy": {
 *         "type": "local",
 *         "command": ["node", "/home/harshal/harshal/harshal-mcp-proxy/dist/index.js"]
 *       }
 *     }
 *   }
 */
export {};
