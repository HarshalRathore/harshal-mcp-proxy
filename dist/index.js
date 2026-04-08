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
import { MCPGateway } from "./gateway.js";
const configPath = process.argv[2]; // Optional CLI arg for config path
const gateway = new MCPGateway(configPath);
// Handle graceful shutdown on SIGINT (Ctrl+C) and SIGTERM
process.on("SIGINT", () => {
    gateway.shutdown().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
    gateway.shutdown().then(() => process.exit(0));
});
// Handle uncaught errors gracefully
process.on("uncaughtException", (err) => {
    console.error(`  [proxy] Uncaught exception: ${err.message}`);
    // Don't exit — try to keep serving
});
process.on("unhandledRejection", (reason) => {
    console.error(`  [proxy] Unhandled rejection: ${reason}`);
    // Don't exit — try to keep serving
});
// Start the gateway
gateway.startWithStdio().catch((err) => {
    console.error(`  [proxy] Fatal error: ${err.message}`);
    process.exit(1);
});
//# sourceMappingURL=index.js.map