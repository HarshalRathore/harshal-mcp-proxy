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
import { readFileSync, existsSync, watch, mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";
/** Default config location following XDG conventions */
const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "harshal-mcp-proxy", "config.json");
export class Config {
    config;
    configPath;
    watcher;
    constructor(path) {
        this.configPath = path || process.env.MCP_GATEWAY_CONFIG || DEFAULT_CONFIG_PATH;
        this.config = this.load();
    }
    /** Get a single server config by key */
    get(key) {
        return this.config[key];
    }
    /** Get the full config (shallow copy) */
    getAll() {
        return { ...this.config };
    }
    /** Get the resolved config file path */
    getPath() {
        return this.configPath;
    }
    /** Force reload from disk */
    reload() {
        this.config = this.load();
        return this.config;
    }
    /**
     * Watch the config file for changes.
     * Callback receives (oldConfig, newConfig) so the gateway can diff and reconnect.
     */
    watch(callback) {
        if (this.watcher)
            return;
        try {
            this.watcher = watch(this.configPath, (event) => {
                if (event !== "change")
                    return;
                const oldConfig = this.getAll();
                this.reload();
                callback(oldConfig, this.config);
            });
            console.error(`  [config] Watching: ${this.configPath}`);
        }
        catch {
            // File might not exist yet — that's fine
            console.error(`  [config] Could not watch: ${this.configPath}`);
        }
    }
    /** Stop watching the config file */
    stopWatching() {
        this.watcher?.close();
        this.watcher = undefined;
    }
    /**
     * Ensure the config file exists. If not, create it with the provided defaults.
     * Used at first run to bootstrap the config directory.
     */
    static ensureConfigFile(path, defaults) {
        if (existsSync(path))
            return;
        const dir = dirname(path);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path, JSON.stringify(defaults, null, 2), "utf-8");
        console.error(`  [config] Created default config at: ${path}`);
    }
    /** Load and parse the config file. Returns empty config if file doesn't exist. */
    load() {
        if (!existsSync(this.configPath)) {
            console.error(`  [config] No config file at ${this.configPath}, using empty config`);
            return {};
        }
        try {
            const raw = readFileSync(this.configPath, "utf-8");
            const parsed = JSON.parse(raw);
            console.error(`  [config] Loaded ${Object.keys(parsed).length} server(s) from ${this.configPath}`);
            return parsed;
        }
        catch (err) {
            console.error(`  [config] Failed to parse ${this.configPath}:`, err.message);
            return {};
        }
    }
}
export function getDefaultConfigPath() {
    return process.env.MCP_GATEWAY_CONFIG || DEFAULT_CONFIG_PATH;
}
//# sourceMappingURL=config.js.map