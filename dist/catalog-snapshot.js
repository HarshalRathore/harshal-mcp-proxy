/**
 * catalog-snapshot.ts — Persist tool catalog snapshots to disk.
 *
 * When a server is lazy-loaded, we need its tool catalog available
 * for search/describe even when the process is not running.
 * Snapshots are saved after first discovery and loaded on startup.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
const DEFAULT_SNAPSHOT_DIR = join(homedir(), ".cache", "harshal-mcp-proxy", "catalogs");
export class CatalogSnapshotManager {
    snapshotDir;
    constructor(snapshotDir) {
        this.snapshotDir = snapshotDir || DEFAULT_SNAPSHOT_DIR;
        if (!existsSync(this.snapshotDir)) {
            mkdirSync(this.snapshotDir, { recursive: true });
        }
    }
    snapshotPath(serverKey) {
        return join(this.snapshotDir, `${serverKey}.json`);
    }
    hasSnapshot(serverKey) {
        return existsSync(this.snapshotPath(serverKey));
    }
    loadSnapshot(serverKey) {
        const path = this.snapshotPath(serverKey);
        if (!existsSync(path))
            return null;
        try {
            const raw = readFileSync(path, "utf-8");
            const data = JSON.parse(raw);
            return data.tools.map((t) => ({
                id: t.id,
                server: t.server,
                name: t.name,
                title: t.title,
                description: t.description,
                inputSchema: t.inputSchema,
                outputSchema: t.outputSchema,
            }));
        }
        catch (err) {
            console.error(`  [snapshot] Failed to load ${serverKey}: ${err.message}`);
            return null;
        }
    }
    saveSnapshot(serverKey, tools) {
        const data = {
            serverKey,
            discoveredAt: new Date().toISOString(),
            tools: tools.map((t) => ({
                id: t.id,
                server: t.server,
                name: t.name,
                title: t.title,
                description: t.description,
                inputSchema: t.inputSchema,
                outputSchema: t.outputSchema,
            })),
        };
        try {
            writeFileSync(this.snapshotPath(serverKey), JSON.stringify(data, null, 2), "utf-8");
            console.error(`  [snapshot] Saved ${tools.length} tools for ${serverKey}`);
        }
        catch (err) {
            console.error(`  [snapshot] Failed to save ${serverKey}: ${err.message}`);
        }
    }
    removeSnapshot(serverKey) {
        const path = this.snapshotPath(serverKey);
        if (existsSync(path)) {
            try {
                unlinkSync(path);
            }
            catch {
                // ignore
            }
        }
    }
    listSnapshots() {
        try {
            return readdirSync(this.snapshotDir)
                .filter((f) => f.endsWith(".json"))
                .map((f) => f.replace(/\.json$/, ""));
        }
        catch {
            return [];
        }
    }
}
//# sourceMappingURL=catalog-snapshot.js.map