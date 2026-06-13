#!/usr/bin/env node

/**
 * index.ts — Entry point for harshal-mcp-proxy.
 *
 * Usage:
 *   node dist/index.js [path-to-config.json]          (stdio mode, default)
 *   node dist/index.js --port 8765 [path-to-config.json]  (HTTP daemon mode)
 *   node dist/index.js --daemon [path-to-config.json]     (alias for --port 8765)
 *
 * If no config path is provided, reads from:
 *   1. MCP_GATEWAY_CONFIG env var
 *   2. ~/.config/harshal-mcp-proxy/config.json
 *
 * Stdio mode (for backwards compatibility):
 *   The gateway speaks MCP over stdin/stdout.
 *   Use this from pi's mcp config as "type": "local", "command": [...]
 *
 * HTTP daemon mode (recommended for shared use):
 *   The gateway binds to an HTTP port and speaks MCP's Streamable HTTP
 *   transport (JSON-RPC 2.0). Multiple clients can connect via:
 *     - pi:     url in .vscode/mcp.json or pi-mcp-adapter config
 *     - VS Code: "type": "streamableHttp", "url": "http://localhost:PORT/mcp"
 *   Only ONE process spawns all upstream MCP servers, eliminating duplicate
 *   npm exec processes across sessions.
 */

import { MCPGateway } from "./gateway.js";
import { HttpMcpServer } from "./http-server.js";
function printUsage(): void {
  console.log(`harshal-mcp-proxy — MCP gateway with schema deferral + response shielding

Usage:
  node dist/index.js [path-to-config.json]                 (stdio mode, default)
  node dist/index.js --port 8765 [path-to-config.json]     (HTTP daemon mode)
  node dist/index.js --daemon [path-to-config.json]        (alias for --port 8765)
  node dist/index.js --discover                            (build catalog snapshots)
  node dist/index.js --help | -h                           (show this help)

If no config path is provided, reads from:
  1. MCP_GATEWAY_CONFIG env var
  2. ~/.config/harshal-mcp-proxy/config.json`);
}

// Parse CLI arguments
let configPath: string | undefined;
let port: number | undefined;
let discoverMode = false;
let showHelp = false;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port" && i + 1 < args.length) {
    port = parseInt(args[++i], 10);
  } else if (args[i] === "--daemon") {
    port = 8765;
  } else if (args[i] === "--discover") {
    discoverMode = true;
  } else if (args[i] === "--help" || args[i] === "-h") {
    showHelp = true;
  } else if (!args[i].startsWith("--")) {
    configPath = args[i];
  }
}

if (showHelp) {
  printUsage();
  process.exit(0);
}

if (discoverMode) {
  runDiscovery(configPath);
} else if (port) {
  // ── HTTP daemon mode ──
  // Start the gateway, connect to all upstream MCP servers,
  // then serve the same 6 gateway tools over HTTP.
  startDaemon(configPath, port);
} else {
  // ── Stdio mode (original behavior) ──
  startStdio(configPath);
}

function startStdio(configPath?: string): void {
  const gateway = new MCPGateway(configPath);

  process.on("SIGINT", () => {
    gateway.shutdown().then(() => process.exit(0));
  });

  process.on("SIGTERM", () => {
    gateway.shutdown().then(() => process.exit(0));
  });

  process.on("uncaughtException", (err) => {
    console.error(`  [proxy] Uncaught exception: ${err.message}`);
  });

  process.on("unhandledRejection", (reason) => {
    console.error(`  [proxy] Unhandled rejection: ${reason}`);
  });

  gateway.startWithStdio().catch((err) => {
    console.error(`  [proxy] Fatal error: ${err.message}`);
    process.exit(1);
  });
}

async function startDaemon(configPath?: string, daemonPort?: number): Promise<void> {
  const gateway = new MCPGateway(configPath);

  // Connect to all upstream MCP servers first
  console.error("  [daemon] Starting in HTTP daemon mode...");
  await gateway.connectAll();

  // Create HTTP server sharing the same services
  const services = gateway.getSharedServices();
  const httpServer = new HttpMcpServer(
    services.searchEngine,
    services.connections,
    services.jobManager,
    services.responseStore,
    services.responseShield,
    services.projectRegistry,
    services.statusHolder as any,
    daemonPort,
  );

  // Register signal handlers now that httpServer is defined
  process.on("SIGINT", async () => {
    await httpServer.shutdown();
    await gateway.shutdown();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await httpServer.shutdown();
    await gateway.shutdown();
    process.exit(0);
  });

  process.on("uncaughtException", (err) => {
    console.error(`  [proxy] Uncaught exception: ${err.message}`);
  });

  process.on("unhandledRejection", (reason) => {
    console.error(`  [proxy] Unhandled rejection: ${reason}`);
  });

  // Start the HTTP server
  await httpServer.start();
  console.error(`  [daemon] harshal-mcp-proxy daemon ready on port ${daemonPort}`);
}

async function runDiscovery(configPath?: string): Promise<void> {
  const gateway = new MCPGateway(configPath);
  console.error("  [discover] Running catalog discovery...");
  await gateway.connectAll(true); // force-connect all servers to build snapshots
  // Give a moment for snapshots to be written
  await new Promise((r) => setTimeout(r, 500));
  await gateway.shutdown();
  console.error("  [discover] Catalog snapshots saved. Exiting.");
  process.exit(0);
}

// Also expose classes for programmatic usage
export { MCPGateway, HttpMcpServer };
