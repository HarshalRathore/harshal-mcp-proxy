#!/usr/bin/env node

/**
 * index.ts — Entry point for harshal-mcp-proxy.
 *
 * Usage:
 *   node dist/index.js [path-to-config.json]              (stdio mode, default)
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
 *   transport. Multiple clients can connect via:
 *     - pi:     url in .vscode/mcp.json or pi-mcp-adapter config
 *     - VS Code: "type": "streamableHttp", "url": "http://localhost:PORT/mcp"
 *   Only ONE process spawns all upstream MCP servers, eliminating duplicate
 *   npm exec processes across sessions.
 */

import { MCPGateway } from "./gateway.js";
import { HttpMcpServer } from "./http-server.js";
import { errorMessage } from "./util.js";

interface CliOptions {
  configPath?: string;
  port?: number;
  discover: boolean;
  help: boolean;
}

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

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { discover: false, help: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") {
      const port = Number(argv[++i]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        console.error(`  [proxy] Invalid --port value. Expected 1-65535.`);
        process.exit(1);
      }
      options.port = port;
    } else if (arg === "--daemon") {
      options.port = 8765;
    } else if (arg === "--discover") {
      options.discover = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (!arg.startsWith("--")) {
      options.configPath = arg;
    }
  }

  return options;
}

/** Wire signals and stray errors to a graceful shutdown. */
function installProcessHandlers(shutdown: () => Promise<void>): void {
  const onSignal = (signal: NodeJS.Signals) => {
    console.error(`\n  [proxy] ${signal} received, shutting down...`);
    void shutdown().then(() => process.exit(0));
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("uncaughtException", (err) => {
    console.error(`  [proxy] Uncaught exception: ${errorMessage(err)}`);
  });
  process.on("unhandledRejection", (reason) => {
    console.error(`  [proxy] Unhandled rejection: ${errorMessage(reason)}`);
  });
}

function startStdio(configPath?: string): void {
  const gateway = new MCPGateway(configPath);
  installProcessHandlers(() => gateway.shutdown());

  gateway.startWithStdio().catch((err) => {
    console.error(`  [proxy] Fatal error: ${errorMessage(err)}`);
    process.exit(1);
  });
}

async function startDaemon(configPath: string | undefined, port: number): Promise<void> {
  const gateway = new MCPGateway(configPath);

  // Connect to all upstream MCP servers first
  console.error("  [daemon] Starting in HTTP daemon mode...");
  await gateway.connectAll();

  // Serve the same gateway over HTTP — all clients share one upstream fleet
  const httpServer = new HttpMcpServer(gateway.getSharedServices(), port);
  installProcessHandlers(async () => {
    await httpServer.shutdown();
    await gateway.shutdown();
  });

  await httpServer.start();
  console.error(`  [daemon] harshal-mcp-proxy daemon ready on port ${port}`);
}

async function runDiscovery(configPath?: string): Promise<void> {
  const gateway = new MCPGateway(configPath);
  console.error("  [discover] Running catalog discovery...");
  await gateway.connectAll(true); // force-connect all servers to build snapshots
  // Give a moment for snapshots to be written
  await new Promise((resolve) => setTimeout(resolve, 500));
  await gateway.shutdown();
  console.error("  [discover] Catalog snapshots saved. Exiting.");
  process.exit(0);
}

const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printUsage();
  process.exit(0);
}

if (options.discover) {
  void runDiscovery(options.configPath);
} else if (options.port !== undefined) {
  void startDaemon(options.configPath, options.port);
} else {
  startStdio(options.configPath);
}

// Also expose classes for programmatic usage
export { MCPGateway, HttpMcpServer };
