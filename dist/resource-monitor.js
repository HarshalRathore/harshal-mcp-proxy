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
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
export class ResourceMonitor {
    pids = new Map();
    /** Record the PID for a server's stdio child process */
    setPid(serverKey, pid) {
        this.pids.set(serverKey, pid);
    }
    /** Forget a server's PID (disconnect or removal) */
    clearPid(serverKey) {
        this.pids.delete(serverKey);
    }
    /** Current RAM usage in MB for a server, or null when unknown */
    getRamMb(serverKey) {
        const pid = this.pids.get(serverKey);
        return pid === undefined ? null : readRamMb(pid);
    }
}
/** Try Linux /proc first, then the ps fallback. */
function readRamMb(pid) {
    try {
        const status = readFileSync(`/proc/${pid}/status`, "utf-8");
        const match = /VmRSS:\s+(\d+)\s+kB/.exec(status);
        if (match)
            return Number(match[1]) / 1024; // kB → MB
    }
    catch {
        // Not Linux or no permission — fall through to ps
    }
    try {
        const output = execFileSync("ps", ["-p", String(pid), "-o", "rss="], {
            encoding: "utf-8",
            timeout: 1000,
        }).trim();
        const rssKb = Number(output);
        return Number.isNaN(rssKb) ? null : rssKb / 1024;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=resource-monitor.js.map