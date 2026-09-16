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
import { readFileSync, existsSync, watch } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { errorMessage, isPlainObject } from "./util.js";
/** Config for a single upstream MCP server. Mirrors opencode.json MCP blocks. */
const UpstreamConfigSchema = z
    .object({
    /** "local" = stdio subprocess, "remote" = HTTP/WebSocket */
    type: z.enum(["local", "remote"]),
    command: z.array(z.string()).optional(),
    url: z.string().optional(),
    transport: z.enum(["streamable_http", "websocket"]).optional(),
    environment: z.record(z.string()).optional(),
    enabled: z.boolean().optional(),
    lazy: z
        .object({
        enabled: z.boolean().optional(),
        idleTimeoutMs: z.number().optional(),
        maxRamMb: z.number().optional(),
        maxUptimeMs: z.number().optional(),
        connectionTimeoutMs: z.number().optional(),
        prewarm: z.boolean().optional(),
    })
        .passthrough()
        .optional(),
})
    .passthrough()
    .superRefine((cfg, ctx) => {
    if (cfg.type === "local" && !cfg.command?.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `type "local" requires a non-empty command array` });
    }
    if (cfg.type === "remote" && !cfg.url) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `type "remote" requires a url` });
    }
});
const CodeGraphConfigSchema = z
    .object({
    projects: z.array(z.object({ name: z.string(), path: z.string() })).optional(),
    defaultProject: z.string().optional(),
})
    .passthrough();
/** Default config location following XDG conventions */
const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "harshal-mcp-proxy", "config.json");
export class Config {
    servers;
    codegraph;
    configPath;
    watcher;
    constructor(path) {
        this.configPath = path || process.env.MCP_GATEWAY_CONFIG || DEFAULT_CONFIG_PATH;
        const loaded = this.load() ?? { servers: {}, codegraph: {} };
        this.servers = loaded.servers;
        this.codegraph = loaded.codegraph;
    }
    /**
     * Get the full validated server map (shallow copy).
     * Reserved keys ("_note" etc.) and malformed entries are already excluded.
     */
    getServers() {
        return { ...this.servers };
    }
    /** Get the codegraph project section (may be empty). */
    getCodegraph() {
        return this.codegraph;
    }
    /** Get the resolved config file path */
    getPath() {
        return this.configPath;
    }
    /**
     * Watch the config for changes. Callback receives (oldServers, newServers)
     * so the gateway can diff and reconnect. A failed reload (file mid-save,
     * broken JSON) keeps the previous config and does not fire the callback.
     */
    watch(callback) {
        if (this.watcher)
            return;
        const dir = dirname(this.configPath);
        const file = basename(this.configPath);
        if (!existsSync(dir)) {
            console.error(`  [config] Could not watch: ${dir} does not exist`);
            return;
        }
        try {
            this.watcher = watch(dir, (_event, filename) => {
                // filename is null on some platforms — reload anyway in that case
                if (filename && filename !== file)
                    return;
                const oldConfig = this.servers;
                const loaded = this.load();
                if (!loaded)
                    return;
                this.servers = loaded.servers;
                this.codegraph = loaded.codegraph;
                callback(oldConfig, this.servers);
            });
            console.error(`  [config] Watching: ${this.configPath}`);
        }
        catch {
            console.error(`  [config] Could not watch: ${this.configPath}`);
        }
    }
    /** Stop watching the config file */
    stopWatching() {
        this.watcher?.close();
        this.watcher = undefined;
    }
    /**
     * Load and validate the config file.
     * Returns null when the file is missing/mid-save/broken, in which case
     * callers keep whatever config they already had.
     */
    load() {
        if (!existsSync(this.configPath)) {
            console.error(`  [config] No config file at ${this.configPath}, using empty config`);
            return { servers: {}, codegraph: {} };
        }
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(this.configPath, "utf-8"));
        }
        catch (err) {
            console.error(`  [config] Failed to parse ${this.configPath}: ${errorMessage(err)}`);
            return null;
        }
        if (!isPlainObject(parsed)) {
            console.error(`  [config] ${this.configPath} must contain a JSON object`);
            return null;
        }
        const servers = {};
        for (const [key, value] of Object.entries(parsed)) {
            if (key.startsWith("_"))
                continue; // metadata (e.g. "_note"), not a server
            // The "codegraph" section doubles as project metadata — only treat it
            // as a server entry when it actually declares one.
            const declaredType = isPlainObject(value) ? value["type"] : undefined;
            if (declaredType === undefined) {
                if (key !== "codegraph") {
                    console.error(`  [config] Skipping "${key}": not a server entry (missing "type")`);
                }
                continue;
            }
            const result = UpstreamConfigSchema.safeParse(value);
            if (!result.success) {
                const detail = result.error.issues
                    .map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`)
                    .join("; ");
                console.error(`  [config] Skipping "${key}": ${detail}`);
                continue;
            }
            servers[key] = result.data;
        }
        const codegraph = CodeGraphConfigSchema.safeParse(parsed["codegraph"] ?? {});
        console.error(`  [config] Loaded ${Object.keys(servers).length} server(s) from ${this.configPath}`);
        return { servers, codegraph: codegraph.success ? codegraph.data : {} };
    }
}
//# sourceMappingURL=config.js.map