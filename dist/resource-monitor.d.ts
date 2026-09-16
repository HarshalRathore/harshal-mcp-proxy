/**
 * resource-monitor.ts — PID tracking + RAM measurement for upstream servers.
 *
 * Reads live memory for a server's child process:
 *   Linux: /proc/<pid>/status (fast, no subprocess)
 *   macOS / other: ps -p <pid> -o rss= (fallback)
 *
 * PIDs come from StdioClientTransport.pid after connect — no process
 * tree scanning needed.
 */
export declare class ResourceMonitor {
    private pids;
    /** Record the PID for a server's stdio child process */
    setPid(serverKey: string, pid: number): void;
    /** Forget a server's PID (disconnect or removal) */
    clearPid(serverKey: string): void;
    /** Current RAM usage in MB for a server, or null when unknown */
    getRamMb(serverKey: string): number | null;
}
