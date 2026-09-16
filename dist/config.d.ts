/**
 * config.ts — Configuration loader, validation, and file watching.
 *
 * Reads the gateway config from:
 *   1. CLI arg (process.argv[2])
 *   2. MCP_GATEWAY_CONFIG env var
 *   3. ~/.config/harshal-mcp-proxy/config.json (default)
 *
 * Every top-level key is a server entry except keys starting with "_"
 * (metadata like "_note"). Entries are validated once at load time —
 * a malformed entry is skipped with a warning instead of being retried
 * at connect time. The "codegraph" section doubles as a server entry
 * and as project metadata.
 *
 * Supports {env:VAR_NAME} substitution in environment fields.
 * Watches the config directory so editor atomic saves (write temp +
 * rename) are picked up, and keeps the previous config when a save is
 * caught mid-write instead of dropping every server.
 */
import { z } from "zod";
import type { CodeGraphProject } from "./types.js";
/** Config for a single upstream MCP server. Mirrors opencode.json MCP blocks. */
declare const UpstreamConfigSchema: z.ZodEffects<z.ZodObject<{
    /** "local" = stdio subprocess, "remote" = HTTP/WebSocket */
    type: z.ZodEnum<["local", "remote"]>;
    command: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    url: z.ZodOptional<z.ZodString>;
    transport: z.ZodOptional<z.ZodEnum<["streamable_http", "websocket"]>>;
    environment: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    lazy: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        idleTimeoutMs: z.ZodOptional<z.ZodNumber>;
        maxRamMb: z.ZodOptional<z.ZodNumber>;
        maxUptimeMs: z.ZodOptional<z.ZodNumber>;
        connectionTimeoutMs: z.ZodOptional<z.ZodNumber>;
        prewarm: z.ZodOptional<z.ZodBoolean>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        idleTimeoutMs: z.ZodOptional<z.ZodNumber>;
        maxRamMb: z.ZodOptional<z.ZodNumber>;
        maxUptimeMs: z.ZodOptional<z.ZodNumber>;
        connectionTimeoutMs: z.ZodOptional<z.ZodNumber>;
        prewarm: z.ZodOptional<z.ZodBoolean>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        idleTimeoutMs: z.ZodOptional<z.ZodNumber>;
        maxRamMb: z.ZodOptional<z.ZodNumber>;
        maxUptimeMs: z.ZodOptional<z.ZodNumber>;
        connectionTimeoutMs: z.ZodOptional<z.ZodNumber>;
        prewarm: z.ZodOptional<z.ZodBoolean>;
    }, z.ZodTypeAny, "passthrough">>>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    /** "local" = stdio subprocess, "remote" = HTTP/WebSocket */
    type: z.ZodEnum<["local", "remote"]>;
    command: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    url: z.ZodOptional<z.ZodString>;
    transport: z.ZodOptional<z.ZodEnum<["streamable_http", "websocket"]>>;
    environment: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    lazy: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        idleTimeoutMs: z.ZodOptional<z.ZodNumber>;
        maxRamMb: z.ZodOptional<z.ZodNumber>;
        maxUptimeMs: z.ZodOptional<z.ZodNumber>;
        connectionTimeoutMs: z.ZodOptional<z.ZodNumber>;
        prewarm: z.ZodOptional<z.ZodBoolean>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        idleTimeoutMs: z.ZodOptional<z.ZodNumber>;
        maxRamMb: z.ZodOptional<z.ZodNumber>;
        maxUptimeMs: z.ZodOptional<z.ZodNumber>;
        connectionTimeoutMs: z.ZodOptional<z.ZodNumber>;
        prewarm: z.ZodOptional<z.ZodBoolean>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        idleTimeoutMs: z.ZodOptional<z.ZodNumber>;
        maxRamMb: z.ZodOptional<z.ZodNumber>;
        maxUptimeMs: z.ZodOptional<z.ZodNumber>;
        connectionTimeoutMs: z.ZodOptional<z.ZodNumber>;
        prewarm: z.ZodOptional<z.ZodBoolean>;
    }, z.ZodTypeAny, "passthrough">>>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    /** "local" = stdio subprocess, "remote" = HTTP/WebSocket */
    type: z.ZodEnum<["local", "remote"]>;
    command: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    url: z.ZodOptional<z.ZodString>;
    transport: z.ZodOptional<z.ZodEnum<["streamable_http", "websocket"]>>;
    environment: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    lazy: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        idleTimeoutMs: z.ZodOptional<z.ZodNumber>;
        maxRamMb: z.ZodOptional<z.ZodNumber>;
        maxUptimeMs: z.ZodOptional<z.ZodNumber>;
        connectionTimeoutMs: z.ZodOptional<z.ZodNumber>;
        prewarm: z.ZodOptional<z.ZodBoolean>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        idleTimeoutMs: z.ZodOptional<z.ZodNumber>;
        maxRamMb: z.ZodOptional<z.ZodNumber>;
        maxUptimeMs: z.ZodOptional<z.ZodNumber>;
        connectionTimeoutMs: z.ZodOptional<z.ZodNumber>;
        prewarm: z.ZodOptional<z.ZodBoolean>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        idleTimeoutMs: z.ZodOptional<z.ZodNumber>;
        maxRamMb: z.ZodOptional<z.ZodNumber>;
        maxUptimeMs: z.ZodOptional<z.ZodNumber>;
        connectionTimeoutMs: z.ZodOptional<z.ZodNumber>;
        prewarm: z.ZodOptional<z.ZodBoolean>;
    }, z.ZodTypeAny, "passthrough">>>;
}, z.ZodTypeAny, "passthrough">>, z.objectOutputType<{
    /** "local" = stdio subprocess, "remote" = HTTP/WebSocket */
    type: z.ZodEnum<["local", "remote"]>;
    command: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    url: z.ZodOptional<z.ZodString>;
    transport: z.ZodOptional<z.ZodEnum<["streamable_http", "websocket"]>>;
    environment: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    lazy: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        idleTimeoutMs: z.ZodOptional<z.ZodNumber>;
        maxRamMb: z.ZodOptional<z.ZodNumber>;
        maxUptimeMs: z.ZodOptional<z.ZodNumber>;
        connectionTimeoutMs: z.ZodOptional<z.ZodNumber>;
        prewarm: z.ZodOptional<z.ZodBoolean>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        idleTimeoutMs: z.ZodOptional<z.ZodNumber>;
        maxRamMb: z.ZodOptional<z.ZodNumber>;
        maxUptimeMs: z.ZodOptional<z.ZodNumber>;
        connectionTimeoutMs: z.ZodOptional<z.ZodNumber>;
        prewarm: z.ZodOptional<z.ZodBoolean>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        idleTimeoutMs: z.ZodOptional<z.ZodNumber>;
        maxRamMb: z.ZodOptional<z.ZodNumber>;
        maxUptimeMs: z.ZodOptional<z.ZodNumber>;
        connectionTimeoutMs: z.ZodOptional<z.ZodNumber>;
        prewarm: z.ZodOptional<z.ZodBoolean>;
    }, z.ZodTypeAny, "passthrough">>>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    /** "local" = stdio subprocess, "remote" = HTTP/WebSocket */
    type: z.ZodEnum<["local", "remote"]>;
    command: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    url: z.ZodOptional<z.ZodString>;
    transport: z.ZodOptional<z.ZodEnum<["streamable_http", "websocket"]>>;
    environment: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    enabled: z.ZodOptional<z.ZodBoolean>;
    lazy: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        idleTimeoutMs: z.ZodOptional<z.ZodNumber>;
        maxRamMb: z.ZodOptional<z.ZodNumber>;
        maxUptimeMs: z.ZodOptional<z.ZodNumber>;
        connectionTimeoutMs: z.ZodOptional<z.ZodNumber>;
        prewarm: z.ZodOptional<z.ZodBoolean>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        idleTimeoutMs: z.ZodOptional<z.ZodNumber>;
        maxRamMb: z.ZodOptional<z.ZodNumber>;
        maxUptimeMs: z.ZodOptional<z.ZodNumber>;
        connectionTimeoutMs: z.ZodOptional<z.ZodNumber>;
        prewarm: z.ZodOptional<z.ZodBoolean>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        enabled: z.ZodOptional<z.ZodBoolean>;
        idleTimeoutMs: z.ZodOptional<z.ZodNumber>;
        maxRamMb: z.ZodOptional<z.ZodNumber>;
        maxUptimeMs: z.ZodOptional<z.ZodNumber>;
        connectionTimeoutMs: z.ZodOptional<z.ZodNumber>;
        prewarm: z.ZodOptional<z.ZodBoolean>;
    }, z.ZodTypeAny, "passthrough">>>;
}, z.ZodTypeAny, "passthrough">>;
export type UpstreamConfig = z.infer<typeof UpstreamConfigSchema>;
export type LazyConfig = NonNullable<UpstreamConfig["lazy"]>;
export type GatewayConfig = Record<string, UpstreamConfig>;
export interface CodeGraphConfig {
    projects?: CodeGraphProject[];
    defaultProject?: string;
}
export declare class Config {
    private servers;
    private codegraph;
    private configPath;
    private watcher?;
    constructor(path?: string);
    /**
     * Get the full validated server map (shallow copy).
     * Reserved keys ("_note" etc.) and malformed entries are already excluded.
     */
    getServers(): GatewayConfig;
    /** Get the codegraph project section (may be empty). */
    getCodegraph(): CodeGraphConfig;
    /** Get the resolved config file path */
    getPath(): string;
    /**
     * Watch the config for changes. Callback receives (oldServers, newServers)
     * so the gateway can diff and reconnect. A failed reload (file mid-save,
     * broken JSON) keeps the previous config and does not fire the callback.
     */
    watch(callback: (oldConfig: GatewayConfig, newConfig: GatewayConfig) => void): void;
    /** Stop watching the config file */
    stopWatching(): void;
    /**
     * Load and validate the config file.
     * Returns null when the file is missing/mid-save/broken, in which case
     * callers keep whatever config they already had.
     */
    private load;
}
export {};
