/**
 * resource-monitor.ts — Poll child process resources for lazy-loaded MCP servers.
 *
 * Uses platform-specific methods to find child PIDs and measure RAM:
 *   Linux: /proc/<pid>/status (fast, no subprocess)
 *   macOS: ps -p <pid> -o rss= (fallback)
 *   Other: ps --ppid <ppid> (process tree scan)
 */
import type { UpstreamConfig } from "./types.js";
export interface ResourceUsage {
    ramMb: number | null;
    cpuPercent: number | null;
}
export interface ResourceLimit {
    serverKey: string;
    maxRamMb: number;
    maxUptimeMs: number;
    idleTimeoutMs: number;
}
export declare class ResourceMonitor {
    private intervalId?;
    private limits;
    private pids;
    /** Register a server for monitoring */
    register(serverKey: string, config: UpstreamConfig): void;
    /** Unregister a server from monitoring */
    unregister(serverKey: string): void;
    /** Record the PID for a stdio server process */
    setPid(serverKey: string, pid: number): void;
    /** Clear the PID (e.g., on disconnect) */
    clearPid(serverKey: string): void;
    /** Start periodic monitoring */
    startMonitoring(intervalMs: number, onLimitExceeded: (serverKey: string, usage: ResourceUsage, reason: string) => void): void;
    /** Stop periodic monitoring */
    stopMonitoring(): void;
    /** Get current resource usage for a PID */
    getUsage(pid: number): ResourceUsage;
    /** Try Linux /proc first, then ps fallback */
    private getProcessRamMB;
    /**
     * Find child PIDs spawned by this Node.js process.
     * Used to auto-discover stdio child process PIDs.
     */
    findChildPids(parentPid: number): Array<{
        pid: number;
        cmd: string;
    }>;
    /** Match a child PID by command pattern (for stdio servers) */
    findPidByCommand(pattern: string, parentPid?: number): number | undefined;
}
