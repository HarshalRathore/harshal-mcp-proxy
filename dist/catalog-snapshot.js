/**
 * catalog-snapshot.ts — Persist tool catalog snapshots to disk.
 *
 * When a server is lazy-loaded, we need its tool catalog available
 * for search/describe even when the process is not running.
 * Snapshots are saved after first discovery and loaded on startup.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { errorMessage, isPlainObject } from "./util.js";
const DEFAULT_SNAPSHOT_DIR = join(homedir(), ".cache", "harshal-mcp-proxy", "catalogs");
export class CatalogSnapshotManager {
    snapshotDir;
    constructor(snapshotDir) {
        this.snapshotDir = snapshotDir || DEFAULT_SNAPSHOT_DIR;
        mkdirSync(this.snapshotDir, { recursive: true });
    }
    snapshotPath(serverKey) {
        return join(this.snapshotDir, `${serverKey}.json`);
    }
    loadSnapshot(serverKey) {
        const path = this.snapshotPath(serverKey);
        if (!existsSync(path))
            return null;
        try {
            const data = JSON.parse(readFileSync(path, "utf-8"));
            const tools = isPlainObject(data) ? data["tools"] : undefined;
            if (!Array.isArray(tools)) {
                throw new Error("malformed snapshot: tools is not an array");
            }
            return tools.filter(isCatalogEntry);
        }
        catch (err) {
            console.error(`  [snapshot] Failed to load ${serverKey}: ${errorMessage(err)}`);
            return null;
        }
    }
    saveSnapshot(serverKey, tools) {
        const data = {
            serverKey,
            discoveredAt: new Date().toISOString(),
            tools,
        };
        try {
            writeFileSync(this.snapshotPath(serverKey), JSON.stringify(data, null, 2), "utf-8");
            console.error(`  [snapshot] Saved ${tools.length} tools for ${serverKey}`);
        }
        catch (err) {
            console.error(`  [snapshot] Failed to save ${serverKey}: ${errorMessage(err)}`);
        }
    }
    removeSnapshot(serverKey) {
        try {
            unlinkSync(this.snapshotPath(serverKey));
        }
        catch {
            // No snapshot on disk — nothing to do
        }
    }
}
/** Minimal shape check for entries read back from disk. */
function isCatalogEntry(value) {
    return (isPlainObject(value) &&
        typeof value["id"] === "string" &&
        typeof value["server"] === "string" &&
        typeof value["name"] === "string");
}
//# sourceMappingURL=catalog-snapshot.js.map