/**
 * config.ts — Configuration loader with file watching.
 *
 * Reads the gateway config from:
 *   1. CLI arg (process.argv[2])
 *   2. MCP_GATEWAY_CONFIG env var
 *   3. ~/.config/harshal-mcp-proxy/config.json (default)
 *
 * Supports {env:VAR_NAME} substitution in environment fields.
 * Watches the config file for changes and fires a callback on reload.
 */
import type { GatewayConfig } from "./types.js";
export declare class Config {
    private config;
    private configPath;
    private watcher?;
    constructor(path?: string);
    /** Get a single server config by key */
    get(key: string): GatewayConfig[string] | undefined;
    /** Get the full config (shallow copy) */
    getAll(): GatewayConfig;
    /** Get the resolved config file path */
    getPath(): string;
    /** Force reload from disk */
    reload(): GatewayConfig;
    /**
     * Watch the config file for changes.
     * Callback receives (oldConfig, newConfig) so the gateway can diff and reconnect.
     */
    watch(callback: (oldConfig: GatewayConfig, newConfig: GatewayConfig) => void): void;
    /** Stop watching the config file */
    stopWatching(): void;
    /**
     * Ensure the config file exists. If not, create it with the provided defaults.
     * Used at first run to bootstrap the config directory.
     */
    static ensureConfigFile(path: string, defaults: GatewayConfig): void;
    /** Load and parse the config file. Returns empty config if file doesn't exist. */
    private load;
}
export declare function getDefaultConfigPath(): string;
