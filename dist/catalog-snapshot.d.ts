/**
 * catalog-snapshot.ts — Persist tool catalog snapshots to disk.
 *
 * When a server is lazy-loaded, we need its tool catalog available
 * for search/describe even when the process is not running.
 * Snapshots are saved after first discovery and loaded on startup.
 */
import type { ToolCatalogEntry } from "./types.js";
export interface SnapshotData {
    serverKey: string;
    discoveredAt: string;
    tools: Array<{
        id: string;
        server: string;
        name: string;
        title?: string;
        description?: string;
        inputSchema?: unknown;
        outputSchema?: unknown;
    }>;
}
export declare class CatalogSnapshotManager {
    private snapshotDir;
    constructor(snapshotDir?: string);
    private snapshotPath;
    hasSnapshot(serverKey: string): boolean;
    loadSnapshot(serverKey: string): ToolCatalogEntry[] | null;
    saveSnapshot(serverKey: string, tools: ToolCatalogEntry[]): void;
    removeSnapshot(serverKey: string): void;
    listSnapshots(): string[];
}
